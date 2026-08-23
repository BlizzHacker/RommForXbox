// Pure-logic tests for the http-LAN bridge and error mapping. No console needed;
// these pin the behavior the setup screen depends on so a regression fails CI
// rather than a tester's living room.
import assert from 'node:assert';

// --- config candidate ordering (mirrors config.js) ---
function isLanHost(host) {
  return /^(10\.|127\.|169\.254\.|192\.168\.)/.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || /\.local$/i.test(host) || !host.includes('.');
}
function candidates(raw) {
  const s = (raw || '').trim().replace(/\/+$/, '');
  if (!s) return [];
  if (/^https?:\/\//i.test(s)) return [s];
  const host = s.split(/[/?#]/)[0].split(':')[0];
  const order = isLanHost(host) ? ['http://', 'https://'] : ['https://', 'http://'];
  return order.map(p => p + s);
}
assert.deepEqual(candidates('192.168.1.50:8080'),
  ['http://192.168.1.50:8080', 'https://192.168.1.50:8080'], 'LAN IP tries http first');
assert.deepEqual(candidates('romm.example.com'),
  ['https://romm.example.com', 'http://romm.example.com'], 'public host tries https first');
assert.deepEqual(candidates('https://romm.example.com:8443'),
  ['https://romm.example.com:8443'], 'explicit scheme is honored as-is');
assert.deepEqual(candidates('nas'),
  ['http://nas', 'https://nas'], 'bare hostname is treated as LAN');

// --- needsNative (mirrors host-bridge.js) ---
// The rule is mixed content, not the scheme alone: an http URL is only blocked
// in the renderer when the page itself is secure. shell/tests/native-fetch.test.mjs
// exercises the real implementation; this pins the decision table.
const needsNative = (hasHost, url, pageProtocol = 'https:') =>
  !!hasHost && /^http:\/\//i.test(String(url || '')) && pageProtocol === 'https:';
assert.equal(needsNative(true, 'http://192.168.1.50:8080'), true, 'http in shell -> native');
assert.equal(needsNative(true, 'https://romm.example.com'), false, 'https in shell -> direct');
assert.equal(needsNative(false, 'http://192.168.1.50'), false, 'browser never native');
assert.equal(needsNative(true, 'http://192.168.1.50/api/roms', 'http:'), false,
  'an http page (RomM /console) reaches its own server directly');

// --- isCrossOrigin decision table (mirrors app.js) ---
// The cross-origin hint tells the user to add Access-Control-Allow-Origin to a
// proxy. That is right for exactly one cohort and actively misleading for the
// others, and the gate is NOT "am I in the app":
//   * plain browser, remote RomM  -> real CORS, show it
//   * shell + https RomM          -> the RENDERER fetches it, app.local really
//                                    is another origin, RomM really omits the
//                                    header on ROM bytes -> show it
//   * shell + http RomM           -> NATIVE code fetches it, no CORS exists ->
//                                    never show it (this was the reported bug)
const isCrossOrigin = (hasHost, server, pageOrigin = 'https://app.local') => {
  if (needsNative(hasHost, server)) return false;
  try { return new URL(server).origin !== pageOrigin; } catch (_) { return false; }
};
assert.equal(isCrossOrigin(true, 'http://192.168.1.200'), false,
  'shell + http: native fetch, so the CORS hint must never appear');
assert.equal(isCrossOrigin(true, 'https://romm.example.com'), true,
  'shell + https: renderer fetch against a real cross origin, hint is correct');
assert.equal(isCrossOrigin(false, 'https://romm.example.com', 'https://xbox.moveweight.com'), true,
  'browser + remote RomM: hint is correct');
assert.equal(isCrossOrigin(false, 'https://romm.example.com', 'https://romm.example.com'), false,
  'browser, same origin as RomM: nothing is cross-origin');
assert.equal(isCrossOrigin(true, ''), false, 'no server configured is never cross-origin');

// --- native error classification (mirrors NativeFetch.ClassifyNetworkError) ---
function classify(text) {
  text = text.toLowerCase();
  if (/no such host|name or service|getaddrinfo|could not be resolved/.test(text)) return 'dns';
  if (/ssl|secure channel|certificate|tls/.test(text)) return 'tls';
  if (/actively refused|refused/.test(text)) return 'refused';
  return 'network';
}
assert.equal(classify('No such host is known'), 'dns');
assert.equal(classify('The remote certificate is invalid'), 'tls');
assert.equal(classify('No connection could be made because the target machine actively refused it'), 'refused');
assert.equal(classify('A socket operation failed'), 'network');

// --- probeMessage picks a distinct sentence per reason (mirrors app.js) ---
function probeMessage(reason) {
  const map = { 'mixed-content': 'HTTPS', 'not-romm': 'not a RomM', dns: 'DNS',
    tls: 'certificate', refused: 'refused the connection', timeout: 'did not respond',
    'too-large': 'too large' };
  return map[reason] || (/^http-/.test(reason) ? 'answered with' : 'Could not reach');
}
for (const r of ['mixed-content','not-romm','dns','tls','refused','timeout','too-large'])
  assert.notEqual(probeMessage(r), 'Could not reach', `reason ${r} has a specific message`);
assert.equal(probeMessage('http-404'), 'answered with', 'http status maps to a message');

console.log('bridge-logic: all assertions passed');
