/* RomM API client, bound to whatever server the user configured.
 *
 * Cross-origin is fine: RomM answers every request with
 * `access-control-allow-origin: <request origin>` and
 * `access-control-allow-credentials: true`, so a Bearer token works from any
 * origin — including a packaged app. Nothing here needs a reverse proxy.
 *
 * Everything the app plays comes from the user's own server: ROM bytes,
 * EmulatorJS itself (RomM serves it at /assets/emulatorjs/data/), covers and
 * save states. */
'use strict';

const ROMM = (() => {
  // Every server URL in this file derives from base(), including the ones handed
  // to the browser as <img src> and to EmulatorJS as EJS_pathtodata — so routing
  // for the packaged shell happens in exactly one place. In a browser this is
  // just CFG.server. See HOST.route for why the shell needs it.
  const base = () => HOST.route(CFG.server);

  class AuthError extends Error {}
  // reason is a machine tag ('dns'|'tls'|'refused'|'timeout'|'network'|
  // 'mixed-content'|'not-romm'|'too-large') the setup screen turns into a
  // specific sentence instead of a bare "Failed to fetch".
  class NetError extends Error {
    constructor(message, reason) { super(message); this.reason = reason || message; }
  }

  // The statuses that actually mean "those credentials/that code were wrong".
  // Anything else is a server or network fault wearing an auth costume.
  const isAuthStatus = s => s === 400 || s === 401 || s === 403 || s === 422;

  // Turn a caught renderer/native error into a NetError that keeps its cause.
  function netError(e) {
    if (e instanceof NetError) return e;
    const reason = (e && e.nativeReason) ? e.nativeReason : 'network';
    return new NetError((e && e.message) || 'network', reason);
  }

  // RomM's own scope names. There is no states.* scope — save states are
  // assets, and asking for a scope that does not exist fails the whole grant
  // with "Insufficient scope" rather than just dropping the unknown one.
  const SCOPES = [
    'me.read', 'roms.read', 'platforms.read', 'assets.read', 'devices.read',
    'firmware.read', 'roms.user.read', 'collections.read', 'assets.write',
  ].join(' ');

  // RomM hands back paths containing raw spaces (cover URLs carry a ?ts=
  // stamp, state download paths a ?timestamp=). encodeURI is exactly right
  // here: it fixes the spaces and leaves the ':' and '+' the server accepts.
  const encodePath = p => encodeURI('/' + String(p || '').replace(/^\/+/, ''));

  async function req(path, opts = {}, retried = false) {
    const server = base();
    if (!server) throw new NetError('No server configured');
    if (CFG.mixedContentBlocked(server)) throw new NetError('mixed-content', 'mixed-content');
    let r;
    try {
      r = await HOST.fetch(server + path, {
        ...opts,
        headers: {
          ...(CFG.token ? { Authorization: 'Bearer ' + CFG.token } : {}),
          ...(opts.headers || {}),
        },
      });
    } catch (e) {
      throw netError(e);
    }
    if (r.status === 401 || r.status === 403) {
      // A 30-minute access token will expire mid-session; refresh once and
      // replay before making the user sign in again.
      if (!retried && await refreshAccess()) return req(path, opts, true);
      throw new AuthError('auth');
    }
    // Carry the status as a machine reason too. 'HTTP 404' as the reason fell
    // through every case in the message table and came out as the generic
    // "check the address" line, which is the wrong advice for a file the server
    // simply does not have.
    if (!r.ok) throw new NetError('HTTP ' + r.status, 'http-' + r.status);
    return r;
  }

  async function refreshAccess() {
    if (CFG.mode !== 'password' || !CFG.refresh) return false;
    try {
      const r = await HOST.fetch(base() + '/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: CFG.refresh,
        }).toString(),
      });
      if (!r.ok) return false;
      const j = await r.json();
      if (!j.access_token) return false;
      CFG.token = j.access_token;
      if (j.refresh_token) CFG.refresh = j.refresh_token;
      return true;
    } catch (_) { return false; }
  }

  /* req() wraps only the request. The body is read here, and a failure reading
   * it used to escape netError() completely -- so a reverse proxy or captive
   * portal answering with an HTML sign-in page produced "Could not reach
   * <server>. Check the address, the port, and that this console is on the same
   * network", which is the wrong conclusion from the one server that definitely
   * answered. */
  const json = async (path, opts) => {
    const r = await req(path, opts);
    try {
      return await r.json();
    } catch (e) {
      if (e && e.nativeReason) throw netError(e);
      throw new NetError('bad-json', 'bad-json');
    }
  };

  /* ---------------------------------------------------------------- auth */

  // Unauthenticated: probes that a URL really is a RomM server before we
  // store it, and tells the setup screen which sign-in routes exist.
  async function probe(server) {
    if (CFG.mixedContentBlocked(server)) throw new NetError('mixed-content', 'mixed-content');
    let r;
    try {
      r = await HOST.fetch(HOST.route(server) + '/api/heartbeat', { method: 'GET' });
    } catch (e) {
      throw netError(e);
    }
    if (!r.ok) throw new NetError('HTTP ' + r.status, 'http-' + r.status);
    let j;
    try {
      j = await r.json();
    } catch (e) {
      // A body that failed to ARRIVE is a transport fault, not a verdict about
      // what the server is -- and the difference matters more than it looks:
      // probeAny treats 'not-romm' as a definitive answer and stops trying the
      // other scheme, so one dropped packet could permanently block the
      // http/https fallback the user depends on. Only a body that arrived and
      // was not RomM's JSON earns that tag.
      if (e && e.nativeReason) throw netError(e);
      throw new NetError('not-romm', 'not-romm');
    }
    if (!j || !j.SYSTEM || !j.SYSTEM.VERSION) throw new NetError('not-romm', 'not-romm');
    return { version: j.SYSTEM.VERSION };
  }

  // Tries each candidate in turn and returns the first that really is a RomM,
  // so the user can type "192.168.1.42" and not care about the scheme. The last
  // error is kept: if nothing answers, that one describes the likeliest attempt.
  async function probeAny(list, onTry, onFail) {
    let last = new NetError('network');
    for (const server of list || []) {
      if (onTry) onTry(server);
      try {
        const { version } = await probe(server);
        return { server, version };
      } catch (e) {
        // Which candidate failed is part of the message. Reporting the last one
        // in the list named the https attempt for someone who typed a bare LAN
        // IP, describing a port they never asked about while discarding the
        // http attempt's error, which was the informative one.
        e.server = server;
        last = e;
        if (onFail) onFail(server, e);
        // A server that answered but is not RomM is a definite answer; trying
        // the same host on another scheme will not change it.
        if (e instanceof NetError && e.message === 'not-romm') throw e;
      }
    }
    throw last;
  }

  // Pairing: RomM mints an alphanumeric code for a scoped client token, so the
  // app never handles the account password.
  async function exchangePairCode(code) {
    const r = await HOST.fetch(base() + '/api/client-tokens/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }).catch(e => { throw netError(e); });
    // Only a credential rejection is an AuthError. Collapsing every non-2xx
    // into one meant a RomM too old to have this endpoint answered 404 and the
    // user was told their pairing code had expired -- so they generated code
    // after code, forever, against a server that has no pairing at all.
    if (!r.ok && !isAuthStatus(r.status)) {
      throw new NetError('HTTP ' + r.status, 'http-' + r.status);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.raw_token) throw new AuthError('pair-failed');
    return j.raw_token;
  }

  // Direct sign-in, for anyone who cannot reach RomM's web UI to make a code
  // (a controller-only console, or a reviewer with just an account).
  async function signIn(username, password) {
    // Sending no scope is not a shortcut: the grant then carries an empty
    // scope set and every library call comes back 403.
    const body = new URLSearchParams({
      grant_type: 'password', username, password, scope: SCOPES,
    });
    const r = await HOST.fetch(base() + '/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }).catch(e => { throw netError(e); });
    if (!r.ok && !isAuthStatus(r.status)) {
      throw new NetError('HTTP ' + r.status, 'http-' + r.status);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new AuthError(j.detail || 'signin-failed');
    return { token: j.access_token, refresh: j.refresh_token || '' };
  }

  /* ------------------------------------------------------------- library */

  const platforms = () => json('/api/platforms');

  function roms(platformId, limit = 500) {
    // with_char_index / with_filter_values default to true and aggregate over
    // the whole roms table; on a large library that alone costs tens of
    // seconds and nothing here reads either field.
    const q = new URLSearchParams({
      platform_ids: platformId, limit, order_by: 'name', order_dir: 'asc',
      with_char_index: 'false', with_filter_values: 'false',
    });
    return json('/api/roms?' + q);
  }

  // Covers are served without auth, so they can go straight into an <img src>.
  const coverUrl = rom => {
    const p = rom.path_cover_small || rom.path_cover_large;
    return p ? base() + encodePath(p) : '';
  };

  /* ---------------------------------------------------------------- play */

  const emulatorJsData = () => base() + '/assets/emulatorjs/data/';

  /* Any file on the user's server, as a blob: URL.
   *
   * This is how the console reaches things the renderer will not load itself.
   * The app's own origin is https, so on a plain-http server an <img>, a
   * <script src> or a <link href> pointing at the server is mixed content and
   * is blocked before any of our code runs. Going through HOST.fetch puts the
   * request in native hands, where no such rule applies, and a blob: URL of the
   * result is same-origin for every element that consumes it.
   *
   * Unauthenticated on purpose: covers and EmulatorJS are public paths, and
   * sending a Bearer token to them would only invite a 401 on servers that
   * restrict the header.
   */
  async function assetBlobUrl(url) {
    let r;
    try {
      r = await HOST.fetch(url, { method: 'GET' });
    } catch (e) {
      throw netError(e);
    }
    if (!r.ok) throw new NetError('HTTP ' + r.status, 'http-' + r.status);
    return URL.createObjectURL(await r.blob());
  }

  // EmulatorJS fetches the ROM by URL and cannot attach an Authorization
  // header, so pull the bytes here and hand it a blob: URL instead.
  async function romBlobUrl(rom, onProgress) {
    const name = rom.fs_name || rom.file_name;
    // onProgress rides along in the fetch init: the native bridge reports
    // progress through it as chunks land, and the platform fetch ignores an
    // option it does not know, leaving the reader loop below in charge there.
    const r = await req(
      `/api/roms/${rom.id}/content/${encodeURIComponent(name)}`, { onProgress });
    const total = Number(r.headers.get('content-length')) || 0;
    if (!r.body || !onProgress) return URL.createObjectURL(await r.blob());
    const chunks = [];
    let got = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got, total);
    }
    return URL.createObjectURL(new Blob(chunks));
  }

  /* -------------------------------------------------------- save states */

  const states = romId => json('/api/states?rom_id=' + romId);

  async function putState(romId, existingId, bytes, emulator) {
    const fd = new FormData();
    fd.append('stateFile', new Blob([bytes]),
      (emulator || 'state') + '.state');
    if (existingId) {
      await req('/api/states/' + existingId, { method: 'PUT', body: fd });
      return existingId;
    }
    const q = new URLSearchParams({ rom_id: romId });
    if (emulator) q.set('emulator', emulator);
    const j = await json('/api/states?' + q, { method: 'POST', body: fd });
    return j.id;
  }

  // download_path is server-relative and needs the Bearer token, so fetch it
  // here and give EmulatorJS a blob: URL to load from.
  async function stateBlobUrl(state) {
    const r = await req(encodePath(state.download_path));
    return URL.createObjectURL(await r.blob());
  }

  return {
    AuthError, NetError, SCOPES,
    probe, probeAny, exchangePairCode, signIn, refreshAccess,
    platforms, roms, coverUrl,
    emulatorJsData, romBlobUrl, assetBlobUrl,
    states, putState, stateBlobUrl,
  };
})();
