using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace RommForXbox.Shell
{
    /// <summary>
    /// Host application. Its only job is to put a WebView2 on screen full-bleed
    /// and hand the console's controller to the web app inside it.
    /// </summary>
    public sealed partial class App : Application
    {
        public App()
        {
            InitializeComponent();
            Suspending += OnSuspending;
        }

        protected override void OnLaunched(LaunchActivatedEventArgs e)
        {
            // On Xbox, UWP defaults to a 4:3-safe scaled view and can show a
            // mouse cursor. Neither is wanted, but every call in this block is
            // a cosmetic view tweak, and the console OS retires these legacy
            // APIs over time: on the June 2026 System OS (10.0.26100) the
            // RequiresPointerMode setter fails with E_NOTSUPPORTED, which the
            // runtime rethrows as NotSupportedException. Unguarded, that killed
            // the app behind the splash on every launch (proved by the Cryptic
            // Realm probe's marker log; same shell architecture), so each tweak
            // is allowed to fail on its own.
            try { ApplicationViewScaling.TrySetDisableLayoutScaling(true); }
            catch (System.Exception) { }
            try { RequiresPointerMode = ApplicationRequiresPointerMode.WhenRequested; }
            catch (System.Exception) { }

            var root = Window.Current.Content as Frame;
            if (root == null)
            {
                root = new Frame();
                Window.Current.Content = root;
            }

            if (root.Content == null)
            {
                root.Navigate(typeof(MainPage), e.Arguments);
            }

            try
            {
                ApplicationView.GetForCurrentView()
                    .SetDesiredBoundsMode(ApplicationViewBoundsMode.UseCoreWindow);
            }
            catch (System.Exception) { }
            Window.Current.Activate();
        }

        private void OnSuspending(object sender, SuspendingEventArgs e)
        {
            // Nothing to persist: all state lives in the web app's localStorage,
            // which the WebView2 user data folder keeps across launches.
            e.SuspendingOperation.GetDeferral().Complete();
        }
    }
}
