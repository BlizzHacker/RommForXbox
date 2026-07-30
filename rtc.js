/* WebRTC client for the stream tier: recvonly A/V, 'input' data channel.
 *
 * Signaling is HTTP POST, not a WebSocket, and it goes to the *configured stream
 * server* rather than to wherever the app happens to be served from. Both of
 * those were bugs:
 *
 *   * `location.host` is the app's own host. In the packaged shell that is
 *     app.local, so signaling never reached the stream server at all; even in a
 *     browser it only worked when the app and the stream server shared an origin.
 *   * a ws:// URL from the shell's https origin is blocked mixed content, and
 *     WebSockets cannot be routed through the native host's request interception
 *     the way HTTP can. Requiring TLS on a LAN box is not a reasonable answer, so
 *     the offer/answer exchange is two plain POSTs instead. WebRTC media itself
 *     is peer-to-peer UDP and is not subject to any of this.
 */
'use strict';

const RTC = (() => {
  let pc = null, channel = null, sessionId = null, stopped = false;

  const base = () => HOST.route(CFG.stream);

  async function play(platform, romName, videoEl, onStatus, onEnd) {
    stopped = false;
    if (!CFG.stream) { onStatus('error: no stream server configured'); return; }
    onStatus('connecting');

    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.ontrack = e => { videoEl.srcObject = e.streams[0]; };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        onStatus(pc.connectionState);
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
          stop(onEnd);
        }
      };
      channel = pc.createDataChannel('input', { ordered: true });
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await gathered();

      const r = await fetch(base() + '/api/rtc/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform, rom_name: romName, sdp: pc.localDescription.sdp,
        }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(r.status === 404
          ? 'that platform cannot be streamed'
          : 'stream server said ' + r.status + ' ' + detail.slice(0, 120));
      }
      const j = await r.json();
      if (!j.sdp) throw new Error(j.error || 'stream server sent no answer');
      sessionId = j.session_id || null;
      if (stopped) return stop(onEnd);
      await pc.setRemoteDescription({ type: 'answer', sdp: j.sdp });
    } catch (e) {
      onStatus('error: ' + (e.message || 'could not start the stream'));
      stop(onEnd);
    }
  }

  // Trickle ICE needs a signaling channel to trickle over; two POSTs do not have
  // one, so gather fully and send a single complete offer.
  function gathered() {
    return new Promise(res => {
      if (!pc || pc.iceGatheringState === 'complete') return res();
      pc.onicegatheringstatechange = () =>
        pc && pc.iceGatheringState === 'complete' && res();
      setTimeout(res, 3000);
    });
  }

  function sendInput(key, pressed) {
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify({ key, pressed }));
    }
  }

  /* Analog sticks, sent as a batch when they change. Digital-only input makes
   * anything with a 3D camera unplayable, so the server maps these onto a
   * virtual pad rather than onto key presses. */
  function sendAxes(axes) {
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify({ axes }));
    }
  }

  function stop(onEnd) {
    if (stopped) return;
    stopped = true;
    const sid = sessionId;
    try { channel && channel.close(); } catch (_) {}
    try { pc && pc.close(); } catch (_) {}
    pc = channel = null;
    sessionId = null;
    // Best effort: the server also reaps sessions whose peer connection drops,
    // so a failed stop does not leak an emulator process forever.
    if (sid) {
      fetch(base() + '/api/rtc/' + encodeURIComponent(sid) + '/stop',
            { method: 'POST' }).catch(() => {});
    }
    if (onEnd) onEnd();
  }

  return { play, sendInput, sendAxes, stop };
})();
