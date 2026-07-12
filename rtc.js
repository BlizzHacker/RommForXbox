/* WebRTC client: signaling over WS, recvonly A/V, 'input' data channel. */
'use strict';

const RTC = (() => {
  let pc = null, ws = null, channel = null;

  async function play(platform, romName, videoEl, onStatus, onEnd) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/rtc/signal` +
      `?platform=${encodeURIComponent(platform)}` +
      `&rom_name=${encodeURIComponent(romName)}`);

    ws.onmessage = async ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ready') {
        pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc.ontrack = e => { videoEl.srcObject = e.streams[0]; };
        pc.onconnectionstatechange = () => {
          onStatus(pc.connectionState);
          if (['failed', 'closed', 'disconnected'].includes(pc.connectionState))
            stop(onEnd);
        };
        channel = pc.createDataChannel('input', { ordered: true });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise(res => {          // wait for ICE gathering
          if (pc.iceGatheringState === 'complete') return res();
          pc.onicegatheringstatechange = () =>
            pc.iceGatheringState === 'complete' && res();
          setTimeout(res, 2000);
        });
        ws.send(JSON.stringify({ type: 'offer',
                                 sdp: pc.localDescription.sdp }));
      } else if (msg.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } else if (msg.type === 'error') {
        onStatus('error: ' + msg.error);
        stop(onEnd);
      }
    };
    ws.onclose = () => stop(onEnd);
    onStatus('connecting');
  }

  function sendInput(key, pressed) {
    if (channel && channel.readyState === 'open')
      channel.send(JSON.stringify({ key, pressed }));
  }

  let stopped = false;
  function stop(onEnd) {
    if (stopped) return; stopped = true;
    try { ws && ws.send(JSON.stringify({ type: 'bye' })); } catch (e) {}
    try { ws && ws.close(); } catch (e) {}
    try { pc && pc.close(); } catch (e) {}
    pc = ws = channel = null;
    setTimeout(() => { stopped = false; }, 0);
    if (onEnd) onEnd();
  }

  return { play, sendInput, stop };
})();
