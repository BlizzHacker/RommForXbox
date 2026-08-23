using System;
using System.IO;
using Microsoft.Web.WebView2.Core;
using Windows.ApplicationModel;
using Windows.Storage;
using Windows.System;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace RommForXbox.Shell
{
    /// <summary>
    /// Hosts the packaged web app and supplies the two things it cannot get for
    /// itself inside a WebView2:
    ///
    ///   * controller input — the Gamepad API does not reach WebView2 content
    ///     (WebView2Feedback#4366), so <see cref="GamepadBridge"/> reads
    ///     Windows.Gaming.Input and posts state into the page;
    ///   * a reachable plain-http server — the packaged page is https, so every
    ///     http:// URL it touches is mixed content and is blocked inside the
    ///     renderer. <see cref="NativeFetch"/> performs those requests natively,
    ///     where no such rule applies, and streams the result back over the same
    ///     web-message channel the gamepad uses.
    ///
    /// The app content is packaged, not remote, so nothing here depends on a
    /// server of ours being up.
    /// </summary>
    public sealed partial class MainPage : Page
    {
        private const string VirtualHost = "app.local";
        private readonly GamepadBridge _pads = new GamepadBridge();

        public MainPage()
        {
            InitializeComponent();
            Loaded += OnLoaded;

            // On Xbox, B tears the app down unless the app claims it, and the
            // chain is: KeyDown/KeyUp → if unhandled, BackRequested → if
            // unhandled, the shell closes the app. Handling only BackRequested
            // was not enough on hardware, so claim B at the earliest stage too.
            // The page owns B — it arrives through GamepadBridge like any other
            // button — and asks to leave explicitly, via {"t":"exit"}.
            // Guarded: another legacy view API, and losing the extra B-claim is
            // survivable where dying at the splash is not.
            try
            {
                var nav = SystemNavigationManager.GetForCurrentView();
                nav.BackRequested += (s, e) => e.Handled = true;
            }
            catch (Exception) { }

            var win = Window.Current.CoreWindow;
            win.KeyDown += SwallowBack;
            win.KeyUp += SwallowBack;
            // Catches the press even when focus sits inside the WebView2, which
            // does not route gamepad input through XAML at all.
            win.Dispatcher.AcceleratorKeyActivated += (s, e) =>
            {
                if (IsClaimed(e.VirtualKey)) e.Handled = true;
            };
        }

        /* Buttons the app must claim before anything else sees them.
         *
         * B is the console's back gesture: unclaimed, it closes the app.
         *
         * Menu and View are claimed for a different reason — WebView2 on Xbox uses
         * them to offer switching out of gamepad mode into a mouse cursor. A tester
         * accepted that prompt and had no way back, because the app has no cursor
         * UI to switch with. Menu is also the on-screen keyboard's "done", so the
         * prompt was appearing at the exact moment the user meant to submit.
         *
         * Claiming the *key* does not stop the app seeing the button: input reaches
         * the page through GamepadBridge, which reads Windows.Gaming.Input directly
         * and is unaffected by key routing. */
        private static readonly VirtualKey[] ClaimedKeys =
        {
            VirtualKey.GamepadB,
            VirtualKey.GamepadMenu,
            VirtualKey.GamepadView,
        };

        private static bool IsClaimed(VirtualKey key)
        {
            foreach (var k in ClaimedKeys)
            {
                if (k == key) return true;
            }
            return false;
        }

        private static void SwallowBack(CoreWindow sender, KeyEventArgs e)
        {
            if (IsClaimed(e.VirtualKey)) e.Handled = true;
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            // Edge DevTools remote debugging over the Device Portal. On in a
            // Debug build, and in a Release build ONLY when a marker file is
            // dropped into LocalState by an operator on a dev console. A shipped
            // Store package never has the marker, so retail stays undebuggable;
            // this lets us attach a debugger to a release-identical binary on
            // hardware without shipping a separate debug package (whose CoreCLR
            // framework the console does not carry). Must be set before the
            // CoreWebView2 is created.
            var debugOn = false;
#if DEBUG
            debugOn = true;
#endif
            try
            {
                if (File.Exists(Path.Combine(
                        ApplicationData.Current.LocalFolder.Path, "cartridge-devtools")))
                    debugOn = true;
            }
            catch (Exception) { }
            if (debugOn)
            {
                Environment.SetEnvironmentVariable(
                    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                    "--enable-features=msEdgeDevToolsWdpRemoteDebugging");
            }
            try
            {
                await Web.EnsureCoreWebView2Async();
            }
            catch (Exception ex)
            {
                Status.Text = "The web runtime could not start on this device.\n\n" + ex.Message;
                return;
            }

            var core = Web.CoreWebView2;

            // Serve the packaged web app from a real https origin. A file:// or
            // ms-appx-web:// origin is not a secure context in the ways
            // EmulatorJS needs, and localStorage would not persist the same way.
            var webRoot = Path.Combine(Package.Current.InstalledLocation.Path, "web");
            core.SetVirtualHostNameToFolderMapping(
                VirtualHost, webRoot, CoreWebView2HostResourceAccessKind.Allow);

            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;

            /* The WebResourceRequested proxy is NOT wired up, deliberately.
             *
             * On this console a CreateWebResourceResponse carrying a body stream
             * is never delivered to the renderer (proven on a Series X, commit
             * a0af21b), so the handler could not serve a single byte. And it can
             * never even SEE the requests it was written for: mixed content is
             * blocked in Blink, upstream of WebView2's network layer. What the
             * wildcard filter did do was marshal every packaged file, every
             * blob: and every cover through a managed round trip on the UI
             * thread to return null — pure cost on a memory- and CPU-tight
             * device, and one more live variable in the play path.
             *
             * RommProxy.cs and RoutedUrl.cs are kept: they are covered by CI
             * tests and remain the reference for the routed-URL scheme if a
             * future WebView2 fixes the delivery bug. */

            // The console's WebView2 maps a controller gesture to history
            // back and forward, which yanks the page out from under the user
            // mid-game (a tester's right stick paged between the app and the
            // server's sign-in). Nothing in this app ever navigates through
            // history on purpose, so cancel every such navigation. RomM's own
            // web UI routes in-page (pushState), which this does not touch.
            core.NavigationStarting += (s, a) =>
            {
                if (a.NavigationKind == CoreWebView2NavigationKind.BackOrForward)
                {
                    a.Cancel = true;
                }
            };

            // Inject the bridge into EVERY document, not just the packaged
            // pages that load it as a script tag: play happens on RomM's own
            // /console pages after a real navigation, where EmulatorJS polls
            // navigator.getGamepads() and, without this, sees no controller at
            // all (a tester got Donkey Kong on screen with dead controls).
            // host-bridge.js is double-load safe.
            // Authoritative build identity, injected before anything else on
            // EVERY document (packaged pages and RomM's /console pages alike).
            // The package version cannot go stale the way a hardcoded JS
            // constant did; a build-stamp file adds the git SHA and date.
            try
            {
                var v = Package.Current.Id.Version;
                var version = string.Format("{0}.{1}.{2}.{3}", v.Major, v.Minor, v.Build, v.Revision);
                var stamp = string.Empty;
                var stampPath = Path.Combine(webRoot, "build-stamp.js");
                if (File.Exists(stampPath)) stamp = File.ReadAllText(stampPath);
                await core.AddScriptToExecuteOnDocumentCreatedAsync(
                    "window.__CARTRIDGE_VERSION = '" + version + "';\n"
                    + "window.__CARTRIDGE_DEVTOOLS = " + (debugOn ? "true" : "false") + ";\n"
                    + stamp);
            }
            catch (Exception) { }

            try
            {
                var bridge = File.ReadAllText(Path.Combine(webRoot, "host-bridge.js"));
                await core.AddScriptToExecuteOnDocumentCreatedAsync(bridge);
            }
            catch (Exception)
            {
                // The packaged pages still load their own copy; only the
                // server-side pages lose the controller if this fails.
            }

            core.WebMessageReceived += OnWebMessageReceived;
            core.NavigationCompleted += (s, a) =>
            {
                Status.Visibility = a.IsSuccess ? Visibility.Collapsed : Visibility.Visible;
                if (!a.IsSuccess)
                {
                    Status.Text = "The app failed to load (" + a.WebErrorStatus + ").";
                }
            };
            core.ProcessFailed += (s, a) => OnProcessFailed(core, a);

            Web.Source = new Uri("https://" + VirtualHost + "/index.html");
            Web.Focus(FocusState.Programmatic);
        }

        // Bounded crash recovery. Consoles kill the WebView2 render process far
        // more readily than desktops (tight app memory budgets), and the old
        // handler turned every such death into a dead end: a permanent banner
        // over a page whose controller state was frozen at the last-held input.
        // Render and GPU deaths now reload the app in place; the page posts
        // "ready" when it is back, which restarts the pad feed cleanly.
        private int _recoveries;
        private DateTime _recoveryWindow = DateTime.MinValue;

        private void OnProcessFailed(CoreWebView2 core, CoreWebView2ProcessFailedEventArgs a)
        {
            // Neutralize page input first so nothing stays latched mid-crash.
            _pads.Stop();

            if (a.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                Status.Visibility = Visibility.Visible;
                Status.Text = "The app runtime closed. Please reopen Cartridge.";
                return;
            }

            var now = DateTime.UtcNow;
            if ((now - _recoveryWindow).TotalMinutes > 5)
            {
                _recoveryWindow = now;
                _recoveries = 0;
            }
            if (++_recoveries > 3)
            {
                Status.Visibility = Visibility.Visible;
                Status.Text = "The app keeps crashing on this console. Please close Cartridge and reopen it.";
                return;
            }

            Status.Visibility = Visibility.Visible;
            Status.Text = "Recovering...";
            try
            {
                core.Reload();
            }
            catch (Exception)
            {
                Status.Text = "The app could not recover. Please reopen Cartridge.";
            }
        }

        private void OnWebMessageReceived(CoreWebView2 sender,
                                          CoreWebView2WebMessageReceivedEventArgs args)
        {
            string json;
            try
            {
                json = args.WebMessageAsJson;
            }
            catch (Exception)
            {
                return;                     // not JSON; nothing we sent looks like that
            }

            if (json == null) return;

            // Switch on the parsed tag rather than on substrings of the raw
            // JSON. Substring matching worked while there was one message type
            // per prefix; it stops working the moment a second one shares it
            // (nfetch / nfetchAck), and it fails silently when it does.
            Windows.Data.Json.JsonObject obj;
            if (!Windows.Data.Json.JsonObject.TryParse(json, out obj)) return;
            var tag = obj.GetNamedString("t", string.Empty);

            switch (tag)
            {
                case "ready":
                    // host-bridge.js posts this once it is listening. Pumping
                    // before that just drops frames on the floor.
                    _pads.Start(sender);
                    break;

                case "exit":
                    // The page reached its root and the user pressed back.
                    // Leaving has to be possible without the Guide button.
                    _pads.Stop();
                    Application.Current.Exit();
                    break;

                case "nfetch":
                    // A plain-http LAN request the renderer cannot make itself.
                    // Performed natively and streamed back over this channel.
                    var _ = NativeFetch.Handle(sender, obj);
                    break;

                case "nfetchAck":
                    // Flow control: the page has taken delivery of a chunk, so
                    // one more may go out.
                    NativeFetch.Ack(obj);
                    break;
            }
        }
    }
}
