using System;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using Windows.Data.Json;

namespace RommForXbox.Shell
{
    /// <summary>
    /// A message-based fetch bridge: the renderer asks native code to perform an
    /// HTTP request and gets the full response (status, headers, body) back over
    /// the same postMessage channel the gamepad uses.
    ///
    /// This exists for exactly one case the renderer cannot handle itself: a
    /// plain-http RomM on the LAN. The packaged page is served from https, so an
    /// https-to-http fetch is active mixed content and the renderer blocks it
    /// before any code runs. Native HttpClient has no such rule.
    ///
    /// This is NOT the old WebResourceRequested proxy. That architecture was
    /// proven dead on this console: a CreateWebResourceResponse carrying a body
    /// stream is never delivered to the renderer. Here the body travels as data
    /// inside a web message the renderer already knows how to receive, so it
    /// arrives. The tradeoff is that the whole body is buffered and base64'd, so
    /// this path is for the JSON API and pairing (small), not for streaming a
    /// several-hundred-megabyte ROM. Callers gate on size.
    ///
    /// https servers never use this path; they are reached directly.
    /// </summary>
    internal sealed class NativeFetch
    {
        // A body larger than this is refused rather than base64'd through a web
        // message: it would balloon in memory and stall the message pump. The
        // renderer is told to use https for ROM content on a plain-http server.
        private const long MaxBodyBytes = 24L * 1024 * 1024;

        private static readonly TimeSpan HeaderTimeout = TimeSpan.FromSeconds(12);

        private static readonly HttpClient Http = CreateClient();

        private static HttpClient CreateClient()
        {
            var handler = new HttpClientHandler { AllowAutoRedirect = true };
            var c = new HttpClient(handler);
            c.Timeout = Timeout.InfiniteTimeSpan; // per-request timeout below
            return c;
        }

        /// <summary>
        /// Handle one {t:"nfetch", ...} message. Always replies with a
        /// {t:"nfetchResult", id, ...} message so the renderer's promise settles,
        /// whether the request succeeded, failed, or was refused.
        /// </summary>
        public static async Task Handle(CoreWebView2 web, JsonObject msg)
        {
            var id = msg.GetNamedString("id", string.Empty);
            var url = msg.GetNamedString("url", string.Empty);
            var method = msg.GetNamedString("method", "GET");

            var reply = new JsonObject
            {
                ["t"] = JsonValue.CreateStringValue("nfetchResult"),
                ["id"] = JsonValue.CreateStringValue(id),
            };

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
                    var bodyText = msg.GetNamedString("body", string.Empty);
                    if (bodyText.Length > 0)
                    {
                        var ct = msg.GetNamedString("contentType", "application/json");
                        req.Content = new StringContent(bodyText, Encoding.UTF8, ct);
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
                            Fail(reply, "too-large",
                                "Response is " + len.Value + " bytes; the http bridge caps at "
                                + MaxBodyBytes + ". Use an https server for large downloads.");
                            Send(web, reply);
                            return;
                        }

                        var bytes = await resp.Content.ReadAsByteArrayAsync();
                        if (bytes.Length > MaxBodyBytes)
                        {
                            Fail(reply, "too-large", "Response exceeded the http bridge cap.");
                            Send(web, reply);
                            return;
                        }

                        var headers = new JsonObject();
                        foreach (var h in resp.Headers)
                        {
                            headers[h.Key] = JsonValue.CreateStringValue(string.Join(", ", h.Value));
                        }
                        foreach (var h in resp.Content.Headers)
                        {
                            headers[h.Key] = JsonValue.CreateStringValue(string.Join(", ", h.Value));
                        }

                        reply["ok"] = JsonValue.CreateBooleanValue(true);
                        reply["status"] = JsonValue.CreateNumberValue((int)resp.StatusCode);
                        reply["statusText"] = JsonValue.CreateStringValue(resp.ReasonPhrase ?? string.Empty);
                        reply["headers"] = headers;
                        reply["bodyBase64"] = JsonValue.CreateStringValue(Convert.ToBase64String(bytes));
                    }
                }
            }
            catch (OperationCanceledException)
            {
                Fail(reply, "timeout", "The server did not respond within "
                    + (int)HeaderTimeout.TotalSeconds + " seconds.");
            }
            catch (HttpRequestException ex)
            {
                // Give the renderer a classifiable reason, not just "network".
                var kind = ClassifyNetworkError(ex);
                Fail(reply, kind, Flatten(ex));
            }
            catch (Exception ex)
            {
                Fail(reply, "error", Flatten(ex));
            }

            Send(web, reply);
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

        private static void Fail(JsonObject reply, string reason, string detail)
        {
            reply["ok"] = JsonValue.CreateBooleanValue(false);
            reply["reason"] = JsonValue.CreateStringValue(reason);
            reply["detail"] = JsonValue.CreateStringValue(detail);
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
