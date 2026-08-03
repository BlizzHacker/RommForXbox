/* Bridge to a native host, when there is one.
 *
 * In a browser this file does almost nothing. Inside the WebView2 UWP shell it
 * supplies the three things the page cannot get for itself:
 *
 *   * the controller — the Gamepad API does not reach WebView2 content
 *     (MicrosoftEdge/WebView2Feedback#4366), so the shell reads
 *     Windows.Gaming.Input and posts state in at ~60 Hz;
 *   * a reachable server — see route() below;
 *   * a way to close, since the shell has to swallow the console's back gesture.
 *
 * Message shape from the host:
 *   { t: 'pad', buttons: [bool x16], axes: [number x4] }
 *   { t: 'pad', connected: false }        // controller went away
 */
'use strict';

/* Loaded twice by design: as a script tag by the packaged pages, and injected
 * by the shell into EVERY document (AddScriptToExecuteOnDocumentCreated) so
 * the controller also reaches RomM's own /console pages, where EmulatorJS
 * polls navigator.getGamepads() and would otherwise see nothing. var plus the
 * window.HOST reuse makes the second load a no-op. */
var HOST = window.HOST || (() => {
  const wv = window.chrome && window.chrome.webview;

  return {
    get present() { return !!wv; },

    /* Rewrites a server URL to the same-origin path the shell unwraps.
     *
     * The packaged page is served from https://app.local so it stays a secure
     * context (WebRTC needs one). That leaves a plain-http RomM — which is what
     * most self-hosted boxes on a LAN are — unreachable: an https page fetching
     * http:// is active mixed content, blocked inside the renderer before the
     * host could intercept it. Routing through our own origin sidesteps both
     * that and CORS.
     *
     *   http://192.168.1.42/api/roms  ->  <origin>/__romm/http/192.168.1.42/api/roms
     *
     * The target stays readable path segments so that relative joining still
     * works — EmulatorJS appends its own filenames to whatever base it is given.
     *
     * https targets are NOT rewritten: on the Xbox shell WebResourceRequested
     * never fires (the UWP WebView2 does not deliver it), so a routed request
     * lands on the packaged origin's 404 instead of the proxy. An https server
     * is reachable directly — RomM's API reflects the caller's Origin — and the
     * direct path is also faster, so the proxy is reserved for the http case
     * it alone can solve (and which only works where the event fires).
     */
    route(url) {
      if (!wv || !url) return url;
      const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(url);
      if (!m) return url;
      if (m[1].toLowerCase() === 'https') return url;
      return location.origin + '/__romm/' + m[1].toLowerCase() + '/' + m[2] + m[3];
    },

    // Ask the shell to close. The console's back gesture is suppressed so B
    // behaves as the app intends, which means leaving has to be explicit.
    exit() {
      if (!wv) return false;
      try { wv.postMessage({ t: 'exit' }); return true; } catch (_) { return false; }
    },
  };
})();
window.HOST = HOST;

(() => {
  if (window.__cartridgeBridgeWired) return;
  window.__cartridgeBridgeWired = true;
  const wv = window.chrome && window.chrome.webview;
  if (!wv) return;                      // plain browser — Gamepad API is fine

  let live = null;                      // newest host state, or null

  /* EmulatorJS polls navigator.getGamepads() itself, and that returns nothing
   * in WebView2 — a game would load and sit there unresponsive. Rather than
   * translate the pad into synthetic key events and guess at EmulatorJS's
   * default bindings, present host state *as* a Gamepad: EmulatorJS then works
   * as designed, including its own remapping UI. */
  const PAD_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)';
  const nativeGetGamepads = navigator.getGamepads
    ? navigator.getGamepads.bind(navigator) : () => [];

  function asGamepad(s) {
    const buttons = (s.buttons || []).map(b => {
      const pressed = typeof b === 'object' ? !!b.pressed : !!b;
      return { pressed, touched: pressed, value: pressed ? 1 : 0 };
    });
    return {
      id: PAD_ID, index: 0, connected: true, mapping: 'standard',
      timestamp: performance.now(),
      axes: (s.axes || []).slice(0, 4),
      buttons,
      hapticActuators: [], vibrationActuator: null,
    };
  }

  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => (live ? [asGamepad(live)] : nativeGetGamepads()),
  });

  // Consumers wait for this before they start polling.
  function announce(type, pad) {
    const ev = new Event(type);
    ev.gamepad = pad;
    window.dispatchEvent(ev);
  }

  wv.addEventListener('message', e => {
    const m = e.data;
    if (!m || m.t !== 'pad') return;
    const gone = m.connected === false;
    const had = !!live;
    live = gone ? null : m;
    // This file must load after gamepad.js: 'ready' is posted below during load,
    // and the host can answer with state before a later script has defined GP.
    if (typeof GP !== 'undefined') GP.setHostState(live);
    if (!had && live) announce('gamepadconnected', asGamepad(live));
    else if (had && !live) announce('gamepaddisconnected', { index: 0, id: PAD_ID });
  });

  // Tell the host we are ready to receive input. Until this arrives the shell
  // should not bother pumping state.
  try { wv.postMessage({ t: 'ready' }); } catch (_) { /* not fatal */ }

  // Injected copies run at document-create, where documentElement can be
  // absent; the class is cosmetic, so never let it break the bridge.
  try { document.documentElement.classList.add('host-shell'); } catch (_) { }
})();
