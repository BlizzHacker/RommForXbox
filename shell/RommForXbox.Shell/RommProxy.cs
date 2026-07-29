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

        private static HttpClient CreateClient()
        {
            var handler = new HttpClientHandler { AllowAutoRedirect = true };
            var c = new HttpClient(handler);
            // Long enough for a large ROM over a slow link; the page shows progress.
            c.Timeout = TimeSpan.FromMinutes(30);
            return c;
        }

        public async void OnWebResourceRequested(
            CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
        {
            if (!ShouldIntercept(args)) return;

            var deferral = args.GetDeferral();
            try
            {
                args.Response = await BuildResponse(sender, args);
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

        private bool ShouldIntercept(CoreWebView2WebResourceRequestedEventArgs args)
        {
            if (args.ResourceContext != CoreWebView2WebResourceContext.Fetch &&
                args.ResourceContext != CoreWebView2WebResourceContext.XmlHttpRequest)
            {
                return false;
            }

            Uri uri;
            if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out uri)) return false;
            if (uri.Host.Equals(_virtualHost, StringComparison.OrdinalIgnoreCase)) return false;
            return uri.Scheme == "http" || uri.Scheme == "https";
        }

        private async Task<CoreWebView2WebResourceResponse> BuildResponse(
            CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
        {
            var req = args.Request;

            // Answer the preflight ourselves. Forwarding it would just return the
            // permissive headers RomM already sends, at the cost of a round trip.
            if (string.Equals(req.Method, "OPTIONS", StringComparison.OrdinalIgnoreCase))
            {
                return sender.Environment.CreateWebResourceResponse(
                    null, 204, "No Content", CorsHeaders(null));
            }

            using (var outbound = new HttpRequestMessage(new HttpMethod(req.Method), req.Uri))
            {
                if (req.Content != null && !IsBodyless(req.Method))
                {
                    var buffer = new MemoryStream();
                    await req.Content.CopyToAsync(buffer);
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

                var resp = await Http.SendAsync(
                    outbound, HttpCompletionOption.ResponseHeadersRead);

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
            sb.Append("Access-Control-Expose-Headers: Content-Length, Content-Type, Content-Disposition\r\n");

            if (resp != null)
            {
                Copy(sb, resp.Content, "Content-Type");
                Copy(sb, resp.Content, "Content-Length");
                Copy(sb, resp.Content, "Content-Disposition");
            }
            return sb.ToString();
        }

        private static void Copy(StringBuilder sb, HttpContent content, string name)
        {
            System.Collections.Generic.IEnumerable<string> values;
            if (content != null && content.Headers.TryGetValues(name, out values))
            {
                foreach (var v in values)
                {
                    sb.Append(name).Append(": ").Append(v).Append("\r\n");
                }
            }
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
