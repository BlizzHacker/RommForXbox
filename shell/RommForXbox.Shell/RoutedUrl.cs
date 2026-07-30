using System;

namespace RommForXbox.Shell
{
    /// <summary>
    /// Translates between a customer's RomM address and the same-origin path the
    /// page actually requests.
    ///
    /// The packaged app is served from https://app.local so that it stays a
    /// secure context (WebRTC streaming needs one). That makes a plain-http RomM
    /// — which is what most self-hosted boxes on a LAN are — unreachable: an
    /// https page fetching http:// is active mixed content, blocked in the
    /// renderer before any native interception could see it. So the page asks for
    ///
    ///     https://app.local/__romm/http/192.168.1.42/api/roms?x=1
    ///
    /// which is same-origin (no mixed content, no CORS) and which this unwraps
    /// back to http://192.168.1.42/api/roms?x=1 before fetching it natively.
    ///
    /// The target is kept as readable path segments rather than encoded into one,
    /// because EmulatorJS appends relative paths to whatever base it is given —
    /// so the base has to survive ordinary URL joining.
    ///
    /// Deliberately free of WinRT types: this is the part most likely to be wrong,
    /// so it is compiled and tested on its own (see shell/tests).
    /// </summary>
    internal static class RoutedUrl
    {
        public const string Prefix = "/__romm/";

        /// <summary>
        /// Returns the real target URL for a routed request, or null if this is
        /// not a routed request or the route is malformed.
        /// </summary>
        public static string Unwrap(string requestUri, string virtualHost)
        {
            if (string.IsNullOrEmpty(requestUri)) return null;

            Uri uri;
            if (!Uri.TryCreate(requestUri, UriKind.Absolute, out uri)) return null;
            if (!string.Equals(uri.Host, virtualHost, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            // AbsolutePath is already percent-decoded per segment by Uri; use the
            // raw path so a ROM name with a space or '+' survives the round trip.
            var path = uri.GetComponents(UriComponents.Path, UriFormat.UriEscaped);
            if (!path.StartsWith("__romm/", StringComparison.Ordinal)) return null;

            var rest = path.Substring("__romm/".Length);
            var slash = rest.IndexOf('/');
            if (slash <= 0) return null;

            var scheme = rest.Substring(0, slash);
            if (scheme != "http" && scheme != "https") return null;

            var hostAndPath = rest.Substring(slash + 1);
            if (hostAndPath.Length == 0) return null;

            // A bare host with no trailing slash still has to produce a valid URL.
            var hostEnd = hostAndPath.IndexOf('/');
            if (hostEnd == 0) return null;

            var query = uri.GetComponents(UriComponents.Query, UriFormat.UriEscaped);
            var target = scheme + "://" + hostAndPath;
            if (!string.IsNullOrEmpty(query)) target += "?" + query;

            // Reject anything that does not parse as an absolute http(s) URL, so a
            // malformed route cannot be turned into a request to somewhere else.
            Uri parsed;
            if (!Uri.TryCreate(target, UriKind.Absolute, out parsed)) return null;
            if (parsed.Scheme != "http" && parsed.Scheme != "https") return null;
            if (string.IsNullOrEmpty(parsed.Host)) return null;

            return target;
        }
    }
}
