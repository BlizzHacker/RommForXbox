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
            // On Xbox, UWP defaults to a 4:3-safe scaled view and shows a mouse
            // cursor. Neither is wanted: the CSS already keeps content inside the
            // title-safe area, and a cursor on a TV looks like a bug.
            ApplicationViewScaling.TrySetDisableLayoutScaling(true);
            RequiresPointerMode = ApplicationRequiresPointerMode.WhenRequested;

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

            ApplicationView.GetForCurrentView()
                .SetDesiredBoundsMode(ApplicationViewBoundsMode.UseCoreWindow);
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
