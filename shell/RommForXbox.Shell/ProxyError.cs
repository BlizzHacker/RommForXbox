using System;
using System.Net.Sockets;

namespace RommForXbox.Shell
{
    /// <summary>
    /// Turns a connection failure into a sentence that names the actual problem.
    ///
    /// "Could not connect" covers situations needing completely different fixes,
    /// and the person reading it cannot tell them apart: nothing answered (wrong
    /// address, machine off, blocked), something answered and refused (the machine
    /// is there but nothing is on that port), or the name did not resolve. Saying
    /// which one it was is the difference between a useful bug report and a shrug.
    ///
    /// Deliberately free of WinRT types so it compiles and is tested with csc on a
    /// dev machine, the same arrangement as RoutedUrl — see shell/tests.
    /// </summary>
    internal static class ProxyError
    {
        public static string Describe(Exception ex, string target, TimeSpan timeout)
        {
            var where = SafeHost(target);
            if (ex == null) return "could not reach " + where;

            // HttpRequestException usually carries the real cause inside.
            var inner = ex;
            while (inner.InnerException != null) inner = inner.InnerException;

            var sock = inner as SocketException;
            if (sock != null)
            {
                switch (sock.SocketErrorCode)
                {
                    case SocketError.ConnectionRefused:
                        return where + " refused the connection — something is at "
                             + "that address but nothing is listening on that port";
                    case SocketError.HostNotFound:
                    case SocketError.NoData:
                        return "could not look up " + where
                             + " — check the name, or use the IP address instead";
                    case SocketError.NetworkUnreachable:
                    case SocketError.HostUnreachable:
                        return where + " is unreachable from this console — it is "
                             + "usually on a different network or subnet";
                    case SocketError.TimedOut:
                        return where + " did not answer in time";
                    case SocketError.AccessDenied:
                        return "the console blocked the connection to " + where;
                }
            }

            // Cancellation here only ever comes from our own header timeout.
            if (inner is OperationCanceledException)
            {
                return "no reply from " + where + " within "
                     + (int)timeout.TotalSeconds + "s";
            }

            var msg = inner.Message;
            if (string.IsNullOrEmpty(msg)) msg = ex.GetType().Name;
            return "could not reach " + where + " — " + msg;
        }

        /// <summary>
        /// Scheme, host and port only.
        ///
        /// Never echo a path or query into a message: these end up on screen and in
        /// photographs of screens, and a ROM download URL carries the game's name
        /// and an access token.
        /// </summary>
        public static string SafeHost(string url)
        {
            Uri u;
            return Uri.TryCreate(url, UriKind.Absolute, out u)
                ? u.Scheme + "://" + u.Authority
                : "the server";
        }
    }
}
