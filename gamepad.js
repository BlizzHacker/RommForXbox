/* Gamepad helper: edge-detected buttons with repeat for UI nav, and raw
 * 60 Hz state streaming for in-game input. Standard Xbox mapping. */
'use strict';

const GP = (() => {
  const BTN = { a:0, b:1, x:2, y:3, l1:4, r1:5, l2:6, r2:7,
                select:8, start:9, l3:10, r3:11,
                up:12, down:13, left:14, right:15 };
  const REPEAT_DELAY = 400, REPEAT_RATE = 120;
  const prev = {}, heldSince = {}, lastRepeat = {};
  let uiHandler = null;      // (btnName) => void, edge+repeat
  let rawHandler = null;     // (btnName, pressed) => void, edges only
  const AXIS_DEAD = 0.45;
  const axisPrev = { up:false, down:false, left:false, right:false };

  // Input can arrive two ways. In a browser it is the Gamepad API. Inside a
  // WebView2 UWP host it cannot be: the Gamepad API does not reach WebView2
  // content (MicrosoftEdge/WebView2Feedback#4366, open since Feb 2024), so the
  // native shell reads Windows.Gaming.Input and posts state in. Same shape
  // either way, so nothing downstream cares which one is live.
  let hostState = null;

  function pad() {
    if (hostState) return hostState;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  function poll(t) {
    const p = pad();
    if (p) {
      for (const [name, i] of Object.entries(BTN)) {
        const down = !!(p.buttons[i] && p.buttons[i].pressed);
        const was = !!prev[name];
        if (down && !was) {
          heldSince[name] = t; lastRepeat[name] = t;
          if (rawHandler) rawHandler(name, true);
          if (uiHandler) uiHandler(name);
        } else if (!down && was) {
          if (rawHandler) rawHandler(name, false);
        } else if (down && uiHandler && t - heldSince[name] > REPEAT_DELAY
                   && t - lastRepeat[name] > REPEAT_RATE) {
          lastRepeat[name] = t;
          uiHandler(name);
        }
        prev[name] = down;
      }
      // left stick → dpad for both UI and raw
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      const dir = { left: ax < -AXIS_DEAD, right: ax > AXIS_DEAD,
                    up: ay < -AXIS_DEAD, down: ay > AXIS_DEAD };
      for (const d of Object.keys(dir)) {
        if (dir[d] && !axisPrev[d]) {
          heldSince['ax' + d] = t; lastRepeat['ax' + d] = t;
          if (rawHandler) rawHandler(d, true);
          if (uiHandler) uiHandler(d);
        } else if (!dir[d] && axisPrev[d]) {
          if (rawHandler) rawHandler(d, false);
        } else if (dir[d] && uiHandler
                   && t - heldSince['ax' + d] > REPEAT_DELAY
                   && t - lastRepeat['ax' + d] > REPEAT_RATE) {
          lastRepeat['ax' + d] = t;
          uiHandler(d);
        }
        axisPrev[d] = dir[d];
      }
    }
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);

  // Keyboard fallback, so the app works with a USB keyboard on the console and
  // is drivable under test. The on-screen keyboard reads physical keys itself —
  // if it is open it owns them, or Enter and Backspace would fire twice.
  const KEYS = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left',
                 ArrowRight:'right', Enter:'a', Escape:'b', Backspace:'b',
                 PageUp:'l1', PageDown:'r1' };
  window.addEventListener('keydown', e => {
    if (typeof OSK !== 'undefined' && OSK.active) return;
    const n = KEYS[e.key];
    if (n && uiHandler) { e.preventDefault(); uiHandler(n); }
  });

  return {
    onUI(fn) { uiHandler = fn; },
    onRaw(fn) { rawHandler = fn; },
    isHeld(name) { return !!prev[name]; },
    // Called by the native host bridge, ~60 Hz. Pass null to hand control back
    // to the Gamepad API. `buttons` may be booleans or {pressed} objects.
    setHostState(s) {
      if (!s) { hostState = null; return; }
      hostState = {
        connected: true,
        buttons: (s.buttons || []).map(
          b => (typeof b === 'object' ? b : { pressed: !!b })),
        axes: s.axes || [],
      };
    },
    get usingHost() { return !!hostState; },
  };
})();
