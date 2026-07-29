using System;
using System.IO;
using Microsoft.Web.WebView2.Core;
using Windows.ApplicationModel;
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

            // On Xbox the B button raises system back, which would tear the app
            // down mid-typing — B is backspace in the app's on-screen keyboard.
            // The page owns B (it is delivered through GamepadBridge like every
            // other button), so swallow the system gesture and let the page
            // decide. The page asks to leave explicitly, via {"t":"exit"}.
            SystemNavigationManager.GetForCurrentView().BackRequested +=
                (s, e) => e.Handled = true;
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
        }
    }
}
