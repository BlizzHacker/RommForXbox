#!/usr/bin/env python3
"""Captures the 1920x1080 Store listing screenshots from the real running app.

A Store submission is rejected without at least one screenshot, and hand-cropped
photos of a TV look like what they are. These come from the app itself at exactly
console resolution.

Usage: python3 capture_shots.py <romm-url> [username] [password] [outdir]

Credentials may instead come from ROMM_USER / ROMM_PASS, which keeps the
password out of shell history and out of the process list.
"""
import getpass
import json
import os
import subprocess
import sys
import time

import requests
import websocket

APP = os.environ.get("APP_URL", "https://xbox.moveweight.com/")
RESOLVE = os.environ.get(
    "RESOLVE_RULES",
    "MAP romm.moveweight.com 192.168.0.197,MAP xbox.moveweight.com 192.168.0.197")
PORT = 9338

if len(sys.argv) < 2:
    sys.exit(__doc__.strip())
server = sys.argv[1]
username = (sys.argv[2] if len(sys.argv) > 2
            else os.environ.get("ROMM_USER") or input("RomM username: "))
password = (sys.argv[3] if len(sys.argv) > 3
            else os.environ.get("ROMM_PASS") or getpass.getpass("RomM password: "))
outdir = sys.argv[4] if len(sys.argv) > 4 else os.environ.get(
    "SHOTS_DIR", "/tmp/shots")
os.makedirs(outdir, exist_ok=True)

SCOPES = ("me.read roms.read platforms.read assets.read devices.read "
          "firmware.read roms.user.read collections.read assets.write")

# Get a token directly rather than driving the keyboard: this script is about the
# pictures, and the sign-in flow has its own tests.
tok = requests.post(server + "/api/token", data={
    "grant_type": "password", "username": username,
    "password": password, "scope": SCOPES}, timeout=30)
tok.raise_for_status()
token = tok.json()["access_token"]

proc = subprocess.Popen(
    ["/bin/chromium", "--headless=new", f"--remote-debugging-port={PORT}",
     "--remote-allow-origins=*", "--no-sandbox", "--disable-gpu",
     f"--host-resolver-rules={RESOLVE}", "--window-size=1920,1080",
     "--hide-scrollbars", "--force-device-scale-factor=1",
     "--user-data-dir=/tmp/shotprofile", "about:blank"],
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

    ws = websocket.create_connection(tabs[0]["webSocketDebuggerUrl"], timeout=90,
                                     max_size=64 * 1024 * 1024)
    n = [0]

    def send(method, params=None):
        n[0] += 1
        ws.send(json.dumps({"id": n[0], "method": method, "params": params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == n[0]:
                return m

    def ev(expr):
        r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        return r.get("result", {}).get("result", {}).get("value")

    def shot(name):
        r = send("Page.captureScreenshot", {"format": "png",
                                            "clip": {"x": 0, "y": 0, "width": 1920,
                                                     "height": 1080, "scale": 1}})
        data = r["result"]["data"]
        path = os.path.join(outdir, name)
        with open(path, "wb") as f:
            import base64
            f.write(base64.b64decode(data))
        print(f"{path}  {os.path.getsize(path):,} bytes", flush=True)

    send("Page.enable")
    send("Runtime.enable")
    send("Emulation.setDeviceMetricsOverride",
         {"width": 1920, "height": 1080, "deviceScaleFactor": 1, "mobile": False})

    def load(wait_expr, secs=90):
        send("Page.navigate", {"url": APP})
        deadline = time.time() + secs
        while time.time() < deadline:
            if ev(wait_expr) is True:
                return True
            time.sleep(0.5)
        return False

    # 1. First run — what a new customer sees, and what a reviewer sees first.
    load("typeof CFG !== 'undefined'")
    ev("localStorage.clear()")
    load("typeof CFG !== 'undefined' && !document.getElementById"
         "('view-setup').classList.contains('hidden')")
    time.sleep(1)
    shot("01-first-run.png")

    # 2. The on-screen keyboard, mid-address. The controller-first story.
    ev("OSK.open({title:'RomM server address',"
       "hint:'D-pad move · A press · X backspace · Y shift · Menu done',"
       "value:'192.168.1.42'})")
    time.sleep(0.6)
    shot("02-keyboard.png")
    ev("OSK.close()")

    # 3+. The library grid with real cover art — the shots that sell it.
    # Platforms are chosen, not taken in rail order: the first one alphabetically
    # is 3DO, whose covers are mostly missing and whose entries are duplicated,
    # which photographs as a broken app rather than a full library.
    ev(f"localStorage.setItem('romm_server','{server}');"
       f"localStorage.setItem('romm_token','{token}');"
       "localStorage.setItem('romm_auth_mode','password')")
    load("typeof games !== 'undefined' && games.length > 0")

    def covers_loaded():
        v = ev("[...document.querySelectorAll('#game-grid img')]"
               ".filter(i=>i.complete && i.naturalWidth>0).length")
        return v if isinstance(v, int) else 0

    def show_platform(slug, filename, want=14, skip_rows=0):
        # platforms holds {p, tier} wrappers, not raw platform records.
        idx = ev(f"platforms.findIndex(x=>x.p.slug==='{slug}')")
        if not isinstance(idx, int) or idx < 0:
            print(f"  (no platform {slug}, skipped)", flush=True)
            return False
        # Wait on the load promise, not just on cover count: the header and rail
        # update before the new platform's games arrive, so polling covers alone
        # photographs the *previous* platform's grid under the new title.
        ev(f"window.__done=false; platIdx={idx};"
           "loadGames().then(()=>{window.__done=true})")
        deadline = time.time() + 90
        while time.time() < deadline and ev("__done") is not True:
            time.sleep(0.5)
        if ev("__done") is not True:
            print(f"  (timed out loading {slug})", flush=True)
            return False
        deadline = time.time() + 60
        while time.time() < deadline and covers_loaded() < want:
            time.sleep(0.5)

        # Scroll past the head of the list. Real libraries begin with numbered
        # entries and stray artwork files that RomM scanned as ROMs, which
        # photographs as a broken grid rather than a shelf of games.
        for _ in range(skip_rows):
            ev("libraryInput('down')")
            time.sleep(0.35)
        if skip_rows:
            deadline = time.time() + 45
            while time.time() < deadline and covers_loaded() < want:
                time.sleep(0.5)
        time.sleep(2)
        title = ev("document.getElementById('lib-title').textContent")
        status = ev("document.getElementById('lib-status').textContent")
        print(f"  {slug}: title={title!r} status={status!r} "
              f"covers={covers_loaded()}", flush=True)
        shot(filename)
        return True

    for slug, fname, skip in [("snes", "03-library-snes.png", 6),
                              ("gba", "04-library-gba.png", 6),
                              ("genesis", "05-library-genesis.png", 8)]:
        show_platform(slug, fname, skip_rows=skip)

finally:
    try:
        ws.close()
    except Exception:
        pass
    proc.terminate()

print("done")
