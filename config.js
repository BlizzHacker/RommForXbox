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
    schema: 'romm_schema',
  };

  // Bump when stored values need revisiting on upgrade. An app update keeps its
  // local storage, so a setting written by an older, buggier version outlives the
  // fix — which reads to the user as the fix not working.
  const SCHEMA = 2;
  const get = k => localStorage.getItem(k) || '';
  const set = (k, v) => v ? localStorage.setItem(k, v) : localStorage.removeItem(k);

  // "romm.example.com/" → "https://romm.example.com". A scheme-less string gets
  // https, but callers should prefer candidates() and let the scheme be probed.
  function normalize(raw) {
    let s = (raw || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      return (u.origin + u.pathname).replace(/\/+$/, '');
    } catch (_) { return ''; }
  }

  // A LAN box is almost always plain http, and a box reachable from anywhere is
  // almost always https. Guessing wrong is indistinguishable from "server not
  // found", so when the user gives no scheme, try the likely one first and fall
  // back — nobody should have to type "http://" to reach their own NAS.
  function isLanHost(host) {
    return /^(10\.|127\.|169\.254\.|192\.168\.)/.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || /\.local$/i.test(host)
        || !host.includes('.');            // a bare hostname is not on the internet
  }

  // Ordered list of full URLs to try for what the user typed.
  function candidates(raw) {
    const s = (raw || '').trim().replace(/\/+$/, '');
    if (!s) return [];
    if (/^https?:\/\//i.test(s)) {
      const n = normalize(s);
      return n ? [n] : [];
    }
    const host = s.split(/[/?#]/)[0].split(':')[0];
    const order = isLanHost(host) ? ['http://', 'https://'] : ['https://', 'http://'];
    return order.map(p => normalize(p + s)).filter(Boolean);
  }

  // An https page cannot fetch an http origin — the request is blocked in the
  // renderer, which otherwise surfaces as an unexplained failure. Inside the
  // shell this does not apply: every server request is routed through our own
  // origin and unwrapped natively (see HOST.route).
  function mixedContentBlocked(server) {
    if (typeof HOST !== 'undefined' && HOST.present) return false;
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
    SCHEMA,
    get schema() { return Number(get(K.schema) || 0); },
    set schema(v) { set(K.schema, String(v)); },
    // The same host on the other scheme, for correcting a stored value.
    otherScheme(server) {
      const s = String(server || '');
      if (/^https:\/\//i.test(s)) return s.replace(/^https:/i, 'http:');
      if (/^http:\/\//i.test(s)) return s.replace(/^http:/i, 'https:');
      return '';
    },
    normalize,
    candidates,
    mixedContentBlocked,
  };
})();
