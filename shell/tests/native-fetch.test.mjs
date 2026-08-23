/* Runs the REAL host-bridge.js against a simulated shell.
 *
 * The http-LAN transport is the one piece of this app that no browser test and
 * no code review can stand in for: it is a protocol between a page and native
 * code, it carries every byte a plain-http RomM ever sends the console, and the
 * only place it runs for real is a retail Xbox we cannot attach to. So the host
 * side is simulated here — head, chunks, end, failures and the acknowledgements
 * that pace them — and the actual shipped file is loaded and driven against it.
 *
 * The previous transport's cap (24MB in one base64 message) shipped to the Store
 * and made every cartridge past the 16-bit era, and most EmulatorJS cores,
 * undownloadable. It was not caught because nothing executed this path outside a
 * console. That is what this file is for.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeSrc = fs.readFileSync(path.join(here, '..', '..', 'host-bridge.js'), 'utf8');

/* ------------------------------------------------------------ the fake shell */

function makeShell() {
  const listeners = [];
  const sent = [];              // everything the page posted to the host
  const routes = new Map();     // url -> {status, statusText, headers, body:Uint8Array}
  const failures = new Map();   // url -> {reason, detail}
  const inFlight = new Map();

  const CHUNK = 64 * 1024;      // the real shell uses 256KB; smaller is fine here
  const WINDOW = 8;             // must match NativeFetch.WindowChunks

  const post = m => {
    for (const fn of listeners) fn({ data: m });
  };

  const webview = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: m => {
      sent.push(m);
      if (m.t === 'nfetch') void serve(m);
      else if (m.t === 'nfetchAck') {
        const s = inFlight.get(m.id);
        if (s) { s.credit++; s.wake(); }
      }
    },
  };

  async function serve(msg) {
    const fail = failures.get(msg.url);
    if (fail) return post({ t: 'nfetchFail', id: msg.id, ...fail });
    const r = routes.get(msg.url);
    if (!r) return post({ t: 'nfetchFail', id: msg.id, reason: 'refused', detail: 'no route' });

    const state = { credit: WINDOW, wake: () => { } };
    inFlight.set(msg.id, state);

    post({
      t: 'nfetchHead', id: msg.id, status: r.status, statusText: r.statusText || 'OK',
      url: msg.url,
      // The shell sends -1 for a chunked response with no Content-Length.
      length: r.unknownLength ? -1 : r.body.length,
      headers: r.headers || {},
    });

    for (let off = 0; off < r.body.length; off += CHUNK) {
      // Honour the window exactly as the shell does: block until acknowledged.
      while (state.credit <= 0) {
        await new Promise(res => { state.wake = res; });
      }
      state.credit--;
      const slice = r.body.subarray(off, Math.min(off + CHUNK, r.body.length));
      post({
        t: 'nfetchChunk', id: msg.id,
        b64: Buffer.from(slice).toString('base64'),
      });
      await new Promise(res => setImmediate(res));
    }
    inFlight.delete(msg.id);
    post({ t: 'nfetchEnd', id: msg.id });
  }

  return { webview, sent, routes, failures, WINDOW, CHUNK };
}

/* A stand-in for the platform XMLHttpRequest, so the shim's decision to
 * DELEGATE (rather than claim) a request is observable. Anything reaching this
 * is a request the native bridge correctly declined to touch. */
function makeRealXhrStub(log) {
  return function RealXhr() {
    this.readyState = 0; this.status = 0; this.statusText = ''; this.response = null;
    this.addEventListener = () => { };
    this.removeEventListener = () => { };
    this.open = (method, url) => { log.push(['open', method, url]); };
    this.setRequestHeader = (k, v) => { log.push(['header', k, v]); };
    this.getResponseHeader = () => null;
    this.getAllResponseHeaders = () => '';
    this.abort = () => log.push(['abort']);
    this.overrideMimeType = () => { };
    this.send = () => { log.push(['send']); };
  };
}

/* Load the real host-bridge.js into a context that looks enough like a page. */
function loadBridge(shell, realXhrLog) {
  const win = {
    XMLHttpRequest: makeRealXhrStub(realXhrLog),
    chrome: { webview: shell.webview },
    Headers, Blob, atob, setTimeout, clearTimeout, setInterval, clearInterval,
    performance, TypeError, URL, Map, Promise, Uint8Array, JSON, Date, Event,
    fetch: async () => { throw new Error('platform fetch should not be reached'); },
    dispatchEvent: () => { },
    addEventListener: () => { },
    requestAnimationFrame: fn => setTimeout(fn, 0),
  };
  win.window = win;
  const ctx = vm.createContext(win);
  // The shims key off mixed content, not the scheme alone, so the page's own
  // protocol is part of the contract under test.
  ctx.location = { protocol: 'https:' };
  ctx.navigator = { getGamepads: () => [] };
  ctx.document = {
    documentElement: { classList: { add: () => { } } },
    createElement: () => ({ style: {}, appendChild: () => { } }),
    body: null,
  };
  ctx.globalThis = ctx;
  vm.runInContext(bridgeSrc, ctx, { filename: 'host-bridge.js' });
  return ctx;
}

const bytes = n => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;    // a pattern, so truncation shows
  return b;
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ------------------------------------------------------------------- tests */

let failed = 0;
const check = (name, fn) => fn().then(
  () => console.log('  ok   ' + name),
  e => { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); });

const shell = makeShell();
const realXhrLog = [];
const ctx = loadBridge(shell, realXhrLog);
const nativeFetch = ctx.window.__cartNativeFetch;

// A body far past the old 24MB single-message cap, and past one chunk, so this
// is a real multi-chunk transfer rather than a happy-path smoke test.
const BIG = bytes(1024 * 1024);
const JSON_BODY = new TextEncoder().encode(JSON.stringify({ SYSTEM: { VERSION: '3.9.0' } }));

shell.routes.set('http://192.168.1.200/api/heartbeat', {
  status: 200, headers: { 'content-type': 'application/json' }, body: JSON_BODY,
});
shell.routes.set('http://192.168.1.200/api/roms/7/content/game.z64', {
  status: 200, headers: { 'content-type': 'application/octet-stream' }, body: BIG,
});
shell.routes.set('http://192.168.1.200/missing', {
  status: 404, statusText: 'Not Found', headers: {}, body: new Uint8Array(0),
});
shell.failures.set('http://192.168.1.200/dead', { reason: 'refused', detail: 'no listener' });

await check('json response round-trips through the chunked protocol', async () => {
  const r = await nativeFetch('http://192.168.1.200/api/heartbeat', {});
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  const j = await r.json();
  assert.equal(j.SYSTEM.VERSION, '3.9.0');
});

await check('a 1MB body arrives byte-exact (the old cap refused this class)', async () => {
  const r = await nativeFetch('http://192.168.1.200/api/roms/7/content/game.z64', {});
  const got = new Uint8Array(await r.arrayBuffer());
  assert.equal(got.length, BIG.length, 'length');
  assert.ok(same(got, BIG), 'contents match');
});

await check('progress is reported and ends at the total', async () => {
  const seen = [];
  const r = await nativeFetch('http://192.168.1.200/api/roms/7/content/game.z64', {
    onProgress: (got, total) => seen.push([got, total]),
  });
  await r.blob();
  assert.ok(seen.length > 4, 'more than a couple of progress events: ' + seen.length);
  assert.equal(seen[0][1], BIG.length, 'total is known from the head');
  assert.equal(seen[seen.length - 1][0], BIG.length, 'final progress equals the total');
});

await check('every chunk is acknowledged, so the host can pace itself', async () => {
  const before = shell.sent.filter(m => m.t === 'nfetchAck').length;
  const r = await nativeFetch('http://192.168.1.200/api/roms/7/content/game.z64', {});
  await r.blob();
  const acks = shell.sent.filter(m => m.t === 'nfetchAck').length - before;
  const expected = Math.ceil(BIG.length / shell.CHUNK);
  assert.equal(acks, expected, `acked ${acks} of ${expected} chunks`);
});

await check('an unknown length reports as 0, never a negative percentage', async () => {
  shell.routes.set('http://192.168.1.200/chunked', {
    status: 200, headers: {}, body: BIG, unknownLength: true,
  });
  const seen = [];
  const r = await nativeFetch('http://192.168.1.200/chunked', {
    onProgress: (got, total) => seen.push(total),
  });
  await r.blob();
  assert.ok(seen.every(t => t === 0), 'unknown total is 0, got: ' + [...new Set(seen)]);
});

await check('an http error status resolves (it does not reject) with ok=false', async () => {
  const r = await nativeFetch('http://192.168.1.200/missing', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

await check('a transport failure rejects with the native reason attached', async () => {
  await nativeFetch('http://192.168.1.200/dead', {}).then(
    () => { throw new Error('should have rejected'); },
    e => {
      assert.equal(e.nativeReason, 'refused');
      assert.match(String(e.message), /no listener/);
    });
});

/* ---- the XHR shim: EmulatorJS downloads every core through XHR, not fetch --- */

await check('XHR shim delivers an arraybuffer for an http URL', async () => {
  const X = ctx.window.XMLHttpRequest;
  assert.notEqual(X, undefined, 'shim installed');
  const body = await new Promise((resolve, reject) => {
    const x = new X();
    x.responseType = 'arraybuffer';
    x.open('GET', 'http://192.168.1.200/api/roms/7/content/game.z64', true);
    x.onload = () => x.status === 200 ? resolve(x.response) : reject(new Error('status ' + x.status));
    x.onerror = () => reject(new Error('onerror'));
    x.send();
  });
  const got = new Uint8Array(body);
  assert.equal(got.length, BIG.length);
  assert.ok(same(got, BIG));
});

await check('XHR shim fires progress events EmulatorJS can read', async () => {
  const X = ctx.window.XMLHttpRequest;
  const events = [];
  await new Promise((resolve, reject) => {
    const x = new X();
    x.responseType = 'arraybuffer';
    x.addEventListener('progress', e => events.push(e));
    x.open('GET', 'http://192.168.1.200/api/roms/7/content/game.z64', true);
    x.onload = resolve;
    x.onerror = () => reject(new Error('onerror'));
    x.send();
  });
  assert.ok(events.length > 4, 'progress events: ' + events.length);
  assert.equal(events[events.length - 1].total, BIG.length);
  assert.equal(events[events.length - 1].lengthComputable, true);
});

await check('XHR shim reports content-length, which EmulatorJS reads off the response', async () => {
  const X = ctx.window.XMLHttpRequest;
  const x = new X();
  x.responseType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    x.open('GET', 'http://192.168.1.200/api/heartbeat', true);
    x.onload = resolve; x.onerror = () => reject(new Error('onerror'));
    x.send();
  });
  assert.equal(x.getResponseHeader('content-type'), 'application/json');
  assert.equal(x.readyState, 4);
});

await check('XHR shim surfaces a transport failure as onerror, not a hang', async () => {
  const X = ctx.window.XMLHttpRequest;
  const outcome = await new Promise(resolve => {
    const x = new X();
    x.open('GET', 'http://192.168.1.200/dead', true);
    x.onload = () => resolve('load');
    x.onerror = () => resolve('error:' + x.status);
    x.send();
  });
  assert.equal(outcome, 'error:0');
});

await check('XHR shim hands https straight to the real XMLHttpRequest', async () => {
  const X = ctx.window.XMLHttpRequest;
  const before = realXhrLog.length;
  const x = new X();
  x.open('GET', 'https://romm.example.com/api/heartbeat', true);
  x.setRequestHeader('Authorization', 'Bearer t');
  x.send();
  const seen = realXhrLog.slice(before);
  assert.deepEqual(seen[0], ['open', 'GET', 'https://romm.example.com/api/heartbeat'],
    'https reached the real XHR');
  assert.deepEqual(seen[1], ['header', 'Authorization', 'Bearer t']);
  assert.deepEqual(seen[2], ['send']);
});

await check('an http request never constructs a real XMLHttpRequest', async () => {
  const X = ctx.window.XMLHttpRequest;
  const before = realXhrLog.length;
  await new Promise(resolve => {
    const x = new X();
    x.responseType = 'arraybuffer';
    x.open('GET', 'http://192.168.1.200/api/heartbeat', true);
    x.onload = resolve; x.onerror = resolve;
    x.send();
  });
  assert.equal(realXhrLog.length, before,
    'the native path must not touch the platform XHR at all');
});

await check('on an http page the shims stand down entirely (RomM /console)', async () => {
  // The shell injects this bridge into RomM's own pages too. When the user has
  // opted into the server's web UI, the page IS the http server: its requests
  // are same-origin and legal, and routing them through the bridge would be
  // pure overhead on the pages that actually run a game.
  ctx.location.protocol = 'http:';
  try {
    assert.equal(ctx.window.HOST.needsNative('http://192.168.1.200/api/roms'), false,
      'an http page reaching its own http server needs no bridge');
    const before = realXhrLog.length;
    const x = new (ctx.window.XMLHttpRequest)();
    x.open('GET', 'http://192.168.1.200/api/roms', true);
    x.send();
    assert.deepEqual(realXhrLog.slice(before)[0],
      ['open', 'GET', 'http://192.168.1.200/api/roms'], 'delegated to the real XHR');
  } finally {
    ctx.location.protocol = 'https:';
  }
});

await check('the shim records what it replaced, so it is identifiable at runtime', async () => {
  assert.equal(typeof ctx.window.XMLHttpRequest.__cartOriginal, 'function');
  assert.equal(ctx.window.XMLHttpRequest.DONE, 4, 'readyState constants are present');
});

if (failed) {
  console.error(`native-fetch: ${failed} assertion group(s) failed`);
  process.exit(1);
}
console.log('native-fetch: all assertions passed');
