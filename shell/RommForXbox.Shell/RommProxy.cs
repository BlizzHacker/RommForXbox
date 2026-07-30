using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using Windows.Storage;
using Windows.Storage.Streams;

namespace RommForXbox.Shell
{
    /// <summary>
    /// Makes a customer's own RomM usable from the packaged app.
    ///
    /// RomM's FastAPI layer sets CORS headers, but ROM downloads leave through
    /// nginx via X-Accel-Redirect and /assets is served by nginx directly, so
    /// neither response carries one. The preflight succeeds and the real response
    /// does not, which the page sees as an unexplained failure. Native code is not
    /// subject to CORS, so requests that need it are refetched here and returned
    /// with the header attached.
    ///
    /// Only fetch/XHR are intercepted. Images and scripts are not CORS-checked, so
    /// cover art and EmulatorJS's loader are left alone — which matters, because
    /// proxying every request would put the whole library through this path.
    /// </summary>
    internal sealed class RommProxy
    {
        // Above this, buffering in memory is a bad idea: a CD-era ROM can be
        // hundreds of megabytes and a UWP app on Xbox has a modest memory budget.
        private const long SpillToDiskBytes = 16L * 1024 * 1024;

        private static readonly HttpClient Http = CreateClient();
        private readonly string _virtualHost;

        public RommProxy(string virtualHost)
        {
            _virtualHost = virtualHost;
        }

        // How long to wait for a server to start answering. Reaching the headers is
        // either fast or never: a wrong address, a console on another subnet or a
        // stopped server all fail by silence, and a long wait there is
        // indistinguishable from the app being frozen.
        private static readonly TimeSpan HeaderTimeout = TimeSpan.FromSeconds(12);

        private static HttpClient CreateClient()
        {
            var handler = new HttpClientHandler { AllowAutoRedirect = true };
            var c = new HttpClient(handler);
            // No client-wide timeout. It would have to be long enough for a
            // several-hundred-megabyte ROM, and a single number cannot be both that
            // and short enough to fail a bad address quickly — 30 minutes here made
            // a mistyped server look like a hung app. Timing is per phase below.
            c.Timeout = Timeout.InfiniteTimeSpan;
            return c;
        }

        public async void OnWebResourceRequested(
            CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
        {
            var target = TargetFor(args);
            if (target == null) return;

            var deferral = args.GetDeferral();
            try
            {
                args.Response = await BuildResponse(sender, args, target);
            }
            catch (Exception ex)
            {
                args.Response = Error(sender, "proxy failed: " + ex.Message);
            }
            finally
            {
                deferral.Complete();
            }
        }

        /// <summary>
        /// The real URL this request should be served from, or null to let
        /// WebView2 handle it normally.
        /// </summary>
        private string TargetFor(CoreWebView2WebResourceRequestedEventArgs args)
        {
            // A routed request is served natively whatever kind it is: covers are
            // images and EmulatorJS is a script, and both come from the same
            // possibly-http server as the API.
            var routed = RoutedUrl.Unwrap(args.Request.Uri, _virtualHost);
            if (routed != null) return routed;

            // A direct cross-origin fetch still needs the CORS header RomM omits.
            // Images and scripts are not CORS-checked, so they are left alone.
            if (args.ResourceContext != CoreWebView2WebResourceContext.Fetch &&
                args.ResourceContext != CoreWebView2WebResourceContext.XmlHttpRequest)
            {
                return null;
            }

            Uri uri;
            if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out uri)) return null;
            if (uri.Host.Equals(_virtualHost, StringComparison.OrdinalIgnoreCase)) return null;
            if (uri.Scheme != "http" && uri.Scheme != "https") return null;
            return args.Request.Uri;
        }

        private async Task<CoreWebView2WebResourceResponse> BuildResponse(
            CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args,
            string target)
        {
            var req = args.Request;

            // Answer the preflight ourselves. Forwarding it would just return the
            // permissive headers RomM already sends, at the cost of a round trip.
            if (string.Equals(req.Method, "OPTIONS", StringComparison.OrdinalIgnoreCase))
            {
                return sender.Environment.CreateWebResourceResponse(
                    null, 204, "No Content", CorsHeaders(null));
            }

            using (var outbound = new HttpRequestMessage(new HttpMethod(req.Method), target))
            {
                if (req.Content != null && !IsBodyless(req.Method))
                {
                    // Request.Content is a WinRT IRandomAccessStream, not a
                    // System.IO.Stream — AsStreamForRead bridges the two.
                    var buffer = new MemoryStream();
                    using (var inbound = req.Content.AsStreamForRead())
                    {
                        await inbound.CopyToAsync(buffer);
                    }
                    buffer.Position = 0;
                    outbound.Content = new StreamContent(buffer);
                }

                foreach (var h in req.Headers)
                {
                    if (IsHopByHop(h.Key)) continue;
                    if (!outbound.Headers.TryAddWithoutValidation(h.Key, h.Value) &&
                        outbound.Content != null)
                    {
                        outbound.Content.Headers.TryAddWithoutValidation(h.Key, h.Value);
                    }
                }

                HttpResponseMessage resp;
                using (var cts = new CancellationTokenSource(HeaderTimeout))
                {
                    try
                    {
                        resp = await Http.SendAsync(
                            outbound, HttpCompletionOption.ResponseHeadersRead,
                            cts.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        // Reported as a real response so the page can say which host
                        // went quiet rather than showing a bare "Failed to fetch".
                        return Error(sender, "no reply from " + SafeHost(target)
                                     + " within " + (int)HeaderTimeout.TotalSeconds
                                     + "s");
                    }
                    // Headers are in. Disarm the timer so streaming a large ROM body
                    // is not cut off by it.
                    cts.CancelAfter(Timeout.InfiniteTimeSpan);
                }

                var length = resp.Content.Headers.ContentLength;
                var body = length.HasValue && length.Value > SpillToDiskBytes
                    ? await SpillToDisk(resp)
                    : await BufferInMemory(resp);

                return sender.Environment.CreateWebResourceResponse(
                    body, (int)resp.StatusCode,
                    resp.ReasonPhrase ?? "OK", CorsHeaders(resp));
            }
        }

        private static bool IsBodyless(string method)
        {
            return method.Equals("GET", StringComparison.OrdinalIgnoreCase) ||
                   method.Equals("HEAD", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsHopByHop(string name)
        {
            switch (name.ToLowerInvariant())
            {
                case "host":
                case "connection":
                case "keep-alive":
                case "transfer-encoding":
                case "upgrade":
                case "content-length":
                // Dropped so the server answers uncompressed. Forwarding it would
                // hand the renderer gzip bytes with no Content-Encoding to explain
                // them, because only a fixed set of headers is copied back.
                case "accept-encoding":
                    return true;
                default:
                    return false;
            }
        }

        private static async Task<IRandomAccessStream> BufferInMemory(HttpResponseMessage resp)
        {
            var bytes = await resp.Content.ReadAsByteArrayAsync();
            var ms = new InMemoryRandomAccessStream();
            using (var w = new DataWriter(ms.GetOutputStreamAt(0)))
            {
                w.WriteBytes(bytes);
                await w.StoreAsync();
                await w.FlushAsync();
                w.DetachStream();
            }
            ms.Seek(0);
            return ms;
        }

        /// <summary>
        /// Streams the body to a temporary file and hands back a seekable read
        /// stream. CreateWebResourceResponse needs a random-access stream, and a
        /// several-hundred-megabyte ROM must not be held in memory to get one.
        /// </summary>
        private static async Task<IRandomAccessStream> SpillToDisk(HttpResponseMessage resp)
        {
            var file = await ApplicationData.Current.TemporaryFolder.CreateFileAsync(
                "dl-" + Guid.NewGuid().ToString("N"), CreationCollisionOption.ReplaceExisting);

            using (var source = await resp.Content.ReadAsStreamAsync())
            using (var target = await file.OpenStreamForWriteAsync())
            {
                await source.CopyToAsync(target, 1024 * 1024);
            }

            return await file.OpenAsync(FileAccessMode.Read);
        }

        private static string CorsHeaders(HttpResponseMessage resp)
        {
            var sb = new StringBuilder();
            sb.Append("Access-Control-Allow-Origin: *\r\n");
            sb.Append("Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS\r\n");
            sb.Append("Access-Control-Allow-Headers: Authorization, Content-Type\r\n");
            // X-Proxy-Error is exposed so the page can show a tester why a request
            // failed instead of a bare "Failed to fetch".
            sb.Append("Access-Control-Expose-Headers: Content-Length, Content-Type, "
                      + "Content-Disposition, Content-Range, Accept-Ranges, X-Proxy-Error\r\n");

            if (resp != null)
            {
                Copy(sb, resp.Content.Headers, "Content-Type");
                Copy(sb, resp.Content.Headers, "Content-Length");
                Copy(sb, resp.Content.Headers, "Content-Disposition");
                // Range matters for save-state and ROM reads that seek.
                Copy(sb, resp.Content.Headers, "Content-Range");
                Copy(sb, resp.Headers, "Accept-Ranges");
            }
            return sb.ToString();
        }

        private static void Copy(StringBuilder sb,
                                 System.Net.Http.Headers.HttpHeaders headers,
                                 string name)
        {
            System.Collections.Generic.IEnumerable<string> values;
            if (headers != null && headers.TryGetValues(name, out values))
            {
                foreach (var v in values)
                {
                    sb.Append(name).Append(": ").Append(v).Append("\r\n");
                }
            }
        }

        /// <summary>Host and port only — never echo a path or query into a message.</summary>
        private static string SafeHost(string url)
        {
            Uri u;
            return Uri.TryCreate(url, UriKind.Absolute, out u)
                ? u.Scheme + "://" + u.Authority : "the server";
        }

        private static CoreWebView2WebResourceResponse Error(CoreWebView2 sender, string why)
        {
            return sender.Environment.CreateWebResourceResponse(
                null, 502, "Bad Gateway",
                "Access-Control-Allow-Origin: *\r\nContent-Type: text/plain\r\nX-Proxy-Error: "
                + why.Replace("\r", " ").Replace("\n", " ") + "\r\n");
        }
    }
}
