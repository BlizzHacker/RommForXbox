using System;
using System.IO;
using Microsoft.Web.WebView2.Core;
using Windows.ApplicationModel;
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
    ///   * cross-origin file access — RomM serves ROM bytes via nginx
    ///     X-Accel-Redirect and /assets straight from nginx, neither carrying the
    ///     CORS header its API sends, so <see cref="RommProxy"/> refetches those
    ///     requests natively where no CORS rule applies.
    ///
    /// The app content is packaged, not remote, so nothing here depends on a
    /// server of ours being up.
    /// </summary>
    public sealed partial class MainPage : Page
    {
        private const string VirtualHost = "app.local";
        private readonly GamepadBridge _pads = new GamepadBridge();
        private RommProxy _proxy;

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
#if DEBUG
            // Lets Edge DevTools attach over the Xbox Device Portal. Must be set
            // before the CoreWebView2 is created.
            Environment.SetEnvironmentVariable(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--enable-features=msEdgeDevToolsWdpRemoteDebugging");
#endif
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

            _proxy = new RommProxy(VirtualHost);
            // Filter everything and decide per request: the handler passes local
            // and non-CORS-sensitive requests straight through.
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += _proxy.OnWebResourceRequested;

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
                    "window.__CARTRIDGE_VERSION = '" + version + "';\n" + stamp);
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
            core.ProcessFailed += (s, a) =>
            {
                Status.Visibility = Visibility.Visible;
                Status.Text = "The web runtime stopped (" + a.ProcessFailedKind + "). "
                            + "Close and reopen RomM for Xbox.";
            };

            Web.Source = new Uri("https://" + VirtualHost + "/index.html");
            Web.Focus(FocusState.Programmatic);
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

            // host-bridge.js posts {"t":"ready"} once it is listening. Pumping
            // before that just drops frames on the floor.
            if (json.Contains("\"ready\""))
            {
                _pads.Start(sender);
            }
            else if (json.Contains("\"exit\""))
            {
                // The page reached its root and the user pressed back. Leaving
                // has to be possible without the Guide button.
                _pads.Stop();
                Application.Current.Exit();
            }
            else if (json.Contains("\"nfetch\""))
            {
                // A plain-http LAN request the renderer cannot make itself.
                // Performed natively and replied over the same channel.
                Windows.Data.Json.JsonObject obj;
                if (Windows.Data.Json.JsonObject.TryParse(json, out obj)
                    && obj.GetNamedString("t", string.Empty) == "nfetch")
                {
                    var _ = NativeFetch.Handle(sender, obj);
                }
            }
        }
    }
}
