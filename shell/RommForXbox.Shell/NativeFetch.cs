using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using Windows.Data.Json;

namespace RommForXbox.Shell
{
    /// <summary>
    /// A message-based fetch bridge: the renderer asks native code to perform an
    /// HTTP request and gets the response back over the same postMessage channel
    /// the gamepad uses.
    ///
    /// This exists for exactly one case the renderer cannot handle itself: a
    /// plain-http RomM on the LAN, which is what most self-hosted boxes are. The
    /// packaged page is served from https, so an https-to-http request is active
    /// mixed content and the renderer blocks it before any code runs. Native
    /// HttpClient has no such rule.
    ///
    /// This is NOT the old WebResourceRequested proxy. That architecture was
    /// proven dead on this console: a CreateWebResourceResponse carrying a body
    /// stream is never delivered to the renderer. Here the body travels as data
    /// inside a web message the renderer already knows how to receive, so it
    /// arrives.
    ///
    /// The body is STREAMED, in chunks, rather than base64'd whole into one
    /// message. The single-message version had to cap responses at 24 MB, and
    /// that cap was not an edge case: it refused most EmulatorJS cores and every
    /// cartridge past the 16-bit era, on the exact configuration this bridge
    /// exists to serve. Streaming also gives the page real download progress and
    /// keeps peak memory to one chunk on each side.
    ///
    /// Flow control is by acknowledgement. Without it a fast server fills the
    /// WebView2 message queue faster than the renderer drains it, which on a
    /// console budget is how an app dies mid-download; at most
    /// <see cref="WindowChunks"/> chunks are ever in flight.
    ///
    /// https servers never use this path; they are reached directly.
    /// </summary>
    internal sealed class NativeFetch
    {
        // Raw bytes per chunk. Base64 inflates this by a third on the wire, so
        // each message is around 350 KB. Chunk size is not what limits
        // throughput here — the acknowledgement window keeps several in flight,
        // which is already far more than a LAN can fill — so it is chosen small
        // enough to keep per-message allocation modest on a console heap.
        private const int ChunkBytes = 256 * 1024;

        // Chunks allowed in flight before the renderer must acknowledge.
        private const int WindowChunks = 8;

        // A hard ceiling, so a mistyped URL pointing at something enormous cannot
        // fill the console's storage. Disc-sized systems are served by the stream
        // tier, not by downloading the image to the console.
        private const long MaxBodyBytes = 1024L * 1024L * 1024L;

        private static readonly TimeSpan HeaderTimeout = TimeSpan.FromSeconds(12);

        // If the renderer stops acknowledging this long, it has navigated away,
        // reloaded or died. Abandon the transfer rather than blocking forever.
        private static readonly TimeSpan AckTimeout = TimeSpan.FromSeconds(60);

        // How long the body may go silent before the transfer is abandoned. Any
        // working transfer delivers something well inside this; a stalled one
        // would otherwise hold a connection open for the life of the app.
        private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(60);

        private static readonly HttpClient Http = CreateClient();

        /* The insecure lane, for one opt-in setting: an operator whose RomM
         * answers https with a self-signed certificate. The renderer can never
         * be told to trust one, and UWP's System.Net.Http handler has no
         * certificate callback either (it is a shim over WinHTTP and throws
         * PlatformNotSupportedException) — the platform lever is
         * HttpBaseProtocolFilter.IgnorableServerCertificateErrors, which lives
         * on Windows.Web.Http. So requests the page marks insecure AND the
         * shell's own stored setting allows go through this second client.
         * Two conditions, never one: the page proposes, the shell decides. */
        private static volatile bool _allowInsecure;
        private static Windows.Web.Http.HttpClient _insecureHttp;
        private static readonly object InsecureLock = new object();

        /// <summary>
        /// The shell's persisted copy of the operator's opt-in. Set at startup
        /// and whenever the page posts {t:'setInsecure'}; a per-message request
        /// is honoured only while this is true.
        /// </summary>
        public static bool AllowInsecure
        {
            get { return _allowInsecure; }
            set { _allowInsecure = value; }
        }

        private static Windows.Web.Http.HttpClient InsecureClient()
        {
            lock (InsecureLock)
            {
                if (_insecureHttp == null)
                {
                    var filter = new Windows.Web.Http.Filters.HttpBaseProtocolFilter();
                    // Enumerated, not "everything": these are the failures a
                    // self-signed LAN certificate actually produces. Revoked
                    // and other chain failures stay fatal even in this lane.
                    filter.IgnorableServerCertificateErrors.Add(
                        Windows.Security.Cryptography.Certificates.ChainValidationResult.Untrusted);
                    filter.IgnorableServerCertificateErrors.Add(
                        Windows.Security.Cryptography.Certificates.ChainValidationResult.InvalidName);
                    filter.IgnorableServerCertificateErrors.Add(
                        Windows.Security.Cryptography.Certificates.ChainValidationResult.Expired);
                    _insecureHttp = new Windows.Web.Http.HttpClient(filter);
                }
                return _insecureHttp;
            }
        }

        // One gate per in-flight request, released by the renderer's acks.
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> Gates =
            new ConcurrentDictionary<string, SemaphoreSlim>();

        private static HttpClient CreateClient()
        {
            var handler = new HttpClientHandler { AllowAutoRedirect = true };
            var c = new HttpClient(handler);
            c.Timeout = Timeout.InfiniteTimeSpan; // per-phase timeouts below
            return c;
        }

        /// <summary>
        /// Handle one {t:"nfetchAck", id} message from the renderer: one more
        /// chunk may go out for that request.
        /// </summary>
        public static void Ack(JsonObject msg)
        {
            var id = msg.GetNamedString("id", string.Empty);
            SemaphoreSlim gate;
            if (id.Length > 0 && Gates.TryGetValue(id, out gate))
            {
                try { gate.Release(); }
                catch (SemaphoreFullException) { /* duplicate ack; harmless */ }
            }
        }

        /// <summary>
        /// Handle one {t:"nfetch", ...} message. Always ends the exchange with
        /// either {t:"nfetchEnd"} or {t:"nfetchFail"} so the renderer's promise
        /// settles, whether the request succeeded, failed, or was refused.
        /// </summary>
        public static async Task Handle(CoreWebView2 web, JsonObject msg)
        {
            var id = msg.GetNamedString("id", string.Empty);
            var url = msg.GetNamedString("url", string.Empty);
            var method = msg.GetNamedString("method", "GET");

            // The page asked for the certificate bypass AND the operator
            // enabled it in the shell's own settings. Either half missing
            // and the request takes the normal, fully-validated path.
            if (msg.GetNamedBoolean("insecure", false) && _allowInsecure)
            {
                await HandleInsecure(web, msg, id, url, method);
                return;
            }

            var gate = new SemaphoreSlim(WindowChunks, int.MaxValue);
            Gates[id] = gate;
            var headSent = false;

            try
            {
                using (var req = new HttpRequestMessage(new HttpMethod(method), url))
                {
                    if (msg.ContainsKey("headers") && msg["headers"].ValueType == JsonValueType.Object)
                    {
                        foreach (var kv in msg.GetNamedObject("headers"))
                        {
                            req.Headers.TryAddWithoutValidation(kv.Key, kv.Value.GetString());
                        }
                    }
                    // A binary body (a save state, uploaded as multipart) arrives
                    // base64'd, with the Content-Type the renderer generated —
                    // which carries the multipart boundary and must be used
                    // verbatim, so it is set on the content rather than parsed
                    // out of the caller's headers.
                    var bodyB64 = msg.GetNamedString("bodyBase64", string.Empty);
                    var bodyText = msg.GetNamedString("body", string.Empty);
                    var contentType = msg.GetNamedString("contentType", "application/json");
                    if (bodyB64.Length > 0)
                    {
                        var raw = Convert.FromBase64String(bodyB64);
                        var content = new ByteArrayContent(raw);
                        try
                        {
                            content.Headers.ContentType =
                                System.Net.Http.Headers.MediaTypeHeaderValue.Parse(contentType);
                        }
                        catch (FormatException) { /* leave it unset rather than fail the upload */ }
                        req.Content = content;
                    }
                    else if (bodyText.Length > 0)
                    {
                        req.Content = new StringContent(bodyText, Encoding.UTF8, contentType);
                    }

                    HttpResponseMessage resp;
                    using (var cts = new CancellationTokenSource(HeaderTimeout))
                    {
                        resp = await Http.SendAsync(
                            req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
                    }
                    using (resp)
                    {
                        var len = resp.Content.Headers.ContentLength;
                        if (len.HasValue && len.Value > MaxBodyBytes)
                        {
                            SendFail(web, id, "too-large",
                                "This file is " + Megabytes(len.Value) + " MB. The console can "
                                + "download up to " + Megabytes(MaxBodyBytes) + " MB; disc-sized "
                                + "games play through a stream server instead.");
                            return;
                        }

                        SendHead(web, id, resp, len.HasValue ? len.Value : -1);
                        headSent = true;

                        var total = 0L;
                        var buffer = new byte[ChunkBytes];
                        using (var stream = await resp.Content.ReadAsStreamAsync())
                        using (var readCts = new CancellationTokenSource())
                        {
                            for (;;)
                            {
                                // Re-armed every pass, so the limit is SILENCE
                                // rather than total duration: a large ROM may
                                // legitimately take many minutes, but a server
                                // that stops sending must not leave the request
                                // — and its connection — hanging forever.
                                readCts.CancelAfter(ReadTimeout);
                                var read = await stream.ReadAsync(
                                    buffer, 0, buffer.Length, readCts.Token);
                                if (read <= 0) break;

                                total += read;
                                if (total > MaxBodyBytes)
                                {
                                    SendFail(web, id, "too-large",
                                        "The download passed the " + Megabytes(MaxBodyBytes)
                                        + " MB limit for this console.");
                                    return;
                                }

                                if (!await gate.WaitAsync(AckTimeout))
                                {
                                    // The page stopped acknowledging: it navigated
                                    // away or died. Nothing is listening.
                                    return;
                                }

                                SendChunk(web, id, buffer, read);
                            }
                        }

                        SendEnd(web, id);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                SendFail(web, id, "timeout", headSent
                    ? "The server stopped sending partway through the download."
                    : "The server did not respond within "
                      + (int)HeaderTimeout.TotalSeconds + " seconds.");
            }
            catch (HttpRequestException ex)
            {
                // Give the renderer a classifiable reason, not just "network".
                SendFail(web, id, ClassifyNetworkError(ex), Flatten(ex));
            }
            catch (Exception ex)
            {
                SendFail(web, id, "error", Flatten(ex));
            }
            finally
            {
                SemaphoreSlim gone;
                Gates.TryRemove(id, out gone);
                gate.Dispose();
            }
        }

        /// <summary>
        /// The certificate-bypass twin of <see cref="Handle"/>: same message
        /// protocol, same streaming, same flow control, but the request goes
        /// through a Windows.Web.Http client whose filter ignores
        /// untrusted/invalid-name/expired certs. Kept as its own method rather
        /// than a branch inside Handle because Windows.Web.Http and
        /// System.Net.Http do not share request/response types — and because
        /// the fully-validated path must stay untouched: this lane is opt-in,
        /// narrow, and a bug in it must never affect a normal request.
        /// </summary>
        private static async Task HandleInsecure(CoreWebView2 web, JsonObject msg,
                                                 string id, string url, string method)
        {
            var gate = new SemaphoreSlim(WindowChunks, int.MaxValue);
            Gates[id] = gate;
            var headSent = false;

            try
            {
                var http = InsecureClient();
                using (var req = new Windows.Web.Http.HttpRequestMessage(
                           new Windows.Web.Http.HttpMethod(method), new Uri(url)))
                {
                    if (msg.ContainsKey("headers") && msg["headers"].ValueType == JsonValueType.Object)
                    {
                        foreach (var kv in msg.GetNamedObject("headers"))
                        {
                            req.Headers.TryAppendWithoutValidation(kv.Key, kv.Value.GetString());
                        }
                    }
                    var bodyB64 = msg.GetNamedString("bodyBase64", string.Empty);
                    var bodyText = msg.GetNamedString("body", string.Empty);
                    var contentType = msg.GetNamedString("contentType", "application/json");
                    if (bodyB64.Length > 0)
                    {
                        var raw = Convert.FromBase64String(bodyB64);
                        // byte[] -> IBuffer via the WinRT extension imported at
                        // the top; HttpBufferContent then wraps it without a copy.
                        var content = new Windows.Web.Http.HttpBufferContent(raw.AsBuffer());
                        try
                        {
                            content.Headers.ContentType =
                                Windows.Web.Http.Headers.HttpMediaTypeHeaderValue
                                    .Parse(contentType);
                        }
                        catch (FormatException) { /* leave it unset rather than fail the upload */ }
                        req.Content = content;
                    }
                    else if (bodyText.Length > 0)
                    {
                        req.Content = new Windows.Web.Http.HttpStringContent(
                            bodyText, Windows.Storage.Streams.UnicodeEncoding.Utf8, contentType);
                    }

                    Windows.Web.Http.HttpResponseMessage resp;
                    using (var cts = new CancellationTokenSource(HeaderTimeout))
                    {
                        resp = await http.SendRequestAsync(
                            req, Windows.Web.Http.HttpCompletionOption.ResponseHeadersRead)
                            .AsTask(cts.Token);
                    }
                    using (resp)
                    {
                        // Windows.Web.Http exposes Content-Length typed; a
                        // string probe of the header map is both wrong-shaped
                        // and misses the chunked case (null).
                        var len = resp.Content.Headers.ContentLength.HasValue
                            ? (long)resp.Content.Headers.ContentLength.Value
                            : -1L;
                        if (len > MaxBodyBytes)
                        {
                            SendFail(web, id, "too-large",
                                "This file is " + Megabytes(len) + " MB. The console can "
                                + "download up to " + Megabytes(MaxBodyBytes) + " MB; disc-sized "
                                + "games play through a stream server instead.");
                            return;
                        }

                        SendHead(web, id, resp, len);
                        headSent = true;

                        var total = 0L;
                        var buffer = new byte[ChunkBytes];
                        using (var stream = (await resp.Content.ReadAsInputStreamAsync())
                                             .AsStreamForRead())
                        using (var readCts = new CancellationTokenSource())
                        {
                            for (;;)
                            {
                                readCts.CancelAfter(ReadTimeout);
                                var read = await stream.ReadAsync(
                                    buffer, 0, buffer.Length, readCts.Token);
                                if (read <= 0) break;

                                total += read;
                                if (total > MaxBodyBytes)
                                {
                                    SendFail(web, id, "too-large",
                                        "The download passed the " + Megabytes(MaxBodyBytes)
                                        + " MB limit for this console.");
                                    return;
                                }

                                if (!await gate.WaitAsync(AckTimeout))
                                {
                                    return;
                                }

                                SendChunk(web, id, buffer, read);
                            }
                        }

                        SendEnd(web, id);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                SendFail(web, id, "timeout", headSent
                    ? "The server stopped sending partway through the download."
                    : "The server did not respond within "
                      + (int)HeaderTimeout.TotalSeconds + " seconds.");
            }
            catch (Exception ex)
            {
                // Windows.Web.Http wraps failures with an HResult rather than
                // the message text ClassifyNetworkError knows; the flattened
                // chain still carries the inner wording in practice.
                SendFail(web, id, ClassifyNetworkError(ex), Flatten(ex));
            }
            finally
            {
                SemaphoreSlim gone;
                Gates.TryRemove(id, out gone);
                gate.Dispose();
            }
        }

        private static void SendHead(CoreWebView2 web, string id,
                                     Windows.Web.Http.HttpResponseMessage resp, long length)
        {
            var headers = new JsonObject();
            foreach (var h in resp.Headers)
            {
                headers[h.Key] = JsonValue.CreateStringValue(string.Join(", ", h.Value));
            }
            foreach (var h in resp.Content.Headers)
            {
                headers[h.Key] = JsonValue.CreateStringValue(string.Join(", ", h.Value));
            }

            var reply = new JsonObject
            {
                ["t"] = JsonValue.CreateStringValue("nfetchHead"),
                ["id"] = JsonValue.CreateStringValue(id),
                ["status"] = JsonValue.CreateNumberValue((int)resp.StatusCode),
                ["statusText"] = JsonValue.CreateStringValue(resp.ReasonPhrase ?? string.Empty),
                ["url"] = JsonValue.CreateStringValue(
                    resp.RequestMessage != null && resp.RequestMessage.RequestUri != null
                        ? resp.RequestMessage.RequestUri.ToString() : string.Empty),
                ["length"] = JsonValue.CreateNumberValue(length),
                ["headers"] = headers,
            };
            Send(web, reply);
        }

        private static long Megabytes(long bytes)
        {
            return bytes / (1024L * 1024L);
        }

        private static string ClassifyNetworkError(Exception ex)
        {
            var text = Flatten(ex).ToLowerInvariant();
            if (text.Contains("no such host") || text.Contains("name or service")
                || text.Contains("getaddrinfo") || text.Contains("could not be resolved")
                || text.Contains("name could not be resolved")
                || text.Contains("server name or address could not be resolved"))
                return "dns";
            if (text.Contains("ssl") || text.Contains("secure channel")
                || text.Contains("certificate") || text.Contains("tls"))
                return "tls";
            // Xbox/WinHTTP wording for a closed port / no listener is
            // "A connection with the server could not be established", not the
            // desktop "actively refused". Cover both.
            if (text.Contains("actively refused") || text.Contains("refused")
                || text.Contains("connection with the server could not be established")
                || text.Contains("cannot connect") || text.Contains("could not be established"))
                return "refused";
            return "network";
        }

        private static void SendHead(CoreWebView2 web, string id,
                                     HttpResponseMessage resp, long length)
        {
            var headers = new JsonObject();
            foreach (var h in resp.Headers)
            {
                headers[h.Key] = JsonValue.CreateStringValue(string.Join(", ", h.Value));
            }
            foreach (var h in resp.Content.Headers)
            {
                headers[h.Key] = JsonValue.CreateStringValue(string.Join(", ", h.Value));
            }

            var reply = new JsonObject
            {
                ["t"] = JsonValue.CreateStringValue("nfetchHead"),
                ["id"] = JsonValue.CreateStringValue(id),
                ["status"] = JsonValue.CreateNumberValue((int)resp.StatusCode),
                ["statusText"] = JsonValue.CreateStringValue(resp.ReasonPhrase ?? string.Empty),
                ["url"] = JsonValue.CreateStringValue(
                    resp.RequestMessage != null && resp.RequestMessage.RequestUri != null
                        ? resp.RequestMessage.RequestUri.ToString() : string.Empty),
                ["length"] = JsonValue.CreateNumberValue(length),
                ["headers"] = headers,
            };
            Send(web, reply);
        }

        private static void SendChunk(CoreWebView2 web, string id, byte[] buffer, int count)
        {
            var reply = new JsonObject
            {
                ["t"] = JsonValue.CreateStringValue("nfetchChunk"),
                ["id"] = JsonValue.CreateStringValue(id),
                ["b64"] = JsonValue.CreateStringValue(
                    Convert.ToBase64String(buffer, 0, count)),
            };
            Send(web, reply);
        }

        private static void SendEnd(CoreWebView2 web, string id)
        {
            Send(web, new JsonObject
            {
                ["t"] = JsonValue.CreateStringValue("nfetchEnd"),
                ["id"] = JsonValue.CreateStringValue(id),
            });
        }

        private static void SendFail(CoreWebView2 web, string id, string reason, string detail)
        {
            Send(web, new JsonObject
            {
                ["t"] = JsonValue.CreateStringValue("nfetchFail"),
                ["id"] = JsonValue.CreateStringValue(id),
                ["reason"] = JsonValue.CreateStringValue(reason),
                ["detail"] = JsonValue.CreateStringValue(detail ?? string.Empty),
            });
        }

        private static string Flatten(Exception ex)
        {
            var sb = new StringBuilder();
            for (var e = ex; e != null; e = e.InnerException)
            {
                if (sb.Length > 0) sb.Append(" | ");
                sb.Append(e.Message);
            }
            return sb.ToString();
        }

        private static void Send(CoreWebView2 web, JsonObject reply)
        {
            try { web.PostWebMessageAsJson(reply.Stringify()); }
            catch (Exception) { }
        }
    }
}
