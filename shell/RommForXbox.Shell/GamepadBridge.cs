using System;
using System.Globalization;
using System.Linq;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Windows.Gaming.Input;
using Windows.UI.Xaml.Media;

namespace RommForXbox.Shell
{
    /// <summary>
    /// Feeds controller state to the web app.
    ///
    /// The Gamepad API does not reach WebView2 content on UWP
    /// (MicrosoftEdge/WebView2Feedback#4366 — open since Feb 2024, no documented
    /// workaround), so the host reads Windows.Gaming.Input itself and posts the
    /// same shape the page would have got from navigator.getGamepads().
    ///
    /// Button order matches the Standard Gamepad mapping, because gamepad.js
    /// indexes by it and treats host state and a real Gamepad as interchangeable.
    /// </summary>
    internal sealed class GamepadBridge
    {
        private CoreWebView2 _web;
        private bool _running;
        private string _lastPayload;
        private bool _lastConnected;

        public void Start(CoreWebView2 web)
        {
            if (_running) return;
            _web = web;
            _running = true;
            // Driven off the compositor rather than a timer: it is already the
            // ~60 Hz the page polls at, and it stops while suspended.
            CompositionTarget.Rendering += OnRendering;
        }

        public void Stop()
        {
            if (!_running) return;
            CompositionTarget.Rendering -= OnRendering;
            _running = false;
        }

        private void OnRendering(object sender, object e)
        {
            var pad = Gamepad.Gamepads.FirstOrDefault();
            if (pad == null)
            {
                if (_lastConnected)
                {
                    _lastConnected = false;
                    _lastPayload = null;
                    Post("{\"t\":\"pad\",\"connected\":false}");
                }
                return;
            }

            _lastConnected = true;
            var payload = Serialize(pad.GetCurrentReading());
            // Only send on change. Holding a button otherwise posts an identical
            // message every frame, and each one crosses a process boundary.
            if (payload == _lastPayload) return;
            _lastPayload = payload;
            Post(payload);
        }

        private static string Serialize(GamepadReading r)
        {
            var b = r.Buttons;
            bool Down(GamepadButtons flag) => (b & flag) == flag;

            // Standard Gamepad mapping order.
            var buttons = new[]
            {
                Down(GamepadButtons.A),
                Down(GamepadButtons.B),
                Down(GamepadButtons.X),
                Down(GamepadButtons.Y),
                Down(GamepadButtons.LeftShoulder),
                Down(GamepadButtons.RightShoulder),
                r.LeftTrigger > 0.5,
                r.RightTrigger > 0.5,
                Down(GamepadButtons.View),        // "select"
                Down(GamepadButtons.Menu),        // "start"
                Down(GamepadButtons.LeftThumbstick),
                Down(GamepadButtons.RightThumbstick),
                Down(GamepadButtons.DPadUp),
                Down(GamepadButtons.DPadDown),
                Down(GamepadButtons.DPadLeft),
                Down(GamepadButtons.DPadRight),
            };

            var sb = new StringBuilder("{\"t\":\"pad\",\"connected\":true,\"buttons\":[");
            for (var i = 0; i < buttons.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(buttons[i] ? "true" : "false");
            }
            // The Gamepad API's Y axis points the opposite way to
            // Windows.Gaming.Input: stick up is -1 there and +1 here.
            sb.Append("],\"axes\":[")
              .Append(Num(r.LeftThumbstickX)).Append(',')
              .Append(Num(-r.LeftThumbstickY)).Append(',')
              .Append(Num(r.RightThumbstickX)).Append(',')
              .Append(Num(-r.RightThumbstickY))
              .Append("]}");
            return sb.ToString();
        }

        private static string Num(double v)
        {
            // Invariant culture: a comma decimal separator would produce invalid
            // JSON on a console set to a European locale.
            return Math.Round(v, 3).ToString("0.###", CultureInfo.InvariantCulture);
        }

        private void Post(string json)
        {
            try
            {
                _web.PostWebMessageAsJson(json);
            }
            catch (Exception)
            {
                // The WebView can be torn down between frames; input is not worth
                // taking the app down for.
                Stop();
            }
        }
    }
}
