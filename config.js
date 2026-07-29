/* Persisted settings. The app is a client for *your* RomM server, so the base
 * URL is user-supplied and everything else derives from it. An empty server
 * means first run. */
'use strict';

const CFG = (() => {
  const K = {
    server: 'romm_server', stream: 'romm_stream', token: 'romm_token',
    // A password grant returns an access token good for only 30 minutes plus a
    // 7-day refresh token; a paired client token is long-lived and has neither.
    refresh: 'romm_refresh', mode: 'romm_auth_mode',
  };
  const get = k => localStorage.getItem(k) || '';
  const set = (k, v) => v ? localStorage.setItem(k, v) : localStorage.removeItem(k);

  // "romm.example.com/" → "https://romm.example.com"; a bare host gets https
  // because that is what a reachable-from-anywhere RomM almost always is.
  function normalize(raw) {
    let s = (raw || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      return (u.origin + u.pathname).replace(/\/+$/, '');
    } catch (_) { return ''; }
  }

  // An https page cannot fetch an http origin — the request is blocked before
  // it leaves the app, which otherwise surfaces as an unexplained failure.
  function mixedContentBlocked(server) {
    return location.protocol === 'https:' && /^http:\/\//i.test(server);
  }

  return {
    get server() { return get(K.server); },
    set server(v) { set(K.server, v); },
    get stream() { return get(K.stream); },
    set stream(v) { set(K.stream, v); },
    get token() { return get(K.token); },
    set token(v) { set(K.token, v); },
    get refresh() { return get(K.refresh); },
    set refresh(v) { set(K.refresh, v); },
    get mode() { return get(K.mode); },          // 'password' | 'client'
    set mode(v) { set(K.mode, v); },
    clearAuth() { set(K.token, ''); set(K.refresh, ''); set(K.mode, ''); },
    reset() { for (const k of Object.values(K)) localStorage.removeItem(k); },
    normalize,
    mixedContentBlocked,
  };
})();
