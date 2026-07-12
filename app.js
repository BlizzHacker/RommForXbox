/* RomM for Xbox — gamepad-first RomM client for Xbox Edge.
 * Same-origin routes (nginx): /romm/ → RomM API, /api/ → stream server,
 * /emu/ → EmulatorJS. */
'use strict';

const TOKEN_KEY = 'romm_token';
let token = localStorage.getItem(TOKEN_KEY) || '';
let view = 'pair';                 // pair | library | local | stream
let platforms = [], platIdx = 0;
let games = [], gameIdx = 0, gridCols = 6;
let currentGame = null, quitHold = 0;

const $ = id => document.getElementById(id);
const show = v => {
  for (const x of ['pair', 'library', 'local', 'stream'])
    $('view-' + x).classList.toggle('hidden', x !== v);
  view = v;
};

async function romm(path) {
  const r = await fetch('/romm' + path,
    { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401 || r.status === 403) { throw new Error('auth'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------------------------------------------------------- pairing */
let code = '', padIdx = 0;
const PAD = ['1','2','3','4','5','6','7','8','9','0','←','OK'];

function renderPair(status) {
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
  if (status !== undefined) $('pair-status').textContent = status;
}

async function submitPair() {
  if (code.length !== 8) { renderPair('Enter all eight digits.'); return; }
  renderPair('Pairing securely with RomM…');
  try {
    const r = await fetch('/romm/api/client-tokens/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.raw_token) {
      renderPair('Pairing failed — codes are single-use and expire in 5 min.');
      code = ''; renderPair();
      return;
    }
    token = j.raw_token;
    localStorage.setItem(TOKEN_KEY, token);
    enterLibrary();
  } catch (e) { renderPair('Could not reach RomM: ' + e.message); }
}

function pairInput(btn) {
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
  }
  renderPair();
}

/* ---------------------------------------------------------- library */
async function enterLibrary() {
  show('library');
  $('lib-status').textContent = 'Loading your RomM library…';
  try {
    let all = await romm('/api/platforms');
    // keep only platforms with games and a playable tier
    const checks = await Promise.all(all.map(async p => {
      if (!p.rom_count) return null;
      const r = await fetch('/api/play/route?platform=' +
                            encodeURIComponent(p.slug));
      return r.ok ? { p, tier: (await r.json()).tier } : null;
    }));
    platforms = checks.filter(Boolean);
    if (!platforms.length) {
      $('lib-status').textContent = 'No playable platforms found.';
      return;
    }
    platIdx = Math.min(platIdx, platforms.length - 1);
    await loadGames();
  } catch (e) {
    if (e.message === 'auth') {
      localStorage.removeItem(TOKEN_KEY); token = '';
      show('pair'); renderPair('Token expired or revoked — pair again.');
    } else $('lib-status').textContent = 'RomM unreachable: ' + e.message;
  }
}

async function loadGames() {
  const { p, tier } = platforms[platIdx];
  $('lib-title').textContent = p.display_name || p.name || p.slug;
  $('lib-status').textContent = 'Loading games…';
  renderRail();
  const j = await romm('/api/roms?platform_ids=' + p.id +
    '&limit=500&order_by=name&order_dir=asc' +
    '&with_char_index=false&with_filter_values=false');
  games = (j.items || j || []).filter(g => g.fs_name &&
    !/\.(exe|msi|bat)$/i.test(g.fs_name));
  gameIdx = 0;
  $('lib-count').textContent =
    games.length + ' games · ' + (tier === 'local' ? 'plays on Xbox' : 'streams');
  renderGrid();
  $('lib-status').textContent = games.length ? '' : 'No games on this platform.';
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
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/romm/api/roms/' + g.id + '/cover';
    img.onerror = () => { img.removeAttribute('src'); };
    const cap = document.createElement('div');
    cap.className = 't';
    cap.textContent = g.name || g.fs_name_no_ext || g.fs_name;
    t.append(img, cap);
    grid.appendChild(t);
  });
  const cur = grid.children[gameIdx];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function libraryInput(btn) {
  if (!platforms.length) return;
  if (btn === 'l1') { platIdx = (platIdx + platforms.length - 1) % platforms.length; loadGames(); return; }
  if (btn === 'r1') { platIdx = (platIdx + 1) % platforms.length; loadGames(); return; }
  if (btn === 'x') { loadGames(); return; }
  if (!games.length) return;
  const last = games.length - 1;
  if (btn === 'left') gameIdx = Math.max(0, gameIdx - 1);
  else if (btn === 'right') gameIdx = Math.min(last, gameIdx + 1);
  else if (btn === 'up') gameIdx = Math.max(0, gameIdx - gridCols);
  else if (btn === 'down') gameIdx = Math.min(last, gameIdx + gridCols);
  else if (btn === 'a') return startGame(games[gameIdx]);
  renderGrid();
}

/* ---------------------------------------------------------- playing */
async function startGame(g) {
  currentGame = g;
  const { p, tier } = platforms[platIdx];
  if (tier === 'local') startLocal(p, g); else startStream(p, g);
}

function ejsCore(slug) {
  const M = { nes:'nes', famicom:'nes', fds:'nes', snes:'snes', sfam:'snes',
    n64:'n64', gb:'gb', gbc:'gbc', gba:'gba', nds:'nds',
    'genesis-slash-megadrive':'segaMD', sms:'segaMS', gamegear:'segaGG',
    sega32:'sega32x', segacd:'segaCD', saturn:'segaSaturn',
    psx:'psx', ps:'psx', psp:'psp', arcade:'arcade', mame:'mame2003',
    neogeoaes:'arcade', neogeomvs:'arcade', 'neo-geo-pocket':'ngp',
    'neo-geo-pocket-color':'ngp', atari2600:'atari2600',
    atari5200:'atari5200', atari7800:'atari7800', lynx:'lynx',
    jaguar:'jaguar', '3do':'3do', colecovision:'coleco',
    'turbografx16--1':'pce', 'turbografx-16-slash-pc-engine-cd':'pcecd',
    wonderswan:'ws', 'wonderswan-color':'ws', virtualboy:'vb',
    'vic-20':'vic20', c64:'vice_x64', amiga:'amiga',
    amstradcpc:'amstradcpc', zxs:'zx', dos:'dos' };
  return M[slug] || slug;
}

async function startLocal(p, g) {
  show('local');
  const saveUrl = '/api/saves/' + encodeURIComponent(p.slug) + '/' +
                  encodeURIComponent(g.fs_name);
  window.EJS_player = '#game';
  window.EJS_core = ejsCore(p.slug);
  window.EJS_gameName = g.name || g.fs_name;
  window.EJS_gameUrl = '/api/romfile/' + encodeURIComponent(p.slug) + '/' +
                       encodeURIComponent(g.fs_name);
  window.EJS_pathtodata = '/emu/data/';
  window.EJS_startOnLoaded = true;
  window.EJS_Buttons = { quickSave: true, quickLoad: true };
  window.EJS_onSaveState = async e => {   // persist to server
    try { await fetch(saveUrl, { method: 'PUT', body: e.state }); } catch (_) {}
  };
  try {                                    // resume if a server save exists
    const head = await fetch(saveUrl);
    if (head.ok) window.EJS_loadStateURL = saveUrl;
  } catch (_) {}
  const s = document.createElement('script');
  s.src = '/emu/data/loader.js';
  document.body.appendChild(s);
  // exiting EJS = full reload back to the library (state uploaded via menu)
}

function startStream(p, g) {
  show('stream');
  $('quit-hint').classList.remove('hidden');
  $('stream-overlay').classList.remove('hidden');
  $('stream-msg').textContent = 'Starting ' + (g.name || g.fs_name) + '…';
  RTC.play(p.slug, g.fs_name, $('stream-video'), st => {
    if (st === 'connected') {
      $('stream-overlay').classList.add('hidden');
    } else if (String(st).startsWith('error')) {
      $('stream-msg').textContent = st;
    }
  }, () => {                       // ended
    if (view === 'stream') { show('library'); renderGrid(); }
  });
}

/* --------------------------------------------------- input dispatch */
GP.onUI(btn => {
  if (view === 'pair') pairInput(btn);
  else if (view === 'library') libraryInput(btn);
});

GP.onRaw((btn, pressed) => {
  if (view !== 'stream') return;
  RTC.sendInput(btn, pressed);
  // Menu+View held together ~1 s = quit
  if (GP.isHeld('start') && GP.isHeld('select')) {
    if (!quitHold) quitHold = Date.now();
    else if (Date.now() - quitHold > 1000) {
      quitHold = 0;
      RTC.stop(() => {});
      show('library'); renderGrid();
    }
  } else quitHold = 0;
});

/* ------------------------------------------------------------ boot */
if (token) enterLibrary(); else { show('pair'); renderPair(''); }
