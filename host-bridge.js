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

    /* True when a URL must be fetched by native code rather than the renderer.
     *
     * The rule is mixed content, not the scheme on its own: a plain-http URL is
     * blocked in the renderer only when the PAGE is secure. That distinction
     * matters because the shell injects this file into every document,
     * including RomM's own /console pages — and when the user has opted into
     * those, the page itself is served from the http server, so its requests
     * are same-origin and perfectly legal. Routing them through the bridge
     * would be pure overhead on the exact pages that run a game. Read at call
     * time, never cached: an injected copy runs before the document has settled
     * on its URL. */
    needsNative(url) {
      if (!wv) return false;
      if (!/^http:\/\//i.test(String(url || ''))) return false;
      return location.protocol === 'https:';
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

/* Native fetch RPC, streamed.
 *
 * Post {t:'nfetch', id, ...}; the shell answers with one {t:'nfetchHead'}, then
 * ordered {t:'nfetchChunk'} messages, then {t:'nfetchEnd'} — or {t:'nfetchFail'}
 * at any point. Returns a Promise of a Response-like object that settles as soon
 * as the head arrives, so status and headers are readable while the body is
 * still coming in.
 *
 * It streams for one reason: the old protocol base64'd the WHOLE body into a
 * single web message and refused anything over 24MB. That cap is not an edge
 * case on a plain-http LAN server — it is every N64 cartridge, every PSX disc
 * and most EmulatorJS cores, and the page reported the refusal to the user as a
 * CORS problem they could not fix. Chunks become Blob parts as they land and the
 * byte arrays are dropped, so the JS heap never holds more than one chunk;
 * Chromium keeps Blobs on disk, which is what makes a large ROM survivable
 * inside a console app's memory budget.
 */
var nativeFetch = window.__cartNativeFetch || (() => {
  const wv = window.chrome && window.chrome.webview;
  const pending = new Map();
  let seq = 0;

  // Reaching the response headers is either fast or never; a body, once it is
  // flowing, may legitimately take many minutes. So the watchdog is on SILENCE,
  // not on total duration — every message for a request re-arms it. The old
  // flat 20s deadline failed big downloads that were working perfectly.
  const HEAD_SILENCE_MS = 20000;
  const BODY_SILENCE_MS = 45000;

  function b64ToBytes(b64) {
    const bin = atob(b64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  if (wv) {
    wv.addEventListener('message', e => {
      const m = e.data;
      if (!m || typeof m.t !== 'string' || m.t.indexOf('nfetch') !== 0) return;
      const p = pending.get(m.id);
      if (!p) return;
      p.touch(m.t === 'nfetchHead' ? BODY_SILENCE_MS : undefined);
      if (m.t === 'nfetchHead') p.head(m);
      else if (m.t === 'nfetchChunk') {
        p.chunk(m);
        // Flow control. The host holds back until this lands, so a fast server
        // cannot outrun the renderer and fill the message queue — which on a
        // console memory budget is how a big download kills the app.
        try { wv.postMessage({ t: 'nfetchAck', id: m.id }); } catch (_) { }
      }
      else if (m.t === 'nfetchEnd') p.end();
      else if (m.t === 'nfetchFail') p.fail(m);
    });
  }

  function makeResponse(head, state) {
    const headers = new Headers();
    if (head.headers) for (const k in head.headers) {
      try { headers.set(k, head.headers[k]); } catch (_) { /* forbidden header */ }
    }
    const status = head.status || 0;
    const body = async () => new Blob(await state.parts,
      { type: headers.get('content-type') || '' });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: head.statusText || '',
      headers,
      url: head.url || '',
      redirected: false,
      // Progress is delivered through opts.onProgress rather than a
      // ReadableStream: callers that want it ask for it, and nothing has to hold
      // the whole body in the heap to provide it. Callers test r.body to decide,
      // so it stays explicitly null.
      body: null,
      // The shell attaches a machine reason on failure; RomM's client reads it
      // to explain DNS vs TLS vs refused instead of a bare "Failed to fetch".
      nativeReason: null,
      nativeDetail: null,
      blob: body,
      async arrayBuffer() { return (await body()).arrayBuffer(); },
      async text() { return (await body()).text(); },
      async json() { return JSON.parse(await (await body()).text()); },
      clone() { return makeResponse(head, state); },
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

    /* Non-string request bodies.
     *
     * Save states are uploaded as FormData. The old code kept only string
     * bodies and sent '' for anything else, so on a plain-http server every
     * quick-save reached RomM with an EMPTY body, was rejected, and the
     * rejection was swallowed by a catch that exists to keep the game running.
     * The player saw EmulatorJS report a successful save and lost it on quit,
     * with nothing said anywhere. Encoding the body here is what makes save
     * states actually persist on the configuration this bridge exists for.
     *
     * Response() does the multipart encoding, boundary and all, and reports the
     * exact Content-Type that goes with it — which must be the generated one,
     * never a caller-supplied guess, or the boundary will not match. */
    const encodeBody = async () => {
      const b = o.body;
      if (b === undefined || b === null || typeof b === 'string') return;
      const packed = new Response(b);
      const ct = packed.headers.get('content-type');
      if (ct) msg.contentType = ct;
      const bytes = new Uint8Array(await packed.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      msg.bodyBase64 = btoa(bin);
      msg.body = '';
    };

    return new Promise((resolve, reject) => {
      const parts = [];
      let total = 0, got = 0, timer = null, silence = HEAD_SILENCE_MS;
      let settleParts = null, failParts = null;
      const partsDone = new Promise((res, rej) => { settleParts = res; failParts = rej; });
      // Nobody observes partsDone until a caller reads the body, and an
      // unobserved rejection is a console error; this keeps it quiet without
      // swallowing the rejection a real reader is waiting on.
      partsDone.catch(() => { });

      const clear = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        pending.delete(id);
      };

      const entry = {
        touch(next) {
          if (next) silence = next;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            clear();
            const err = new TypeError('the server stopped responding');
            err.nativeReason = 'timeout';
            reject(err);
            failParts(err);
          }, silence);
        },
        head(m) {
          // The shell sends -1 when the server gave no Content-Length (a
          // chunked response). Zero, not -1, is the "unknown" the progress
          // callers expect; -1 would render as a negative percentage.
          total = Number(m.length) > 0 ? Number(m.length) : 0;
          resolve(makeResponse(m, { parts: partsDone }));
          if (o.onProgress) { try { o.onProgress(0, total); } catch (_) { } }
        },
        chunk(m) {
          const bytes = b64ToBytes(m.b64);
          got += bytes.length;
          // Straight into a Blob part; the Uint8Array goes out of scope here.
          parts.push(new Blob([bytes]));
          if (o.onProgress) { try { o.onProgress(got, total); } catch (_) { } }
        },
        end() { clear(); settleParts(parts); },
        fail(m) {
          clear();
          const err = new TypeError(m.detail || 'native fetch failed');
          err.nativeReason = m.reason || 'error';
          err.nativeDetail = m.detail || '';
          reject(err);              // a no-op if the head already resolved us
          failParts(err);
        },
      };

      pending.set(id, entry);
      entry.touch();
      encodeBody().then(() => {
        wv2.postMessage(msg);
      }).catch(err => { clear(); reject(err); failParts(err); });
    });
  };
})();
window.__cartNativeFetch = nativeFetch;

/* When EmulatorJS cannot get a core from the user's own server it silently
 * retries against cdn.emulatorjs.org and carries on. That is genuinely useful
 * when a server is missing a core — but it also means a broken local path looks
 * like a working one, which is exactly how this class of bug stays
 * misdiagnosed, and it is a third-party download an app that says it only talks
 * to your own server should not make quietly. Counted, not blocked: Diagnostics
 * reports it, so "it works for me" stops being unfalsifiable. */
window.__cartCdnHits = window.__cartCdnHits || 0;
function countIfThirdParty(url) {
  try {
    if (/(^|\/\/|\.)cdn\.emulatorjs\.org\//i.test(String(url || ''))) {
      window.__cartCdnHits++;
    }
  } catch (_) { /* counting must never break a request */ }
}

/* EmulatorJS fetches cores and ROM bytes with its own calls, which we do not
 * route. On a plain-http server those are mixed-content-blocked. So inside the
 * shell, wrap window.fetch: http URLs go native, everything else is untouched.
 * Installed once; https servers never hit the native branch. */
(() => {
  const wv = window.chrome && window.chrome.webview;
  if (!wv || window.fetch.__cartWrapped) return;
  const orig = window.fetch.bind(window);
  const wrapped = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    countIfThirdParty(url);
    if (HOST.needsNative(url)) return nativeFetch(url, init || {});
    return orig(input, init);
  };
  wrapped.__cartWrapped = true;
  wrapped.__cartOriginal = orig;
  window.fetch = wrapped;
})();

/* ...and the same for XMLHttpRequest, which is not a detail.
 *
 * EmulatorJS downloads every core, BIOS and localization file through XHR, not
 * fetch: its downloadFile() only takes the fetch branch for non-http protocols
 * such as blob:. So wrapping fetch alone still left every core download on a
 * plain-http server as active mixed content — blocked in the renderer, invisible
 * to the native bridge, and reported to the user as a CORS problem. This shim
 * covers exactly the surface EmulatorJS uses (open / send / responseType /
 * status / response / getResponseHeader / progress / load / error) and hands
 * everything else, including every https and same-origin request, to the real
 * XMLHttpRequest untouched. */
(() => {
  const wv = window.chrome && window.chrome.webview;
  if (!wv || window.__cartXhrWrapped) return;
  window.__cartXhrWrapped = true;
  const Real = window.XMLHttpRequest;

  function NativeBackedXHR() {
    const self = this;
    let native = null;                 // set by open() when the URL is http
    // The delegate is built only if we actually hand the request over. Building
    // one for every instance would open a real XHR for every core download the
    // native path is about to serve, and would make this whole shim untestable
    // outside a browser.
    let real = null;
    const listeners = {
      progress: [], load: [], error: [], loadend: [], readystatechange: [],
    };
    const realXhr = () => {
      if (!real) real = new Real();
      return real;
    };
    self.readyState = 0;
    self.status = 0;
    self.statusText = '';
    self.response = null;
    self.responseText = '';
    self.responseType = '';
    self.timeout = 0;
    self.withCredentials = false;
    self.onload = null; self.onerror = null; self.onprogress = null;
    self.onreadystatechange = null; self.onloadend = null;

    const emit = (type, ev) => {
      const h = self['on' + type];
      if (typeof h === 'function') { try { h.call(self, ev); } catch (_) { } }
      for (const fn of listeners[type] || []) { try { fn.call(self, ev); } catch (_) { } }
    };
    const setState = n => {
      self.readyState = n;
      emit('readystatechange', { type: 'readystatechange' });
    };

    /* One registry, one dispatcher.
     *
     * Listeners live here and ONLY here — they are never also attached to the
     * delegate. On the pass-through path send() hooks the delegate's on* slots
     * and funnels them into emit(), so a listener attached to both would be
     * called twice for every event: two 'load's for one response, and every
     * progress event doubled. That path carries all https traffic in the shell
     * and all of RomM's own /console pages, so it is the common case, not an
     * edge one. */
    self.addEventListener = (type, fn) => {
      if (listeners[type]) listeners[type].push(fn);
    };
    self.removeEventListener = (type, fn) => {
      const a = listeners[type];
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    };

    self.open = function (method, url, async) {
      countIfThirdParty(url);
      native = HOST.needsNative(url) ? { method, url } : null;
      if (native) { setState(1); return; }
      return realXhr().open(method, url, async === undefined ? true : async);
    };

    self.setRequestHeader = function (k, v) {
      if (!native) return realXhr().setRequestHeader(k, v);
      (native.headers || (native.headers = {}))[k] = v;
    };

    self.getResponseHeader = function (name) {
      if (!native) return realXhr().getResponseHeader(name);
      return native.out ? (native.out.get(name) || null) : null;
    };
    self.getAllResponseHeaders = function () {
      if (!native) return realXhr().getAllResponseHeaders();
      if (!native.out) return '';
      let out = '';
      native.out.forEach((v, k) => { out += k + ': ' + v + '\r\n'; });
      return out;
    };
    self.abort = function () {
      if (native) native.aborted = true;
      else if (real) real.abort();
    };
    self.overrideMimeType = function (m) {
      if (!native) realXhr().overrideMimeType(m);
    };

    self.send = function (body) {
      if (!native) {
        const r = realXhr();
        // Mirror the delegate's state onto ours as it progresses, so a caller
        // reading properties off this wrapper sees the truth.
        const sync = () => {
          self.readyState = r.readyState; self.status = r.status;
          self.statusText = r.statusText;
          try { self.response = r.response; } catch (_) { }
          try { self.responseText = r.responseText; } catch (_) { }
        };
        try { r.responseType = self.responseType; } catch (_) { }
        r.onreadystatechange = e => { sync(); emit('readystatechange', e); };
        r.onprogress = e => emit('progress', e);
        r.onload = e => { sync(); emit('load', e); };
        r.onerror = e => { sync(); emit('error', e); };
        r.onloadend = e => { sync(); emit('loadend', e); };
        return r.send(body);
      }

      nativeFetch(native.url, {
        method: native.method,
        headers: native.headers || {},
        body: typeof body === 'string' ? body : '',
        onProgress: (loaded, totalBytes) => {
          emit('progress', {
            type: 'progress', loaded, total: totalBytes,
            lengthComputable: totalBytes > 0,
          });
        },
      }).then(async r => {
        if (native.aborted) return;
        native.out = r.headers;
        self.status = r.status;
        self.statusText = r.statusText;
        setState(2);
        const wanted = String(self.responseType || '').toLowerCase();
        if (wanted === 'arraybuffer') self.response = await r.arrayBuffer();
        else if (wanted === 'blob') self.response = await r.blob();
        else if (wanted === 'json') self.response = await r.json().catch(() => null);
        else {
          const text = await r.text();
          self.response = text;
          self.responseText = text;
        }
        if (native.aborted) return;
        setState(4);
        emit('load', { type: 'load' });
        emit('loadend', { type: 'loadend' });
      }).catch(err => {
        if (native.aborted) return;
        self.status = 0;
        self.nativeReason = (err && err.nativeReason) || 'error';
        setState(4);
        emit('error', { type: 'error' });
        emit('loadend', { type: 'loadend' });
      });
    };
  }

  NativeBackedXHR.UNSENT = 0;
  NativeBackedXHR.OPENED = 1;
  NativeBackedXHR.HEADERS_RECEIVED = 2;
  NativeBackedXHR.LOADING = 3;
  NativeBackedXHR.DONE = 4;
  NativeBackedXHR.prototype.UNSENT = 0;
  NativeBackedXHR.prototype.OPENED = 1;
  NativeBackedXHR.prototype.HEADERS_RECEIVED = 2;
  NativeBackedXHR.prototype.LOADING = 3;
  NativeBackedXHR.prototype.DONE = 4;
  NativeBackedXHR.__cartOriginal = Real;
  window.XMLHttpRequest = NativeBackedXHR;
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

  // Dev-only live controller overlay (marker-gated via __CARTRIDGE_DEVTOOLS).
  // Present on EVERY page including the play screen, so a tester can see the
  // pad register in real time next to the game reacting. Never shown in a
  // shipped Store build (no marker -> flag false). Purely additive; if anything
  // here throws it must not touch the input path.
  try {
    if (window.__CARTRIDGE_DEVTOOLS && !window.__cartPadOverlay) {
      window.__cartPadOverlay = true;
      const add = () => {
        if (!document.body) return void requestAnimationFrame(add);
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;'
          + 'font:12px/1.4 monospace;color:#7fe3a1;background:rgba(0,0,0,.6);'
          + 'padding:4px 8px;border-radius:6px;pointer-events:none;white-space:pre';
        document.body.appendChild(el);
        setInterval(() => {
          const p = (navigator.getGamepads ? [...navigator.getGamepads()] : [])
            .filter(Boolean)[0];
          if (!p) { el.textContent = 'pad: none'; return; }
          const pressed = p.buttons.map((b, i) => b.pressed ? i : -1)
            .filter(i => i >= 0).join(',');
          const ax = p.axes.map(a => a.toFixed(1)).join(' ');
          el.textContent = 'pad ok  btn[' + pressed + ']  ax ' + ax;
        }, 100);
      };
      add();
    }
  } catch (_) { /* diagnostics must never break input */ }
})();
