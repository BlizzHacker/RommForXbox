/* RomM for Xbox — gamepad-first client for *any* RomM server.
 *
 * There is no backend of ours in the play path: the user points the app at
 * their own RomM and that server supplies the library, the ROM bytes,
 * EmulatorJS and the save states. A stream server (RommStreamServer) is
 * optional and only adds the platforms EmulatorJS cannot run. */
'use strict';

const VIEWS = ['setup', 'auth', 'osk', 'library', 'local', 'stream', 'diag'];
const BUILD = '0.9.0.0';        // keep in step with Package.appxmanifest
let view = 'setup';
let platforms = [], platIdx = 0;
let games = [], gameIdx = 0;
const GRID_COLS = 8;          // must match grid-template-columns in style.css
const PAGE_SIZE = 500;
let currentGame = null, quitHold = 0, activeStateId = null, blobUrls = [];
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
let streamable = null, streamWhy = {};

async function refreshStreamable() {
  if (!CFG.stream) { streamable = null; streamWhy = {}; return; }
  try {
    const r = await fetch(HOST.route(CFG.stream) + '/api/play/streamable');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    streamable = new Set(j.streamable || []);
    streamWhy = j.unavailable || {};
  } catch (_) {
    // An older stream server has no such endpoint; fall back to the built-in
    // list rather than showing the user nothing.
    streamable = null;
    streamWhy = {};
  }
}

function tierFor(slug) {
  if (EJS_CORES[slug]) return 'local';
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
        OSK.setStatus(probeMessage(e, list[list.length - 1]));
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

function probeMessage(e, server) {
  if (e.message === 'mixed-content')
    return 'This app is served over HTTPS, so it cannot reach an http:// ' +
           'server. Use an https:// address for your RomM.';
  if (e.message === 'not-romm')
    return 'Reached that address but it is not a RomM server.';
  if (e instanceof ROMM.NetError)
    return 'Could not reach ' + server + ' over http or https — check the ' +
           'address, and that the console is on the same network as the server.';
  return 'Unexpected error: ' + e.message;
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

const isCrossOrigin = () => {
  try { return new URL(CFG.server).origin !== location.origin; }
  catch (_) { return false; }
};

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

async function renderDiag(status) {
  const rows = [
    ['Build', BUILD],
    ['Running in', HOST.present ? 'Xbox app (native host)' : 'browser'],
    ['Controller', GP.usingHost ? 'via native host'
      : ((navigator.getGamepads ? [...navigator.getGamepads()] : [])
          .filter(Boolean).length ? 'via Gamepad API' : 'not detected')],
    ['RomM server', CFG.server || 'not set'],
    ['Signed in', CFG.token ? 'yes (' + (CFG.mode || 'client') + ')' : 'no'],
    ['Stream server', CFG.stream || 'none'],
    ['Playable platforms', platforms.length ? String(platforms.length) : '—'],
    ['Last failure', lastFailure || 'none'],
  ];
  if (HOST.present && CFG.server) {
    rows.splice(4, 0, ['Requests routed as', HOST.route(CFG.server)]);
  }
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
    // The check that actually matters: ROM bytes and EmulatorJS come from paths
    // RomM does not add CORS headers to, which is what the native host works
    // around. Browsing can succeed while play fails.
    try {
      const r = await fetch(ROMM.emulatorJsData() + 'loader.js');
      results.push(r.ok ? 'EmulatorJS reachable' : 'EmulatorJS HTTP ' + r.status);
    } catch (e) {
      results.push('EmulatorJS UNREACHABLE — ' + (e.message || 'error'));
    }
  }
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
const PAD = ['1','2','3','4','5','6','7','8','9','0','←','OK'];

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
    $('pair-code').textContent =
      (code + '········'.slice(code.length)).split('').join(' ');
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
  if (code.length !== 8) return renderAuth('Enter all eight digits.');
  renderAuth('Pairing with RomM…');
  try {
    CFG.token = await ROMM.exchangePairCode(code);
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

async function loadGames() {
  const { p, tier } = platforms[platIdx];
  $('lib-title').textContent = p.display_name || p.name || p.slug;
  $('lib-status').textContent = 'Loading games…';
  renderRail();
  try {
    const j = await ROMM.roms(p.id, PAGE_SIZE);
    games = (j.items || j || []).filter(g =>
      (g.fs_name || g.file_name) && !/\.(exe|msi|bat|sh)$/i.test(g.fs_name || ''));
    gameIdx = 0;
    // j.total is the whole platform; games is one page of it. Saying "500
    // games" for a 4,414-game platform is simply wrong.
    const total = Number(j.total) || games.length;
    $('lib-count').textContent =
      (total > games.length ? `${games.length} of ${total} games`
                            : `${games.length} games`) + ' · ' +
      (tier === 'local' ? 'plays on this console' : 'streams from your server');
    renderGrid();
    $('lib-status').textContent = games.length ? footnote() : 'No games on this platform.';
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
      img.onerror = () => img.removeAttribute('src');
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
    if (e instanceof ROMM.AuthError) {
      $('local-msg').textContent = 'Sign-in expired. Press B to sign in again.';
    } else if (isCrossOrigin()) {
      $('local-msg').textContent = crossOriginFileHint('ROM downloads') +
        '  (B to go back)';
    } else {
      $('local-msg').textContent =
        'Could not download this game: ' + e.message + '  (B to go back)';
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
    } catch (_) { /* keep playing even if the upload fails */ }
  };

  const s = document.createElement('script');
  s.src = ROMM.emulatorJsData() + 'loader.js';
  s.onerror = () => {
    overlay.classList.remove('hidden');
    $('local-msg').textContent = isCrossOrigin()
      ? crossOriginFileHint('EmulatorJS') + '  (B to go back)'
      : 'Your RomM server did not serve EmulatorJS (/assets/emulatorjs/). ' +
        'Update RomM, or add a stream server in Settings.  (B to go back)';
  };
  s.onload = () => overlay.classList.add('hidden');
  document.body.appendChild(s);
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
