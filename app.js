/* RomM for Xbox — gamepad-first client for *any* RomM server.
 *
 * There is no backend of ours in the play path: the user points the app at
 * their own RomM and that server supplies the library, the ROM bytes,
 * EmulatorJS and the save states. A stream server (RommStreamServer) is
 * optional and only adds the platforms EmulatorJS cannot run. */
'use strict';

const VIEWS = ['setup', 'auth', 'osk', 'library', 'local', 'stream'];
let view = 'setup';
let platforms = [], platIdx = 0;
let games = [], gameIdx = 0;
const GRID_COLS = 8;          // must match grid-template-columns in style.css
const PAGE_SIZE = 500;
let currentGame = null, quitHold = 0, activeStateId = null, blobUrls = [];

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

/* EmulatorJS cores by RomM platform slug. Presence here *is* the "plays on the
 * console" decision — no server round-trip needed to know it. */
const EJS_CORES = {
  nes: 'nes', famicom: 'nes', fds: 'nes', snes: 'snes', sfam: 'snes',
  n64: 'n64', gb: 'gb', gbc: 'gbc', gba: 'gba', nds: 'nds',
  'genesis-slash-megadrive': 'segaMD', sms: 'segaMS', gamegear: 'segaGG',
  sega32: 'sega32x', segacd: 'segaCD', saturn: 'segaSaturn',
  psx: 'psx', ps: 'psx', psp: 'psp', arcade: 'arcade', mame: 'mame2003',
  neogeoaes: 'arcade', neogeomvs: 'arcade', 'neo-geo-pocket': 'ngp',
  'neo-geo-pocket-color': 'ngp', atari2600: 'atari2600',
  atari5200: 'atari5200', atari7800: 'atari7800', 'atari-2600': 'atari2600',
  lynx: 'lynx', jaguar: 'jaguar', '3do': '3do', colecovision: 'coleco',
  'turbografx16--1': 'pce', 'turbografx-16-slash-pc-engine-cd': 'pcecd',
  wonderswan: 'ws', 'wonderswan-color': 'ws', virtualboy: 'vb',
  'vic-20': 'vic20', c64: 'vice_x64', amiga: 'amiga',
  amstradcpc: 'amstradcpc', zxs: 'zx', dos: 'dos',
};

const tierFor = slug =>
  EJS_CORES[slug] ? 'local' : (CFG.stream ? 'stream' : 'none');

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
    hint: 'D-pad move · A press · B backspace · X shift · Menu done',
    value: CFG.server || 'https://',
    onSubmit: async raw => {
      const server = CFG.normalize(raw);
      if (!server) return OSK.setStatus('That is not a valid address.');
      OSK.setStatus('Checking ' + server + ' …');
      try {
        const { version } = await ROMM.probe(server);
        CFG.server = server;
        CFG.clearAuth();
        OSK.close();
        show('setup');
        renderSetup('Found RomM ' + version + '. Now sign in.');
        setupIdx = setupItems().length - 1;
        renderSetup();
      } catch (e) {
        OSK.setStatus(probeMessage(e, server));
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
    return 'Could not reach ' + server + ' — check the address and that the ' +
           'server is online.';
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

function setupInput(btn) {
  const items = setupItems();
  if (btn === 'up') setupIdx = (setupIdx + items.length - 1) % items.length;
  else if (btn === 'down') setupIdx = (setupIdx + 1) % items.length;
  else if (btn === 'a') return items[setupIdx].go();
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
    hint: 'A press · B backspace · Menu done',
    value: '',
    onSubmit: username => {
      if (!username.trim()) return OSK.setStatus('Enter your username.');
      OSK.open({
        title: 'Password for ' + username,
        hint: 'A press · B backspace · Menu done',
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
  if (btn === 'y') { show('setup'); return renderSetup(''); }
  if (authIdx === 1) {
    if (btn === 'a') return askCredentials();
    return;
  }
  if (btn === 'left') padIdx = (padIdx + PAD.length - 1) % PAD.length;
  else if (btn === 'right') padIdx = (padIdx + 1) % PAD.length;
  else if (btn === 'up') padIdx = (padIdx + PAD.length - 6) % PAD.length;
  else if (btn === 'down') padIdx = (padIdx + 6) % PAD.length;
  else if (btn === 'b') code = code.slice(0, -1);
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
    const all = await ROMM.platforms();
    platforms = all
      .filter(p => p.rom_count)
      .map(p => ({ p, tier: tierFor(p.slug) }))
      .filter(x => x.tier !== 'none');
    if (!platforms.length) {
      $('lib-status').textContent = all.length
        ? 'None of your platforms can play here yet. Add a stream server in ' +
          'Settings (Y) for GameCube, Wii, PS2, Saturn or Dreamcast.'
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
    $('lib-status').textContent = games.length ? '' : 'No games on this platform.';
  } catch (e) {
    if (e instanceof ROMM.AuthError) { CFG.clearAuth(); return enterAuth(); }
    $('lib-status').textContent = 'Could not load games: ' + e.message;
  }
}

function renderRail() {
  const rail = $('platform-rail');
  rail.innerHTML = '';
  platforms.forEach(({ p }, i) => {
    const d = document.createElement('div');
    d.className = 'plat' + (i === platIdx ? ' current' : '');
    d.textContent = p.display_name || p.name || p.slug;
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

// EmulatorJS owns the pad during local play, but the Gamepad API is poll-based
// and non-exclusive: watch for Menu+View held ~1 s to quit back to the library.
function armLocalQuitWatcher() {
  let heldSince = 0;
  const iv = setInterval(() => {
    if (view !== 'local') { clearInterval(iv); return; }
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = [...pads].find(x => x && x.connected);
    const held = p && p.buttons[8] && p.buttons[9] &&
                 p.buttons[8].pressed && p.buttons[9].pressed;
    if (held) {
      if (!heldSince) heldSince = Date.now();
      else if (Date.now() - heldSince > 1000) location.reload();
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
  RTC.play(p.slug, g.fs_name, $('stream-video'), st => {
    if (st === 'connected') $('stream-overlay').classList.add('hidden');
    else if (String(st).startsWith('error')) $('stream-msg').textContent = st;
  }, () => {
    if (view === 'stream') { show('library'); renderGrid(); }
  });
}

/* ----------------------------------------------------- input dispatch */

GP.onUI(btn => {
  if (OSK.active) return OSK.input(btn);
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

(async () => {
  if (CFG.server && CFG.token) return enterLibrary();
  sameOriginServer = await detectSameOrigin();
  if (CFG.server) { renderSetup(''); return enterAuth(); }
  show('setup');
  renderSetup('');
})();
