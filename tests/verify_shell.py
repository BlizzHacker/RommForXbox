#!/usr/bin/env python3
"""Verifies the JS half of the packaged shell, in real Chromium over CDP.

The shell path cannot be reached from a browser, so the WebView2 host object is
stubbed before any app script runs: window.chrome.webview with the same
postMessage/addEventListener surface the real host exposes. Everything the shell
turns on then activates for real — URL routing, the getGamepads polyfill, the
exit channel — and can be asserted.

What this deliberately does not cover: whether the *native* half does its part.
RoutedUrl has its own test (shell/tests/RoutedUrlTests.cs), and the rest needs a
console.

Usage: python3 verify_shell.py [app-url]
"""
import json
import os
import subprocess
import sys
import time

import requests
import websocket

APP = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "APP_URL", "https://xbox.moveweight.com/")
RESOLVE = os.environ.get("RESOLVE_RULES", "MAP xbox.moveweight.com 192.168.0.197")
PORT = 9337

passed, failed = [], []


def check(label, ok, detail=""):
    line = f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else "")
    (passed if ok else failed).append(line)
    print(line, flush=True)
    return ok


# Stands in for the real WebView2 host object. Records what the page posts out
# and lets the test push messages in, which is all the page can observe.
STUB = """
window.__hostOut = [];
window.chrome = window.chrome || {};
window.chrome.webview = {
  postMessage(m) { window.__hostOut.push(m); },
  addEventListener(t, fn) { if (t === 'message') window.__hostIn = fn; },
  removeEventListener() {},
};
window.__pushPad = s => window.__hostIn && window.__hostIn({ data: s });
"""

proc = subprocess.Popen(
    ["/bin/chromium", "--headless=new", f"--remote-debugging-port={PORT}",
     "--remote-allow-origins=*", "--no-sandbox", "--disable-gpu",
     f"--host-resolver-rules={RESOLVE}", "--window-size=1920,1080",
     "--user-data-dir=/tmp/shverify", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(40):
        try:
            tabs = requests.get(f"http://127.0.0.1:{PORT}/json", timeout=2).json()
            if tabs:
                break
        except Exception:
            time.sleep(0.5)
    else:
        raise SystemExit("chromium never came up")

    ws = websocket.create_connection(tabs[0]["webSocketDebuggerUrl"], timeout=60,
                                     max_size=16 * 1024 * 1024)
    n = [0]
    console = []

    def send(method, params=None):
        n[0] += 1
        ws.send(json.dumps({"id": n[0], "method": method, "params": params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("method") == "Runtime.consoleAPICalled":
                p = m["params"]
                console.append((p["type"], " ".join(
                    str(a.get("value", a.get("description", "")))
                    for a in p.get("args", []))))
            elif m.get("method") == "Runtime.exceptionThrown":
                console.append(("pageerror", str(
                    m["params"]["exceptionDetails"].get("text", ""))))
            elif m.get("id") == n[0]:
                return m

    def ev(expr):
        r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return "EXC " + str(res["exceptionDetails"].get("text"))
        return res.get("result", {}).get("value")

    send("Runtime.enable")
    send("Page.enable")
    send("Page.addScriptToEvaluateOnNewDocument", {"source": STUB})
    send("Page.navigate", {"url": APP})
    for _ in range(60):
        if ev("typeof HOST !== 'undefined' && typeof CFG !== 'undefined' "
              "&& typeof ROMM !== 'undefined'") is True:
            break
        time.sleep(0.5)

    # --- the stub is in place and the app believes it is hosted -------------
    check("app detects the native host", ev("HOST.present") is True)
    check("app announced itself to the host",
          ev("JSON.stringify(__hostOut)") and "ready" in ev("JSON.stringify(__hostOut)"),
          ev("JSON.stringify(__hostOut)"))
    check("host-shell class applied",
          ev("document.documentElement.classList.contains('host-shell')") is True)

    # --- Bug 2: a plain-http LAN server ------------------------------------
    check("bare LAN IP tries http first",
          ev("JSON.stringify(CFG.candidates('192.168.1.42'))")
          == '["http://192.168.1.42","https://192.168.1.42"]',
          ev("JSON.stringify(CFG.candidates('192.168.1.42'))"))
    check("bare public name tries https first",
          ev("JSON.stringify(CFG.candidates('romm.example.com'))")
          == '["https://romm.example.com","http://romm.example.com"]',
          ev("JSON.stringify(CFG.candidates('romm.example.com'))"))
    check("an explicit scheme is respected, not second-guessed",
          ev("JSON.stringify(CFG.candidates('http://192.168.1.42:8080'))")
          == '["http://192.168.1.42:8080"]',
          ev("JSON.stringify(CFG.candidates('http://192.168.1.42:8080'))"))
    check("hostname with no dot is treated as LAN",
          ev("JSON.stringify(CFG.candidates('nas'))")
          == '["http://nas","https://nas"]')
    check("mixed content is no longer a blocker under the host",
          ev("CFG.mixedContentBlocked('http://192.168.1.42')") is False)
    check("http server URL is routed same-origin",
          ev("HOST.route('http://192.168.1.42')")
          == "https://xbox.moveweight.com/__romm/http/192.168.1.42",
          ev("HOST.route('http://192.168.1.42')"))
    check("port survives routing",
          ev("HOST.route('http://192.168.1.42:8080')")
          == "https://xbox.moveweight.com/__romm/http/192.168.1.42:8080")
    ev("localStorage.setItem('romm_server','http://192.168.1.42')")
    check("cover URLs route through the host too",
          str(ev("ROMM.coverUrl({path_cover_small:'/assets/x/c.png'})"))
          == "https://xbox.moveweight.com/__romm/http/192.168.1.42/assets/x/c.png",
          ev("ROMM.coverUrl({path_cover_small:'/assets/x/c.png'})"))
    check("EmulatorJS base routes through the host too",
          ev("ROMM.emulatorJsData()")
          == "https://xbox.moveweight.com/__romm/http/192.168.1.42/assets/emulatorjs/data/",
          ev("ROMM.emulatorJsData()"))
    ev("localStorage.removeItem('romm_server')")

    # --- Bug 3: the keyboard can type an address ---------------------------
    keys = ev("JSON.stringify(["
              "...document.querySelectorAll('#osk-keys .key')].map(k=>k.textContent))")
    ev("OSK.open({title:'t'})")
    keys = ev("JSON.stringify([...document.querySelectorAll('#osk-keys .key')]"
              ".map(k=>k.textContent))")
    check("keyboard has a colon", keys is not None and '":"' in keys)
    for ch in [":", "-", ".", "_", "/", "@"]:
        check(f"keyboard has {ch!r}", f'"{ch}"' in (keys or ""))
    check("keyboard offers an http:// shortcut", "http://" in (keys or ""))

    # --- Bug 1: B must not be load-bearing while typing --------------------
    ev("OSK.close(); OSK.open({title:'t', value:'abc'})")
    ev("OSK.input('x')")
    check("X backspaces", ev("OSK.value") == "ab", ev("OSK.value"))
    ev("window.__cancelled=false; OSK.close();"
       "OSK.open({title:'t', value:'abc', onCancel:()=>{window.__cancelled=true}})")
    ev("OSK.input('b')")
    check("B cancels rather than editing",
          ev("__cancelled") is True and ev("OSK.value") == "abc",
          f"cancelled={ev('__cancelled')} value={ev('OSK.value')}")
    ev("OSK.close(); OSK.open({title:'t', value:'ab'})")
    ev("OSK.input('y')")
    check("Y toggles shift", ev("OSK.value") == "ab")
    ev("OSK.close()")

    # --- Bug 4: EmulatorJS polls the Gamepad API itself -------------------
    ev("window.__connected=0;"
       "window.addEventListener('gamepadconnected',()=>{window.__connected++})")
    ev("__pushPad({t:'pad',connected:true,"
       "buttons:[true,false,false,false,false,false,false,false,false,false,"
       "false,false,false,false,false,false],axes:[0,0,0,0]})")
    check("getGamepads reports a pad to page code",
          ev("navigator.getGamepads().filter(Boolean).length") == 1,
          str(ev("navigator.getGamepads().length")))
    check("pad reports the standard mapping",
          ev("(navigator.getGamepads()[0]||{}).mapping") == "standard")
    check("A press is visible through the Gamepad API",
          ev("navigator.getGamepads()[0].buttons[0].pressed") is True)
    check("button objects have the full shape EmulatorJS reads",
          ev("(b=>typeof b.pressed==='boolean'&&typeof b.value==='number')"
             "(navigator.getGamepads()[0].buttons[0])") is True)
    check("gamepadconnected fired so pollers start", ev("__connected") == 1,
          str(ev("__connected")))
    ev("__pushPad({t:'pad',connected:true,"
       "buttons:[false,false,false,false,false,false,false,false,false,false,"
       "false,false,false,false,false,false],axes:[-0.9,0.5,0,0]})")
    check("axes pass through", ev("JSON.stringify("
                                 "navigator.getGamepads()[0].axes.slice(0,2))")
          == "[-0.9,0.5]", ev("JSON.stringify(navigator.getGamepads()[0].axes)"))
    ev("__pushPad({t:'pad',connected:false})")
    check("disconnect clears the pad",
          ev("navigator.getGamepads().filter(Boolean).length") == 0)

    # --- a half-typed address survives the app being killed ----------------
    # The worst case of the B-button bug is losing a long server address. Drafts
    # make that cost a relaunch instead of retyping.
    ev("localStorage.removeItem('osk_draft_RomM_server_address')")
    ev("OSK.open({title:'RomM server address', value:''})")
    ev("OSK.close()")   # simulates the app dying: no submit, no cancel
    ev("['1','9','2','.','1','6','8'].forEach(c=>0)")
    ev("OSK.open({title:'RomM server address', value:''});"
       "['1','9','2'].forEach(()=>0)")
    ev("OSK.close()")
    ev("localStorage.setItem('osk_draft_RomM_server_address','192.168.1.42')")
    ev("OSK.open({title:'RomM server address', value:''})")
    check("a half-typed address is restored after a restart",
          ev("OSK.value") == "192.168.1.42", str(ev("OSK.value")))
    ev("OSK.submit()")
    check("the draft is cleared once accepted",
          ev("localStorage.getItem('osk_draft_RomM_server_address')") is None)
    ev("OSK.close()")
    ev("window.__pw=null; OSK.open({title:'Password', password:true, value:''});"
       "OSK.input('a')")
    pw_key = ev("Object.keys(localStorage).filter(k=>k.indexOf('osk_draft_Password')===0).length")
    check("passwords are never written to storage", pw_key == 0, str(pw_key))
    ev("OSK.close()")

    # --- diagnostics, so a tester reports facts ---------------------------
    ev("show('diag'); renderDiag('')")
    diag = ev("document.getElementById('diag-kv').textContent")
    for label in ("Build", "Running in", "Controller", "RomM server", "Last failure"):
        check(f"diagnostics shows {label!r}", label in (diag or ""))
    check("diagnostics knows it is running under the host",
          "native host" in (diag or ""), (diag or "")[:80])
    ev("show('setup')")

    # --- the exit channel -------------------------------------------------
    ev("__hostOut.length=0; HOST.exit()")
    check("exit reaches the host",
          "exit" in str(ev("JSON.stringify(__hostOut)")),
          ev("JSON.stringify(__hostOut)"))

    bad = [c for c in console
           if c[0] in ("error", "pageerror")
           and "favicon" not in c[1] and "heartbeat" not in c[1]
           and "ERR_" not in c[1] and "Failed to fetch" not in c[1]]
    check("no unexpected console errors", not bad, "; ".join(t for _, t in bad[:3]))

finally:
    try:
        ws.close()
    except Exception:
        pass
    proc.terminate()

print()
print(f"==== {len(passed)} passed, {len(failed)} failed ====")
sys.exit(1 if failed else 0)
