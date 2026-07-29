/* Bridge to a native host, when there is one.
 *
 * In a browser this file does nothing. Inside the WebView2 UWP shell it is the
 * only way the app can see the controller: the Gamepad API does not reach
 * WebView2 content (MicrosoftEdge/WebView2Feedback#4366), so the shell reads
 * Windows.Gaming.Input and posts state in at ~60 Hz.
 *
 * Message shape from the host:
 *   { t: 'pad', buttons: [bool x16], axes: [number x4] }
 *   { t: 'pad', connected: false }        // controller went away
 */
'use strict';

const HOST = (() => {
  const wv = window.chrome && window.chrome.webview;
  return {
    get present() { return !!wv; },
    // Ask the shell to close. On console the system back gesture is suppressed
    // so B behaves as the app intends, which means leaving has to be explicit.
    exit() {
      if (!wv) return false;
      try { wv.postMessage({ t: 'exit' }); return true; } catch (_) { return false; }
    },
  };
})();

(() => {
  const wv = window.chrome && window.chrome.webview;
  if (!wv) return;                      // plain browser — Gamepad API is fine

  wv.addEventListener('message', e => {
    const m = e.data;
    if (!m || m.t !== 'pad') return;
    GP.setHostState(m.connected === false ? null : m);
  });

  // Tell the host we are ready to receive input. Until this arrives the shell
  // should not bother pumping state.
  try { wv.postMessage({ t: 'ready' }); } catch (_) { /* not fatal */ }

  document.documentElement.classList.add('host-shell');
})();
