/* RomM for Xbox — gamepad-first client for *any* RomM server.
 *
 * There is no backend of ours in the play path: the user points the app at
 * their own RomM and that server supplies the library, the ROM bytes,
 * EmulatorJS and the save states. A stream server (RommStreamServer) is
 * optional and only adds the platforms EmulatorJS cannot run. */
'use strict';

const VIEWS = ['setup', 'auth', 'osk', 'library', 'local', 'stream', 'diag'];
// The shell injects window.__CARTRIDGE_VERSION (the real installed package
// version) and __CARTRIDGE_BUILD (git SHA + date) before any page script, so
// diagnostics cannot drift from what is actually installed the way a hardcoded
// constant did. In a plain browser neither exists; fall back to a dev marker.
const BUILD = (typeof window !== 'undefined' && window.__CARTRIDGE_VERSION)
  || 'dev';
const BUILD_SHA = (typeof window !== 'undefined' && window.__CARTRIDGE_BUILD
  && window.__CARTRIDGE_BUILD.sha) || '';
const BUILD_DATE = (typeof window !== 'undefined' && window.__CARTRIDGE_BUILD
  && window.__CARTRIDGE_BUILD.date) || '';
let view = 'setup';
let platforms = [], platIdx = 0;
let games = [], gameIdx = 0;
const GRID_COLS = 8;          // must match grid-template-columns in style.css
/* One screenful, not a library.
 *
 * This was 500, which on a large server meant the first thing a player saw
 * after choosing a platform was a 10.2 MB download taking 7.5 seconds -- and
 * over the internet rather than a LAN, that is the whole "is this thing
 * broken?" experience. RomM sends roughly 20 KB of metadata per ROM, so the
 * page size dominates everything else. 72 is nine rows of the 8-wide grid:
 * about 1.2 MB and ~1s, after which the rest streams in behind the player
 * while they are already looking at box art. */
const PAGE_SIZE = 72;
let currentGame = null, quitHold = 0, activeStateId = null, blobUrls = [];
// Non-empty once a save-state upload has failed this session, so Diagnostics can
// report it and the on-screen warning fires once rather than every save.
let saveStateTrouble = '';
let hiddenGames = 0, hiddenPlatforms = 0, impossibleGames = 0;

const $ = id => document.getElementById(id);

function show(v) {
  for (const x of VIEWS) {
    const el = $('view-' + x);
    if (el && x !== 'osk') el.classList.toggle('hidden', x !== v);
  }
  view = v;
}

function releaseBlobs() {
  for (const u of blobUrls) URL.revokeObjectURL(u);
  blobUrls = [];
}

/* Cover art re-fetched through the native bridge, cached and bounded.
 *
 * Kept out of blobUrls deliberately: those are revoked on entering a game, and
 * the grid outlives that. The cap is what keeps a 4,000-game platform from
 * accumulating an object URL per tile; the oldest are revoked as it fills. A
 * failed fetch is cached as null so a server that will not serve covers is
 * asked once per image, not once per redraw. */
const COVER_CACHE_MAX = 400;
const coverCache = new Map();
function coverBlobUrl(url) {
  const hit = coverCache.get(url);
  if (hit !== undefined) return Promise.resolve(hit);
  const p = ROMM.assetBlobUrl(url).catch(() => null).then(u => {
    coverCache.set(url, u);
    while (coverCache.size > COVER_CACHE_MAX) {
      const oldest = coverCache.keys().next().value;
      const dead = coverCache.get(oldest);
      coverCache.delete(oldest);
      // Entries are a Promise while in flight and a string (or null) after;
      // only the settled ones own an object URL to release.
      if (typeof dead === 'string') URL.revokeObjectURL(dead);
    }
    return u;
  });
  coverCache.set(url, p);           // de-duplicates concurrent tiles
  return p;
}

/* RomM platform slug → EmulatorJS *system* name. Presence here is the "plays on
 * the console itself" decision — no server round-trip needed to know it.
 *
 * The values are EmulatorJS system keys, NOT libretro core filenames. Getting
 * that wrong is the worst failure mode in this app: the platform browses
 * normally and the game only fails when the user presses A. Four of these were
 * wrong at once — 'gbc', 'vice_x64', 'pcecd' and 'mame2003' are all plausible
 * and none of them exist — which silently cost 1,451 games in a real library.
 * tests/validate_cores.js checks every value against the list EmulatorJS
 * actually ships, and runs in CI. Add nothing here without it passing.
 *
 * Both old and new RomM slugs are kept where RomM renamed one, so the app works
 * against older and current servers. A missing slug is not a small thing either:
 * an unmapped platform is hidden from the library entirely, which is how
 * "genesis" hid ~1,900 games. */
const EJS_CORES = {
  // Nintendo
  nes: 'nes', famicom: 'nes', fds: 'nes',
  snes: 'snes', sfam: 'snes', satellaview: 'snes',
  n64: 'n64',
  gb: 'gb', gbc: 'gb',                  // one gambatte core covers both
  gba: 'gba',
  nds: 'nds', 'nintendo-dsi': 'nds',
  // Sega
  'genesis-slash-megadrive': 'segaMD', genesis: 'segaMD',
  'sega-pico': 'segaMD',                // genesis_plus_gx handles Pico
  sms: 'segaMS', sg1000: 'segaMS', gamegear: 'segaGG',
  sega32: 'sega32x', segacd: 'segaCD', saturn: 'segaSaturn',
  // Sony
  psx: 'psx', ps: 'psx', psp: 'psp',
  // Arcade / SNK
  arcade: 'arcade', mame: 'mame',
  neogeoaes: 'arcade', neogeomvs: 'arcade',
  'neo-geo-pocket': 'ngp', 'neo-geo-pocket-color': 'ngp',
  // NEC
  'turbografx16--1': 'pce', 'turbografx-cd': 'pce',
  'turbografx-16-slash-pc-engine-cd': 'pce', supergrafx: 'pce', pcfx: 'pcfx',
  // Atari
  atari2600: 'atari2600', 'atari-2600': 'atari2600',
  atari5200: 'atari5200', atari7800: 'atari7800',
  lynx: 'lynx', jaguar: 'jaguar',
  // Everything else
  '3do': '3do', colecovision: 'coleco',
  wonderswan: 'ws', 'wonderswan-color': 'ws', virtualboy: 'vb',
  'vic-20': 'vic20', c64: 'c64', c128: 'c128', plus4: 'plus4',
  amiga: 'amiga', 'amiga-cd32': 'amiga',   // puae runs CD32
  dos: 'dos',
  // Deliberately absent: ZX Spectrum and Amstrad CPC. Both were mapped to cores
  // ('zx', 'amstradcpc') that EmulatorJS does not have, so they failed at
  // launch. Leaving them unmapped routes them honestly instead.
};

/* Platforms a stream server can run, because a libretro core for them exists.
 * Mirrors RETROARCH_CORES in RommStreamServer/tiers.py — keep the two in step.
 *
 * This list is why the tier decision is not simply "anything EmulatorJS cannot
 * do, stream it". Switch, Wii U, Xbox and PS3 have no libretro core at all, so
 * offering them the moment a stream server is configured produced a dead end:
 * the platform appeared, the user pressed A, and the server answered
 * "unplayable". */
const STREAM_CORES = new Set([
  'ngc', 'wii', 'dc', 'dreamcast', 'ps2', '3ds', 'new-nintendo-3ds',
  'naomi', 'atomiswave', 'msx', 'msx2', 'vectrex', 'intellivision',
  'sharp-x68000', 'saturn', 'psp', 'n64', 'psx', 'arcade',
]);

/* Where a platform can play:
 *   'local'  — EmulatorJS on the console itself
 *   'stream' — a configured stream server runs a real emulator
 *   'server' — streamable, but no stream server is configured yet
 *   'none'   — no emulator exists for it anywhere
 * The last two are both unplayable today but mean different things to the user,
 * and only one of them is fixable. */
/* What the configured stream server says it can actually run, once asked.
 * Null until then, in which case STREAM_CORES is the fallback guess.
 *
 * Asking matters because a core being *known* is not the same as it being
 * installed and having its firmware: the server has Dreamcast and PS2 cores but
 * no console firmware to boot them with, and a core with no firmware does not
 * fail loudly — it draws an error screen and streams that at a healthy 30 fps.
 * Only the server can tell. */
let streamable = null, streamWhy = {}, ejsUnavailable = new Set();

async function refreshStreamable() {
  if (!CFG.stream) {
    streamable = null; streamWhy = {}; ejsUnavailable = new Set(); return;
  }
  try {
    const r = await fetch(HOST.route(CFG.stream) + '/api/play/streamable');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    streamable = new Set(j.streamable || []);
    streamWhy = j.unavailable || {};
    ejsUnavailable = new Set(j.ejs_unavailable || []);
  } catch (_) {
    // An older stream server has no such endpoint; fall back to the built-in
    // list rather than showing the user nothing.
    streamable = null;
    streamWhy = {};
    ejsUnavailable = new Set();
  }
}

/* EmulatorJS systems whose cores need pthreads, and so a SharedArrayBuffer.
 *
 * EmulatorJS refuses these outright unless it was given threads: its
 * downloadGameCore() checks requiresThreads(['ppsspp','dosbox_pure']) and, if
 * threads are off, shows its webmaster-facing "Error for site owner / Check
 * console" — on a console, where there is no console to check. No server
 * setting can change that; SharedArrayBuffer requires a cross-origin-isolated
 * page, and the packaged app is not one.
 *
 * So this is gated on the real capability rather than assumed: a deployment
 * that DOES serve COOP/COEP keeps PSP and DOS playable locally, and the shell
 * routes them to the stream tier instead of into a dead end. */
const THREADED_EJS_SYSTEMS = new Set(['psp', 'dos']);
const canRunThreadedCores = () =>
  typeof self !== 'undefined' && self.crossOriginIsolated === true;

function tierFor(slug) {
  // EJS_CORES says a core *exists* for this platform, not that the server has
  // downloaded it. PSP is in the table and its core is absent, so trusting the
  // table alone sent 1,182 games to a launch that could never succeed. When the
  // server tells us the core is missing, fall through to the stream tier, which
  // has its own (ppsspp) core for exactly this case.
  const ejs = EJS_CORES[slug];
  const threadBlocked = THREADED_EJS_SYSTEMS.has(ejs) && !canRunThreadedCores();
  if (ejs && !ejsUnavailable.has(slug) && !threadBlocked) return 'local';
  const canStream = streamable ? streamable.has(slug) : STREAM_CORES.has(slug);
  if (canStream) return CFG.stream ? 'stream' : 'server';
  if (STREAM_CORES.has(slug)) return 'server';   // possible, but not on this server
  return 'none';
}

/* ------------------------------------------------------------------ setup */

function renderSetup(status) {
  const server = CFG.server;
  $('setup-server').textContent = server || 'not set';
  $('setup-stream').textContent = CFG.stream || 'none (optional)';
  if (status !== undefined) $('setup-status').textContent = status;
  const opts = $('setup-options');
  opts.innerHTML = '';
  setupItems().forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'opt' + (i === setupIdx ? ' focus' : '');
    d.innerHTML = `<b>${it.label}</b><span class="dim">${it.sub || ''}</span>`;
    opts.appendChild(d);
  });
}

let setupIdx = 0;
function setupItems() {
  const items = [
    { label: 'Enter your RomM server address', sub: 'e.g. romm.yourdomain.com',
      go: askServer },
  ];
  // Offered second, never as the focused default: on the published build this
  // host is *our* RomM, and pointing a stranger's console at it would be a
  // confusing dead end rather than a useful shortcut.
  if (sameOriginServer) {
    items.push({ label: 'Use the RomM server on this host',
      sub: sameOriginServer + ' — only useful if that server is yours',
      go: () => useServer(sameOriginServer) });
  }
  items.push({ label: 'Set stream server (optional)',
    sub: 'adds GameCube / Wii / PS2 / Dreamcast via RommStreamServer',
    go: askStream });
  items.push({
    label: 'Library UI: ' + (CFG.useRommWebUi ? "RomM's web console" : 'built-in'),
    sub: CFG.useRommWebUi
      ? "uses RomM's own TV UI (signs in again on the server)"
      : 'browse and play here, no second sign-in',
    go: () => { CFG.useRommWebUi = !CFG.useRommWebUi; renderSetup(''); },
  });
  if (CFG.server) items.push({ label: 'Continue', sub: 'sign in to ' + CFG.server,
    go: () => enterAuth() });
  return items;
}

function askServer() {
  OSK.open({
    title: 'RomM server address',
    hint: 'D-pad move · A press · X backspace · Y shift · Menu done',
    // No scheme and no port needed: "192.168.1.42" is enough, and the scheme is
    // probed. Prefilling "https://" only taught people they had to type one.
    value: CFG.server || '',
    onSubmit: async raw => {
      const list = CFG.candidates(raw);
      OSK.logReset();
      if (!list.length) return OSK.setStatus('That is not a valid address.');
      OSK.setStatus('Connecting…');
      // Show the plan before doing any of it, so a stall is attributable to a
      // specific address rather than to the app in general.
      OSK.logAdd('will try: ' + list.join('  then  '), 'ok');
      let line = null;
      try {
        const { server, version } = await ROMM.probeAny(list, s => {
          OSK.setStatus('Connecting…');
          if (HOST.present) OSK.logAdd('via host: ' + HOST.route(s), 'ok');
          line = OSK.logAdd('GET ' + s + '/api/heartbeat …');
        }, (s, e) => {
          OSK.logDone(line, 'FAILED ' + s + ' — ' + (e.message || 'error'), 'bad');
        });
        OSK.logDone(line, 'OK ' + server + ' — RomM ' + version);
        CFG.server = server;
        CFG.clearAuth();
        OSK.close();
        show('setup');
        renderSetup('Found RomM ' + version + '. Now sign in.');
        setupIdx = setupItems().length - 1;
        renderSetup();
      } catch (e) {
        noteFailure("server probe", e);
        OSK.setStatus(probeMessage(e, e.server || list[list.length - 1]));
      }
    },
    onCancel: () => { OSK.close(); show('setup'); renderSetup(''); },
  });
}

function askStream() {
  OSK.open({
    title: 'Stream server address (optional)',
    hint: 'Leave empty to skip · Menu done',
    value: CFG.stream || '',
    onSubmit: raw => {
      const s = raw.trim() ? CFG.normalize(raw) : '';
      CFG.stream = s;
      OSK.close();
      show('setup');
      renderSetup(s ? 'Stream server set.' : 'Stream server cleared.');
    },
    onCancel: () => { OSK.close(); show('setup'); renderSetup(''); },
  });
}

// One clear sentence per failure class, so the setup screen never falls back to
// a bare "Failed to fetch". The reason tag comes from romm.js (which carries the
// native bridge's classification of dns/tls/refused/timeout).
function probeMessage(e, server) {
  // nativeReason matters as much as reason now: a body that fails mid-download
  // rejects with a plain TypeError from the bridge, outside the client's
  // NetError wrapping, and reading only .reason sent that whole class of
  // failure to the generic "could not reach" line.
  const reason = (e && e.reason) || (e && e.nativeReason) || (e && e.message) || '';
  switch (reason) {
    case 'mixed-content':
      return 'This page is served over HTTPS and cannot reach an http:// server. ' +
             'The installed Xbox app fetches http servers natively and has no ' +
             'such limit, so this only happens in a plain browser: use an ' +
             'https:// address there, or install the app.';
    case 'not-romm':
      return 'That address answered, but it is not a RomM server. Check you ' +
             'used the RomM address (not, say, your router or another app).';
    case 'bad-json':
      return 'Your server answered, but not with the data RomM sends. Something ' +
             'in between is intercepting the request — a reverse proxy, or a ' +
             'guest-network sign-in page. Try the RomM address directly.';
    case 'dns':
      return 'That hostname could not be found (DNS). Check the spelling, or ' +
             'try the server\'s IP address instead.';
    case 'tls':
      return 'The server\'s HTTPS certificate could not be trusted. If it uses a ' +
             'self-signed certificate, reach it by http on the LAN, or install a ' +
             'real certificate.';
    case 'refused':
      return 'The server refused the connection. Check the port, and that RomM ' +
             'is running and listening on that address.';
    case 'timeout':
      return 'The server did not respond in time. Check it is on and reachable ' +
             'from this console\'s network.';
    case 'too-large':
      return 'The server responded, but that file is larger than this console ' +
             'will download. Disc-sized games play through a stream server ' +
             'instead — add one in Settings.';
    default:
      if (/^http-/.test(reason))
        return 'The server answered with ' + reason.replace('http-', 'HTTP ') +
               '. Check the address and that RomM is healthy.';
      return 'Could not reach ' + server + '. Check the address, the port, and ' +
             'that this console is on the same network as the server.';
  }
}

// RomM hands ROM downloads to nginx with X-Accel-Redirect and serves /assets
// from nginx directly, so neither response carries the CORS header its FastAPI
// middleware adds. The browse API works cross-origin and then play fails — so
// say precisely that rather than surfacing a bare "Failed to fetch".
function crossOriginFileHint(what) {
  return `Your RomM server browses fine, but it will not send ${what} to an ` +
    'app on a different address. RomM only adds cross-origin headers to its ' +
    'JSON API, not to ROM downloads or /assets. Either open this app from the ' +
    'same address as your RomM (see the project README for the two-line proxy) ' +
    'or add Access-Control-Allow-Origin for those paths in your own proxy.';
}

/* True only where cross-origin is actually the rule in force.
 *
 * The page is served from https://app.local, so a bare comparison of origins is
 * true for EVERY server anyone could configure — which is how every download
 * failure in the shell, whatever its cause, came out as a lecture about adding
 * Access-Control-Allow-Origin to a proxy.
 *
 * But the answer is not simply "never in the shell". It depends on who makes
 * the request. A plain-http server is fetched by native code, which no CORS
 * rule touches, so the hint is meaningless there. An https server is fetched by
 * the renderer itself (HOST.fetch takes the direct branch), app.local really is
 * a different origin, and RomM really does ship ROM bytes through nginx without
 * the header — so for that user the hint is correct, actionable, and the only
 * message that would help. needsNative() is exactly that distinction.
 */
const isCrossOrigin = () => {
  if (HOST.needsNative(CFG.server)) return false;
  try { return new URL(CFG.server).origin !== location.origin; }
  catch (_) { return false; }
};

/* What to tell the user when something in the play path would not load.
 *
 * The reason tag comes from the native bridge (dns/tls/refused/timeout/
 * too-large) or from an HTTP status, so this can name the real fault instead of
 * guessing at one. */
function playFailureMessage(what, e) {
  const reason = (e && (e.reason || e.nativeReason)) || '';
  if (reason === 'too-large') {
    return ((e && (e.nativeDetail || e.message)) || 'That file is too large for this console.')
      + ' Disc-sized games play through a stream server — add one in Settings.';
  }
  if (reason === 'timeout') {
    return 'The transfer from ' + (CFG.server || 'your server') + ' stopped partway. '
      + 'Check the server is still running and that this console\'s connection to '
      + 'it is steady (a wired connection is far more reliable for large games).';
  }
  if (/^http-4|^http-5/.test(reason)) {
    return 'Your server answered ' + reason.replace('http-', 'HTTP ') + ' for '
      + what + '. ' + (reason === 'http-404'
        ? 'That file is not on the server — for EmulatorJS, update RomM; for a '
          + 'game, rescan your library.'
        : 'Check the RomM logs for what it refused.');
  }
  if (isCrossOrigin()) return crossOriginFileHint(what);
  if (reason) return probeMessage(e, CFG.server || 'your server');
  return 'Could not load ' + what.toLowerCase() + ': '
    + ((e && e.message) || 'unknown error');
}

function useServer(server) {
  CFG.server = server;
  renderSetup('Server set to ' + server + '.');
  enterAuth();
}

/* ------------------------------------------------------------ diagnostics */

let lastFailure = '';
function noteFailure(what, e) {
  lastFailure = what + ': ' + ((e && e.message) || e || 'unknown');
}

function gamepadSummary() {
  const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : [])
    .filter(Boolean);
  if (GP.usingHost) {
    const p = pads[0];
    return 'via native host' + (p ? ' (' + p.id + ')' : '');
  }
  if (pads.length) return 'via Gamepad API (' + pads[0].id + ')';
  return 'not detected';
}

/* Result of the last real bridge round trip, shown in Diagnostics. */
let bridgeProof = 'not tested (press A)';

/* Actually exercise the native bridge rather than asserting it exists. Uses the
 * configured server's heartbeat because that is the exact path everything else
 * depends on; a failure here is the single most useful fact a tester can read
 * off the screen. */
async function proveBridge() {
  if (!HOST.present) return 'n/a';
  if (!window.__cartNativeFetch) return 'MISSING - the page never installed it';
  const server = CFG.server || '';
  if (!server) return 'installed, untested (no server set)';
  if (!HOST.needsNative(server)) return 'installed, not needed for an https server';
  const t0 = Date.now();
  try {
    const r = await window.__cartNativeFetch(server + '/api/heartbeat', { method: 'GET' });
    await r.blob();
    return (r.ok ? 'OK' : 'HTTP ' + r.status) + ' in ' + (Date.now() - t0) + ' ms';
  } catch (e) {
    return 'FAILED - ' + ((e && e.nativeReason) || (e && e.message) || 'error');
  }
}

async function renderDiag(status) {
  const server = CFG.server || '';
  const rows = [
    ['Build', BUILD + (BUILD_SHA ? ' (' + BUILD_SHA + ')' : '')
      + (BUILD_DATE ? ' ' + BUILD_DATE : '')],
    ['Running in', HOST.present ? 'Xbox app (native host)' : 'browser'],
    // Proved by an actual round trip, not by a symbol existing. The old check
    // asserted "ready" purely because host-bridge.js had defined a function --
    // it would have said the same with the shell's message handler never wired,
    // which makes the single most load-bearing fact on this screen a constant.
    ['Native http bridge', HOST.present ? bridgeProof : 'n/a'],
    ['Controller', gamepadSummary()],
    ['Gamepads seen', String((navigator.getGamepads
      ? [...navigator.getGamepads()] : []).filter(Boolean).length)],
    ['RomM server', server || 'not set'],
    ['Reaches server by', server
      ? (HOST.needsNative && HOST.needsNative(server) ? 'native http bridge'
         : 'direct ' + (/^https/i.test(server) ? 'https' : 'http')) : '—'],
    ['Signed in', CFG.token ? 'yes (' + (CFG.mode || 'client') + ')' : 'no'],
    ['Stream server', CFG.stream || 'none'],
    ['Playable platforms', platforms.length ? String(platforms.length) : '—'],
    ['Save states', saveStateTrouble
      ? 'FAILING to upload - ' + saveStateTrouble
      : (CFG.token ? 'no failures seen' : '-')],
    // A core that quietly came from the EmulatorJS CDN makes a broken path to
    // your own server look like a working one. Say so.
    ['Cores from emulatorjs.org', (window.__cartCdnHits || 0) > 0
      ? String(window.__cartCdnHits) + ' request(s) - NOT from your server'
      : 'none'],
    ['Last failure', lastFailure || 'none'],
  ];
  const dl = $('diag-kv');
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  }
  if (status !== undefined) $('diag-status').textContent = status;
}

async function testDiag() {
  if (!CFG.server) return renderDiag('No server set — nothing to test.');
  renderDiag('Testing ' + CFG.server + ' …');
  const results = [];
  try {
    const { version } = await ROMM.probe(CFG.server);
    results.push('server reachable (RomM ' + version + ')');
  } catch (e) {
    results.push('server UNREACHABLE — ' + (e.message || 'error'));
  }
  if (CFG.token) {
    try {
      const p = await ROMM.platforms();
      results.push((p || []).length + ' platforms readable');
    } catch (e) {
      results.push('library read FAILED — ' + (e.message || 'error'));
    }
    /* Test EmulatorJS over the SAME transport play uses, which is the whole
     * point of this screen and is what it previously got wrong in both
     * directions: a plain fetch() succeeded through the bridge on servers where
     * play then failed, and was CORS-blocked on https servers where play works
     * fine, because play loads it as a <script src>, which is not CORS-checked. */
    const data = ROMM.emulatorJsData();
    try {
      if (HOST.needsNative(data)) {
        const u = await ROMM.assetBlobUrl(data + 'loader.js');
        URL.revokeObjectURL(u);
        results.push('EmulatorJS reachable (via the bridge, as play loads it)');
      } else {
        // no-cors mirrors a <script src> load: it resolves when the resource
        // really came back and rejects only on a genuine network failure.
        await fetch(data + 'loader.js', { mode: 'no-cors' });
        results.push('EmulatorJS reachable (direct, as play loads it)');
      }
    } catch (e) {
      results.push('EmulatorJS UNREACHABLE — '
        + ((e && e.reason) || (e && e.nativeReason) || e.message || 'error'));
    }
  }
  bridgeProof = await proveBridge();
  renderDiag(results.join(' · '));
}

function diagInput(btn) {
  if (btn === 'a') return testDiag();
  if (btn === 'b' || btn === 'y') { show('setup'); return renderSetup(''); }
}

function setupInput(btn) {
  const items = setupItems();
  if (btn === 'x') { show('diag'); return renderDiag(''); }
  if (btn === 'up') setupIdx = (setupIdx + items.length - 1) % items.length;
  else if (btn === 'down') setupIdx = (setupIdx + 1) % items.length;
  else if (btn === 'a') return items[setupIdx].go();
  else if (btn === 'b') {
    // Settings reached from the library: go back. Otherwise this is the root,
    // and back should leave the app rather than do nothing.
    if (CFG.server && CFG.token) return enterLibrary();
    // In a browser there is nothing to exit — closing the tab is the user's job.
    HOST.exit();
    return;
  }
  else return;
  renderSetup();
}

/* ------------------------------------------------------------------- auth */

let authIdx = 0, code = '', padIdx = 0;
// RomM mints ALPHANUMERIC pair codes (for example H9Y6-K7G7), so a digits-only
// pad locked every real code out. Six keys per row: the up/down math below
// steps by 6.
const PAD = [
  'A','B','C','D','E','F',
  'G','H','I','J','K','L',
  'M','N','O','P','Q','R',
  'S','T','U','V','W','X',
  'Y','Z','0','1','2','3',
  '4','5','6','7','8','9',
  '←','OK',
];

function enterAuth() {
  show('auth');
  code = ''; padIdx = 0; authIdx = 0;
  renderAuth('');
}

function renderAuth(status) {
  $('auth-server').textContent = CFG.server;
  const tabs = $('auth-tabs');
  tabs.innerHTML = '';
  ['Pair with a code', 'Username & password'].forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'tab' + (i === authIdx ? ' current' : '');
    d.textContent = t;
    tabs.appendChild(d);
  });
  $('auth-pair').classList.toggle('hidden', authIdx !== 0);
  $('auth-creds').classList.toggle('hidden', authIdx !== 1);
  if (authIdx === 0) {
    const disp = code + '········'.slice(code.length);
    $('pair-code').textContent =
      (disp.slice(0, 4) + '-' + disp.slice(4)).split('').join(' ');
    const pad = $('pair-pad');
    pad.innerHTML = '';
    PAD.forEach((k, i) => {
      const d = document.createElement('div');
      d.className = 'key' + (i === padIdx ? ' focus' : '');
      d.textContent = k;
      pad.appendChild(d);
    });
  }
  if (status !== undefined) $('auth-status').textContent = status;
}

async function submitPair() {
  if (code.length !== 8) return renderAuth('Enter all eight characters.');
  renderAuth('Pairing with RomM…');
  // RomM displays the code as XXXX-XXXX; whether the exchange endpoint wants
  // the dash is not worth guessing, so try bare first and retry dashed.
  const bare = code.toUpperCase();
  const dashed = bare.slice(0, 4) + '-' + bare.slice(4);
  try {
    let token;
    try {
      token = await ROMM.exchangePairCode(bare);
    } catch (e) {
      if (!(e instanceof ROMM.AuthError)) throw e;
      token = await ROMM.exchangePairCode(dashed);
    }
    CFG.token = token;
    CFG.refresh = '';
    CFG.mode = 'client';          // long-lived; nothing to refresh
    enterLibrary();
  } catch (e) {
    code = '';
    renderAuth(e instanceof ROMM.AuthError
      ? 'Pairing failed — codes are single-use and expire after five minutes.'
      : 'Could not reach ' + CFG.server + '.');
  }
}

function askCredentials() {
  OSK.open({
    title: 'RomM username',
    hint: 'A press · X backspace · Menu done',
    value: '',
    onSubmit: username => {
      if (!username.trim()) return OSK.setStatus('Enter your username.');
      OSK.open({
        title: 'Password for ' + username,
        hint: 'A press · X backspace · Menu done',
        password: true,
        value: '',
        onSubmit: async password => {
          OSK.setStatus('Signing in…');
          try {
            const { token, refresh } = await ROMM.signIn(username, password);
            CFG.token = token;
            CFG.refresh = refresh;
            CFG.mode = 'password';
            OSK.close();
            enterLibrary();
          } catch (e) {
            OSK.setStatus(e instanceof ROMM.AuthError
              ? 'RomM rejected those credentials.'
              : 'Could not reach ' + CFG.server + '.');
          }
        },
        onCancel: () => { OSK.close(); show('auth'); renderAuth(''); },
      });
    },
    onCancel: () => { OSK.close(); show('auth'); renderAuth(''); },
  });
}

function authInput(btn) {
  if (btn === 'l1' || btn === 'r1') {
    authIdx = 1 - authIdx;
    return renderAuth('');
  }
  // B is the console's own "back" and cannot be relied on here (see osk.js), so
  // going back to setup is Y, and deleting a digit is X.
  if (btn === 'y' || btn === 'b') { show('setup'); return renderSetup(''); }
  if (authIdx === 1) {
    if (btn === 'a') return askCredentials();
    return;
  }
  if (btn === 'left') padIdx = (padIdx + PAD.length - 1) % PAD.length;
  else if (btn === 'right') padIdx = (padIdx + 1) % PAD.length;
  else if (btn === 'up') padIdx = (padIdx + PAD.length - 6) % PAD.length;
  else if (btn === 'down') padIdx = (padIdx + 6) % PAD.length;
  else if (btn === 'x') code = code.slice(0, -1);
  else if (btn === 'a') {
    const k = PAD[padIdx];
    if (k === '←') code = code.slice(0, -1);
    else if (k === 'OK') return submitPair();
    else if (code.length < 8) code += k;
    if (code.length === 8 && k !== 'OK') return submitPair();
  } else return;
  renderAuth();
}

/* ---------------------------------------------------------------- library */

async function enterLibrary() {
  // Default: the built-in library, which reuses the token established here and
  // never leaves app.local, so the user is not asked to sign in a second time.
  // Opt-in (Settings): hand the whole page to RomM's own /console web UI. That
  // path is richer but runs on the server's origin with its own cookie auth, so
  // it re-prompts for a RomM login even after pairing here — which read as the
  // app being broken. It stays available for anyone who prefers RomM's UI.
  if (CFG.server && CFG.useRommWebUi) {
    try {
      const base = CFG.server.replace(/\/$/, '');
      // Navigate the WHOLE page to the RomM server's /console. This must be a
      // direct navigation to the real origin — NOT the app.local/__romm proxy —
      // because /console is a SPA whose own asset/api URLs are relative: proxying
      // the document would rebase them onto app.local and break the app. The
      // per-fetch proxy (HOST.route) is only for API/XHR CORS, not page loads.
      //
      // A direct nav is safe when the server is https (same secure context as
      // app.local, no mixed content). For a plain-http LAN server the native
      // shell allows the navigation (AdditionalAllowedFrameAncestors / the
      // WebView2 http exception set up in MainPage) so it still loads.
      const consoleUrl = base + '/console';       // e.g. https://romm.example.com/console
      location.href = consoleUrl;
      return;
    } catch (e) { /* fall through to the built-in library */ }
  }
  show('library');
  $('lib-status').textContent = 'Loading your RomM library…';
  try {
    // Ask the stream server what it can run before deciding tiers, or platforms
    // it has no firmware for would be offered and then fail.
    await refreshStreamable();
    const all = await ROMM.platforms();
    const withGames = all.filter(p => p.rom_count);
    const rated = withGames.map(p => ({ p, tier: tierFor(p.slug) }));
    platforms = rated.filter(x => x.tier === 'local' || x.tier === 'stream');
    // Silently dropping platforms makes a library look smaller than it is and
    // gives the user nothing to act on. Count what was left out, and separate
    // "add a stream server and this works" from "nothing can run this".
    const count = t => rated.filter(x => x.tier === t)
      .reduce((n, x) => n + (x.p.rom_count || 0), 0);
    hiddenGames = count('server');
    hiddenPlatforms = rated.filter(x => x.tier === 'server').length;
    impossibleGames = count('none');
    if (!platforms.length) {
      $('lib-status').textContent = all.length
        ? (hiddenGames
            ? `${hiddenGames} games need a stream server — add one in Settings (Y).`
            : 'None of your platforms can run on an Xbox.')
        : 'That RomM has no platforms with games in it yet.';
      $('lib-title').textContent = 'Library';
      $('game-grid').innerHTML = '';
      return;
    }
    platIdx = Math.min(platIdx, platforms.length - 1);
    await loadGames();
  } catch (e) {
    if (e instanceof ROMM.AuthError) {
      CFG.clearAuth();
      enterAuth();
      renderAuth('Sign-in expired or was revoked — sign in again.');
    } else {
      $('lib-status').textContent = probeMessage(e, CFG.server) +
        '  (Y for settings)';
    }
  }
}

/* Bumped on every platform change so a backfill in flight can tell that its
 * results are no longer wanted, instead of appending to the wrong platform. */
let loadToken = 0;

const playable = list => (list || []).filter(g =>
  (g.fs_name || g.file_name) && !/\.(exe|msi|bat|sh)$/i.test(g.fs_name || ''));

function updateCount(total, tier) {
  $('lib-count').textContent =
    (total > games.length ? `${games.length} of ${total} games`
                          : `${games.length} games`) + ' · ' +
    (tier === 'local' ? 'plays on this console' : 'streams from your server');
}

/* Pull the remaining pages one at a time, appending as each lands.
 *
 * Sequential on purpose: this is competing with the player's own actions for a
 * home server's upload bandwidth, and firing every page at once would make the
 * screen they are actually looking at slower. Redraws only while the grid is
 * still the visible view and only when focus has not moved, so appending never
 * yanks the selection out from under a thumbstick. */
async function backfillGames(p, tier, total, token) {
  for (let offset = games.length; offset < total; offset += PAGE_SIZE) {
    if (token !== loadToken) return;
    let page;
    try {
      page = await ROMM.roms(p.id, PAGE_SIZE, offset);
    } catch (e) {
      noteFailure('load more games', e);
      return;                          // keep what we have; it is still usable
    }
    if (token !== loadToken) return;
    const more = playable(page.items || page || []);
    if (!more.length) return;
    const wasIdx = gameIdx;
    games = games.concat(more);
    updateCount(Number(page.total) || total, tier);
    if (view === 'library') {
      renderGrid();
      gameIdx = wasIdx;
    }
  }
}

async function loadGames() {
  const { p, tier } = platforms[platIdx];
  $('lib-title').textContent = p.display_name || p.name || p.slug;
  $('lib-status').textContent = 'Loading games…';
  renderRail();
  const token = ++loadToken;          // invalidates any backfill still running
  try {
    const j = await ROMM.roms(p.id, PAGE_SIZE, 0);
    if (token !== loadToken) return;   // the player already moved on
    games = playable(j.items || j || []);
    gameIdx = 0;
    // j.total is the whole platform; games is one page of it. Saying "500
    // games" for a 4,414-game platform is simply wrong.
    const total = Number(j.total) || games.length;
    updateCount(total, tier);
    renderGrid();
    $('lib-status').textContent = games.length ? footnote() : 'No games on this platform.';
    // The player can already see and move around the first screenful; fetch the
    // rest behind them rather than making them wait for a whole platform.
    if (total > games.length) backfillGames(p, tier, total, token);
  } catch (e) {
    if (e instanceof ROMM.AuthError) { CFG.clearAuth(); return enterAuth(); }
    noteFailure('load games', e);
    $('lib-status').textContent = 'Could not load games: ' + e.message;
  }
}

/* What is missing from the rail, and whether the user can do anything about it.
 * Shown once under the grid rather than per-platform: it is context, not an
 * error, and a library that quietly omits a third of itself is worse. */
function footnote() {
  const bits = [];
  if (hiddenGames) {
    bits.push(`${hiddenGames} games on ${hiddenPlatforms} more ` +
      `platform${hiddenPlatforms === 1 ? '' : 's'} need a stream server (Y)`);
  }
  if (impossibleGames) {
    bits.push(`${impossibleGames} cannot run on an Xbox at all`);
  }
  return bits.join(' · ');
}

function renderRail() {
  const rail = $('platform-rail');
  rail.innerHTML = '';
  // The count is not decoration: RomM can hold two platforms with the same
  // display name (two "Amiga" entries on this library), and without it they are
  // indistinguishable in the rail.
  platforms.forEach(({ p }, i) => {
    const d = document.createElement('div');
    d.className = 'plat' + (i === platIdx ? ' current' : '');
    d.textContent = `${p.display_name || p.name || p.slug} (${p.rom_count})`;
    rail.appendChild(d);
  });
  const cur = rail.children[platIdx];
  if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function renderGrid() {
  const grid = $('game-grid');
  grid.innerHTML = '';
  games.forEach((g, i) => {
    const t = document.createElement('div');
    t.className = 'tile' + (i === gameIdx ? ' focus' : '');
    const cover = ROMM.coverUrl(g);
    if (cover) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = cover;
      // A cover is one of the few things the console loads as a plain <img>,
      // and on a plain-http server that is mixed content, which Chromium
      // blocks. Images are usually auto-upgraded to https first — but not when
      // the host is a bare IP address, which is what a LAN RomM almost always
      // is, so those are blocked outright. Either way an art-less grid is not a
      // missing cover, it is the scheme. Re-fetch through the native bridge,
      // once, and only for the tiles the browser actually asked for (they are
      // lazy, so that is what is on screen).
      img.onerror = () => {
        img.removeAttribute('src');
        if (!HOST.needsNative(cover)) return;
        coverBlobUrl(cover).then(u => { if (u) img.src = u; });
      };
      t.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'ph';
      t.appendChild(ph);
    }
    const cap = document.createElement('div');
    cap.className = 't';
    cap.textContent = g.name || g.fs_name_no_ext || g.fs_name;
    t.appendChild(cap);
    grid.appendChild(t);
  });
  const cur = grid.children[gameIdx];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function libraryInput(btn) {
  if (btn === 'y') { setupIdx = 0; show('setup'); return renderSetup(''); }
  if (!platforms.length) return;
  if (btn === 'l1') { platIdx = (platIdx + platforms.length - 1) % platforms.length; return loadGames(); }
  if (btn === 'r1') { platIdx = (platIdx + 1) % platforms.length; return loadGames(); }
  if (btn === 'x') return loadGames();
  if (!games.length) return;
  const last = games.length - 1;
  if (btn === 'left') gameIdx = Math.max(0, gameIdx - 1);
  else if (btn === 'right') gameIdx = Math.min(last, gameIdx + 1);
  else if (btn === 'up') gameIdx = Math.max(0, gameIdx - GRID_COLS);
  else if (btn === 'down') gameIdx = Math.min(last, gameIdx + GRID_COLS);
  else if (btn === 'a') return startGame(games[gameIdx]);
  else return;
  renderGrid();
}

/* ---------------------------------------------------------------- playing */

function startGame(g) {
  currentGame = g;
  const { p, tier } = platforms[platIdx];
  if (tier === 'local') startLocal(p, g); else startStream(p, g);
}

// EmulatorJS owns the pad during local play, but our polling is non-exclusive:
// watch for Menu+View held ~1 s to quit back to the library. Read through GP so
// this works whether input comes from the Gamepad API or the native host.
/* A transient line over a running game. EmulatorJS owns the screen during play,
 * so this is the only way to tell the player something without stopping them. */
function flashLocalNotice(text, ms) {
  const overlay = $('local-overlay');
  const msg = $('local-msg');
  if (!overlay || !msg) return;
  msg.textContent = text;
  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), ms || 6000);
}

function armLocalQuitWatcher() {
  let heldSince = 0;
  const iv = setInterval(() => {
    if (view !== 'local') { clearInterval(iv); return; }
    if (GP.isHeld('select') && GP.isHeld('start')) {
      if (!heldSince) heldSince = Date.now();
      else if (Date.now() - heldSince > 1000) { releaseBlobs(); location.reload(); }
    } else heldSince = 0;
  }, 100);
}

/* The URL to load EmulatorJS's loader.js from.
 *
 * EmulatorJS comes from the user's own RomM, and on a plain-http server the
 * console cannot load most of it the ordinary way: loader.js and
 * emulator.min.js arrive as <script src>, emulator.min.css as a <link href>,
 * and from this app's https origin all three are active mixed content — blocked
 * inside the renderer before the native bridge or any of our code can see the
 * request. That is why a plain-http RomM browsed perfectly and then failed the
 * moment somebody pressed A.
 *
 * Fetching them natively and handing them over as blob: URLs is the route that
 * works, and EmulatorJS is built to allow exactly this: EJS_paths overrides any
 * file by basename, and its downloader takes the plain fetch() branch for any
 * non-http URL. Everything else it wants — cores, BIOS, localization — goes
 * through fetch or XMLHttpRequest, which the bridge already covers.
 *
 * An https server needs none of this and keeps the direct, verified path.
 */
async function emulatorJsLoaderSrc() {
  const data = ROMM.emulatorJsData();
  if (!HOST.needsNative(data)) return data + 'loader.js';

  const [loader, minJs, minCss] = await Promise.all([
    ROMM.assetBlobUrl(data + 'loader.js'),
    ROMM.assetBlobUrl(data + 'emulator.min.js'),
    ROMM.assetBlobUrl(data + 'emulator.min.css'),
  ]);
  blobUrls.push(loader, minJs, minCss);
  window.EJS_paths = Object.assign({}, window.EJS_paths, {
    'emulator.min.js': minJs,
    'emulator.min.css': minCss,
  });
  return loader;
}

async function startLocal(p, g) {
  show('local');
  releaseBlobs();
  activeStateId = null;
  const overlay = $('local-overlay');
  overlay.classList.remove('hidden');
  $('local-msg').textContent = 'Loading ' + (g.name || g.fs_name) + '…';
  armLocalQuitWatcher();

  let romUrl, stateUrl = null;
  try {
    romUrl = await ROMM.romBlobUrl(g, (got, total) => {
      $('local-msg').textContent = total
        ? `Loading ${g.name || g.fs_name} — ${Math.floor(got / total * 100)}%`
        : `Loading ${g.name || g.fs_name} — ${(got / 1048576).toFixed(1)} MB`;
    });
    blobUrls.push(romUrl);
  } catch (e) {
    noteFailure('rom download', e);
    if (e instanceof ROMM.AuthError) {
      $('local-msg').textContent = 'Sign-in expired. Press B to sign in again.';
    } else {
      $('local-msg').textContent =
        playFailureMessage('ROM downloads', e) + '  (B to go back)';
    }
    return;
  }

  // Resume the newest server-side state for this ROM, if there is one.
  try {
    const list = await ROMM.states(g.id);
    const newest = (list || []).slice().sort(
      (a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
    if (newest) {
      activeStateId = newest.id;
      stateUrl = await ROMM.stateBlobUrl(newest);
      blobUrls.push(stateUrl);
    }
  } catch (_) { /* states are a nicety; never block play on them */ }

  const core = EJS_CORES[p.slug];
  window.EJS_player = '#game';
  window.EJS_core = core;
  window.EJS_gameName = g.name || g.fs_name;
  window.EJS_gameUrl = romUrl;
  window.EJS_pathtodata = ROMM.emulatorJsData();
  window.EJS_startOnLoaded = true;
  window.EJS_Buttons = { quickSave: true, quickLoad: true };
  if (stateUrl) window.EJS_loadStateURL = stateUrl;
  window.EJS_onSaveState = async e => {
    try {
      activeStateId = await ROMM.putState(g.id, activeStateId, e.state, core);
      saveStateTrouble = '';
    } catch (err) {
      // Never block play on an upload. But do not stay silent either: this
      // failed for every plain-http server for as long as the bridge dropped
      // non-string bodies, and because it was swallowed here the player saw
      // EmulatorJS report a successful save and lost it on quit. Record it so
      // Diagnostics can say so, and warn once on screen.
      noteFailure('save state upload', err);
      if (!saveStateTrouble) {
        saveStateTrouble = (err && err.message) || 'upload failed';
        flashLocalNotice('Save states are not reaching your server. '
          + 'Play continues, but quick-saves will not persist.');
      }
    }
  };

  let loaderSrc;
  try {
    loaderSrc = await emulatorJsLoaderSrc();
  } catch (e) {
    noteFailure('emulatorjs', e);
    overlay.classList.remove('hidden');
    $('local-msg').textContent = playFailureMessage('EmulatorJS', e) + '  (B to go back)';
    return;
  }

  const s = document.createElement('script');
  s.src = loaderSrc;
  s.onerror = () => {
    overlay.classList.remove('hidden');
    $('local-msg').textContent = isCrossOrigin()
      ? crossOriginFileHint('EmulatorJS') + '  (B to go back)'
      : 'Your RomM server did not serve EmulatorJS (/assets/emulatorjs/). ' +
        'Update RomM, or add a stream server in Settings.  (B to go back)';
  };
  s.onload = () => overlay.classList.add('hidden');
  document.body.appendChild(s);

  // EmulatorJS detects the pad but only assigns it to a player on its own
  // 'connected' event, and only once its control-settings labels exist. The
  // native (host) controller is present from the very first frame, so that
  // event fires before those labels are built and the pad is left detected but
  // unassigned: gamepadSelection stays empty, so not one button reaches the
  // running game. That is the "controller does nothing once a game loads" bug.
  // Bind the first pad to player 1 as soon as the emulator and the pad are
  // both live.
  bindHostPadToPlayerOne();
}

// Poll until EmulatorJS and a pad are both up, then, if EmulatorJS has not
// already claimed the pad for a player, claim it for player 1. Only ever fills
// an EMPTY slot, so a player who reassigns controllers in EmulatorJS's own
// settings is never overridden. Self-terminating: it stops on the first
// successful bind, when local play ends, or after a bounded wait.
function bindHostPadToPlayerOne() {
  let tries = 0;
  const iv = setInterval(() => {
    tries++;
    try {
      const e = window.EJS_emulator;
      const gp = e && e.gamepad;
      const pad = gp && gp.gamepads && gp.gamepads[0];
      if (e && pad && Array.isArray(e.gamepadSelection)) {
        if (!e.gamepadSelection[0]) {
          e.gamepadSelection[0] = pad.id + '_' + pad.index;
          if (typeof e.updateGamepadLabels === 'function') e.updateGamepadLabels();
        }
        clearInterval(iv);
      }
    } catch (_) { /* keep polling until the emulator is up */ }
    if (view !== 'local' || tries > 150) clearInterval(iv);
  }, 100);
}

function startStream(p, g) {
  if (!CFG.stream) {
    $('lib-status').textContent =
      'This platform needs a stream server — add one in Settings (Y).';
    return;
  }
  show('stream');
  $('quit-hint').classList.remove('hidden');
  $('stream-overlay').classList.remove('hidden');
  $('stream-msg').textContent = 'Starting ' + (g.name || g.fs_name) + '…';
  // Analog sticks only matter while a stream is on screen, and reporting them
  // otherwise would push messages down a closed channel.
  GP.onAxes(axes => RTC.sendAxes(axes));
  RTC.play(p.slug, g.fs_name, $('stream-video'), st => {
    if (st === 'connected') $('stream-overlay').classList.add('hidden');
    else if (String(st).startsWith('error')) $('stream-msg').textContent = st;
  }, () => {
    GP.onAxes(null);
    if (view === 'stream') { show('library'); renderGrid(); }
  });
}

/* ----------------------------------------------------- input dispatch */

GP.onUI(btn => {
  if (OSK.active) return OSK.input(btn);
  if (view === 'diag') return diagInput(btn);
  if (view === 'setup') return setupInput(btn);
  if (view === 'auth') return authInput(btn);
  if (view === 'library') return libraryInput(btn);
  if (view === 'local' && btn === 'b') { releaseBlobs(); location.reload(); }
});

GP.onRaw((btn, pressed) => {
  if (view !== 'stream') return;
  RTC.sendInput(btn, pressed);
  if (GP.isHeld('start') && GP.isHeld('select')) {
    if (!quitHold) quitHold = Date.now();
    else if (Date.now() - quitHold > 1000) {
      quitHold = 0;
      RTC.stop(() => {});
      show('library');
      renderGrid();
    }
  } else quitHold = 0;
});

/* ------------------------------------------------------------------ boot */

// A deployment that reverse-proxies RomM at /romm (the same-origin layout this
// project ships) can be offered as a one-press choice instead of typing a URL.
let sameOriginServer = '';
async function detectSameOrigin() {
  for (const suffix of ['/romm', '']) {
    try {
      const r = await fetch(location.origin + suffix + '/api/heartbeat');
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.SYSTEM && j.SYSTEM.VERSION) return location.origin + suffix;
    } catch (_) { /* try the next candidate */ }
  }
  return '';
}

/* Correct settings written by an older build.
 *
 * An app update keeps its local storage, so a value stored by a buggier version
 * outlives the fix. Specifically: before scheme probing existed, a bare host the
 * user typed was always saved as https://, which is wrong for most servers on a
 * LAN. A tester who updates would fail to connect exactly as before and quite
 * reasonably report that the fix did not work — so re-check the stored address
 * once and correct the scheme if the other one answers. */
async function migrateConfig() {
  if (CFG.schema >= CFG.SCHEMA) return '';
  let note = '';
  const stored = CFG.server;
  if (stored) {
    try {
      await ROMM.probe(stored);
    } catch (_) {
      const alt = CFG.otherScheme(stored);
      if (alt) {
        try {
          await ROMM.probe(alt);
          CFG.server = alt;
          // The token was issued by the same server, so it stays valid.
          note = 'Updated your server address to ' + alt + '.';
        } catch (_) { /* neither answers; leave it for the user to fix */ }
      }
    }
  }
  CFG.schema = CFG.SCHEMA;
  return note;
}

(async () => {
  const migrated = await migrateConfig();
  if (CFG.server && CFG.token) {
    if (migrated) lastFailure = '';
    return enterLibrary();
  }
  sameOriginServer = await detectSameOrigin();
  if (CFG.server) { renderSetup(migrated); return enterAuth(); }
  show('setup');
  renderSetup(migrated);
})();
