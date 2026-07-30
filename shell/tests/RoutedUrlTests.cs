// Standalone test for RoutedUrl. The shell itself needs the UWP toolchain, which
// only exists in CI; this file compiles the one piece of tricky native logic
// against plain .NET Framework so it can be tested on a dev machine with csc.
//
//   csc /nologo /out:t.exe shell\tests\RoutedUrlTests.cs shell\RommForXbox.Shell\RoutedUrl.cs
//   .\t.exe
using System;
using RommForXbox.Shell;

internal static class RoutedUrlTests
{
    private static int _failed;

    private static void Eq(string label, string expected, string actual)
    {
        var ok = expected == actual;
        if (!ok) _failed++;
        Console.WriteLine("{0}  {1}", ok ? "PASS" : "FAIL", label);
        if (!ok)
        {
            Console.WriteLine("        expected: " + (expected ?? "<null>"));
            Console.WriteLine("        actual:   " + (actual ?? "<null>"));
        }
    }

    private static int Main()
    {
        const string H = "app.local";

        // The bug Wade hit: a plain-http RomM on a LAN, by IP, on the default port.
        Eq("bare LAN host, no path",
            "http://192.168.1.42",
            RoutedUrl.Unwrap("https://app.local/__romm/http/192.168.1.42", H));

        Eq("LAN host with API path",
            "http://192.168.1.42/api/platforms",
            RoutedUrl.Unwrap("https://app.local/__romm/http/192.168.1.42/api/platforms", H));

        Eq("query string is preserved",
            "http://192.168.1.42/api/roms?platform_ids=3&limit=500",
            RoutedUrl.Unwrap(
                "https://app.local/__romm/http/192.168.1.42/api/roms?platform_ids=3&limit=500", H));

        Eq("non-default port survives",
            "http://192.168.1.42:8080/api/heartbeat",
            RoutedUrl.Unwrap("https://app.local/__romm/http/192.168.1.42:8080/api/heartbeat", H));

        Eq("https target",
            "https://romm.example.com/api/heartbeat",
            RoutedUrl.Unwrap("https://app.local/__romm/https/romm.example.com/api/heartbeat", H));

        // EmulatorJS appends relative paths to EJS_pathtodata, so the joined
        // result has to unwrap too — this is why the target is path segments
        // rather than one encoded blob.
        Eq("EmulatorJS data path",
            "http://192.168.1.42/assets/emulatorjs/data/",
            RoutedUrl.Unwrap(
                "https://app.local/__romm/http/192.168.1.42/assets/emulatorjs/data/", H));
        Eq("EmulatorJS relative append",
            "http://192.168.1.42/assets/emulatorjs/data/emulator.min.js",
            RoutedUrl.Unwrap(
                "https://app.local/__romm/http/192.168.1.42/assets/emulatorjs/data/emulator.min.js", H));

        // RomM hands back cover paths containing spaces; encodeURI leaves %20.
        Eq("percent-encoded space is not decoded",
            "http://192.168.1.42/assets/romm/resources/Some%20Game/cover.png",
            RoutedUrl.Unwrap(
                "https://app.local/__romm/http/192.168.1.42/assets/romm/resources/Some%20Game/cover.png", H));

        Eq("server mounted under a subpath",
            "https://example.com/romm/api/platforms",
            RoutedUrl.Unwrap("https://app.local/__romm/https/example.com/romm/api/platforms", H));

        // Everything below must NOT be treated as a routed request.
        Eq("app's own page is not routed", null,
            RoutedUrl.Unwrap("https://app.local/index.html", H));
        Eq("app's own script is not routed", null,
            RoutedUrl.Unwrap("https://app.local/app.js", H));
        Eq("a different host is not ours", null,
            RoutedUrl.Unwrap("https://evil.example/__romm/http/192.168.1.42", H));
        Eq("unknown scheme segment is refused", null,
            RoutedUrl.Unwrap("https://app.local/__romm/file/etc/passwd", H));
        Eq("scheme with no host is refused", null,
            RoutedUrl.Unwrap("https://app.local/__romm/http/", H));
        Eq("prefix with nothing after it is refused", null,
            RoutedUrl.Unwrap("https://app.local/__romm/", H));
        Eq("prefix alone is refused", null,
            RoutedUrl.Unwrap("https://app.local/__romm", H));
        Eq("garbage is refused", null,
            RoutedUrl.Unwrap("not a url", H));
        Eq("null is refused", null, RoutedUrl.Unwrap(null, H));

        Console.WriteLine();
        Console.WriteLine(_failed == 0 ? "all RoutedUrl tests passed"
                                       : _failed + " RoutedUrl test(s) FAILED");
        return _failed == 0 ? 0 : 1;
    }
}
