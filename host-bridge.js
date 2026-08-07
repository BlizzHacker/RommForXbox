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

    /* The URL a request should actually be sent to. Left unchanged now: https
     * goes direct (RomM reflects our Origin), and http goes through fetch()
     * below via the native bridge, so nothing needs rewriting. Kept as an
     * identity function because callers and EmulatorJS pass base URLs through
     * it and append their own paths. */
    route(url) { return url; },

    // True when a URL must be fetched by native code rather than the renderer:
    // inside the shell, a plain-http URL is active mixed content and the
    // renderer blocks it before any script runs. https is always direct.
    needsNative(url) {
      return !!wv && /^http:\/\//i.test(String(url || ''));
    },

    /* fetch() the renderer can rely on for any RomM URL. https resolves to the
     * platform fetch (direct, fast, streaming). http on the console is handed
     * to native code, which has no mixed-content rule, and the full response
     * comes back over the web-message channel as a Response-like object. This
     * is the ONLY http path; the dead WebResourceRequested proxy is gone. */
    fetch(url, opts) {
      if (this.needsNative(url)) return nativeFetch(url, opts || {});
      // Prefer the unwrapped fetch when the http-shim installed one, so an
      // https call is not re-inspected; fall back to plain fetch otherwise.
      const f = (window.fetch && window.fetch.__cartOriginal) || window.fetch;
      return f.call(window, url, opts);
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

/* Native fetch RPC: post {t:'nfetch',...}, resolve when the matching
 * {t:'nfetchResult', id} message arrives. Returns a Promise of a Response-like
 * object with the methods RomM's client and EmulatorJS use. The shell caps the
 * body (24MB) so this is for the JSON API, pairing, cores, and cartridge-sized
 * ROMs; disc images exceed the cap and are served from the https stream server.
 */
var nativeFetch = window.__cartNativeFetch || (() => {
  const wv = window.chrome && window.chrome.webview;
  const pending = new Map();
  let seq = 0;

  if (wv) {
    wv.addEventListener('message', e => {
      const m = e.data;
      if (!m || m.t !== 'nfetchResult') return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      p(m);
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function makeResponse(msg) {
    const bytes = msg.ok ? b64ToBytes(msg.bodyBase64) : new Uint8Array(0);
    const headers = new Headers();
    if (msg.headers) for (const k in msg.headers) {
      try { headers.set(k, msg.headers[k]); } catch (_) { /* forbidden header */ }
    }
    const status = msg.ok ? (msg.status || 200) : 0;
    return {
      ok: msg.ok && status >= 200 && status < 300,
      status,
      statusText: msg.statusText || '',
      headers,
      url: msg.url || '',
      redirected: false,
      // The shell attaches a machine reason on failure; RomM's client reads it
      // to explain DNS vs TLS vs refused instead of a bare "Failed to fetch".
      nativeReason: msg.ok ? null : (msg.reason || 'error'),
      nativeDetail: msg.ok ? null : (msg.detail || ''),
      async arrayBuffer() { return bytes.buffer.slice(0); },
      async blob() {
        return new Blob([bytes], { type: headers.get('content-type') || '' });
      },
      async text() { return new TextDecoder().decode(bytes); },
      async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
      clone() { return makeResponse(msg); },
    };
  }

  return function nativeFetch(url, opts) {
    const wv2 = window.chrome && window.chrome.webview;
    if (!wv2) return Promise.reject(new TypeError('no native host'));
    const id = 'nf' + (++seq) + '_' + Date.now();
    const o = opts || {};
    const headers = {};
    if (o.headers) {
      if (o.headers instanceof Headers) o.headers.forEach((v, k) => { headers[k] = v; });
      else if (Array.isArray(o.headers)) o.headers.forEach(([k, v]) => { headers[k] = v; });
      else for (const k in o.headers) headers[k] = o.headers[k];
    }
    const msg = {
      t: 'nfetch', id, url: String(url), method: (o.method || 'GET').toUpperCase(),
      headers,
      body: typeof o.body === 'string' ? o.body : '',
      contentType: headers['Content-Type'] || headers['content-type'] || 'application/json',
    };
    return new Promise((resolve, reject) => {
      pending.set(id, m => {
        if (m.ok || typeof m.status === 'number') resolve(makeResponse(m));
        else {
          const err = new TypeError(m.detail || 'native fetch failed');
          err.nativeReason = m.reason || 'error';
          reject(err);
        }
      });
      try { wv2.postMessage(msg); }
      catch (err) { pending.delete(id); reject(err); }
      // Safety net: the shell always replies, but never hang forever.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          const err = new TypeError('native fetch timed out');
          err.nativeReason = 'timeout';
          reject(err);
        }
      }, 20000);
    });
  };
})();
window.__cartNativeFetch = nativeFetch;

/* EmulatorJS fetches cores and ROM bytes with its own window.fetch calls, which
 * we do not route. On a plain-http server those are mixed-content-blocked. So
 * inside the shell, wrap window.fetch: http URLs go native, everything else is
 * untouched. Installed once; https servers never hit the native branch. */
(() => {
  const wv = window.chrome && window.chrome.webview;
  if (!wv || window.fetch.__cartWrapped) return;
  const orig = window.fetch.bind(window);
  const wrapped = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/^http:\/\//i.test(url)) return nativeFetch(url, init || {});
    return orig(input, init);
  };
  wrapped.__cartWrapped = true;
  wrapped.__cartOriginal = orig;
  window.fetch = wrapped;
})();

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
