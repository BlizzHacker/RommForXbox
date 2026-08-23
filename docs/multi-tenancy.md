# Pointing the app at your own RomM

The client used to be hard-wired to one deployment: every call went to a
same-origin path (`/romm/…`) that nginx proxied to one specific RomM. That is
fine for a private install and wrong for anything distributed — a Store user
would have been signing in to somebody else's library.

The app now asks for a server address on first run and talks to that server
directly. Everything it needs comes from your RomM: the library, cover art, the
ROM bytes, EmulatorJS itself (RomM serves it at `/assets/emulatorjs/data/`) and
save states. Nothing routes through a server of ours.

Sign in either by **pairing** (RomM → Settings → Client API Tokens → Add →
Pair, then type the eight-digit code) or with your **username and password**.
Pairing is better because the app only ever holds a scoped token; the
password option exists because a controller-only console cannot easily reach
RomM's web UI to mint a code.

## The one real limit: cross-origin file delivery

RomM's FastAPI app sets `CORSMiddleware(allow_origins=["*"])`, so the JSON API
answers any origin. Its **file** delivery does not go through that middleware:

| Path | Served by | Sends `Access-Control-Allow-Origin`? |
|---|---|---|
| `/api/platforms`, `/api/roms`, `/api/states` | FastAPI | yes |
| `/api/raw/assets/…` (save state contents) | FastAPI | yes |
| `/api/roms/{id}/content/{file}` (ROM bytes) | nginx via `X-Accel-Redirect` | **no** |
| `/assets/…` (covers, EmulatorJS) | nginx directly | **no** |

The preflight on the ROM download succeeds — it is answered by FastAPI — and
then the actual response arrives from nginx without the header, so the browser
discards it. Cover art still appears because `<img>` is not CORS-checked.

**Consequence:** from a browser, browsing a remote RomM works and *playing* from
it does not. The app detects this and says so, rather than surfacing a bare
"Failed to fetch".

**This applies to the browser only.** Inside the installed Xbox app there is no
cross-origin rule to break: the page is packaged, and every request to a
plain-http server is performed by native code, which CORS does not apply to. The
app used to show the cross-origin hint on the console too — its check was a bare
`server.origin !== location.origin`, which is true for *every* server once the
page is served from `https://app.local` — so a user whose server was working
correctly was told to go and add headers to a proxy. It now reports the reason
the transfer actually failed.

### The console's real constraint: an https page cannot load http subresources

The packaged page has to be https (a secure context, for WebRTC). That makes
every plain-http URL it references *mixed content*, which Chromium blocks inside
the renderer — before `WebResourceRequested` or any script of ours could see the
request. Which mechanisms that hits is not obvious, and it decides the design:

| How the app asks for it | On a plain-http server |
|---|---|
| `fetch()` | wrapped in `host-bridge.js` → native bridge |
| `XMLHttpRequest` | wrapped in `host-bridge.js` → native bridge |
| `<script src>` (EmulatorJS `loader.js`, `emulator.min.js`) | **blocked** — fetched natively and injected as a `blob:` URL |
| `<link rel=stylesheet>` (`emulator.min.css`) | **blocked** — same, via `EJS_paths` |
| `<img src>` (cover art) | auto-upgraded to https, then **blocked** when that fails — re-fetched natively on `error` |

EmulatorJS makes this workable: `EJS_paths` overrides any file it loads *by
basename*, and its downloader takes the plain `fetch()` branch for any non-http
URL, so a `blob:` URL is accepted everywhere. Its cores, BIOS files and
localization go through `XMLHttpRequest` — **not** `fetch` — which is why the
XHR shim is load-bearing rather than a nicety.

### Working configurations

1. **Same origin (recommended, and what is verified).** Serve the app from the
   same origin as RomM, with RomM reverse-proxied under `/romm/`. Then no
   cross-origin rule applies to anything. This is the layout in
   `deploy/`-style nginx config in the README, and the one that passes the full
   verification including a 394 MB ROM download.
2. **Remote RomM, with two headers added.** If you front your RomM with your own
   proxy, add the header to the two paths nginx serves:

   ```nginx
   location /assets/ {
       add_header Access-Control-Allow-Origin "https://xbox.moveweight.com" always;
   }
   # and on the internal location RomM X-Accel-Redirects ROM downloads to
   location /library/ {
       internal;
       add_header Access-Control-Allow-Origin "https://xbox.moveweight.com" always;
   }
   ```

The durable fix belongs upstream in RomM: add the CORS header to the nginx
`internal` location and to `/assets`. Until then, option 1 is the one to ship.

## RomM API details worth not rediscovering

* **There is no `states.*` scope.** Save states are assets — `assets.read` /
  `assets.write`. Requesting a scope that does not exist fails the *whole* token
  grant with `{"detail":"Insufficient scope"}`, which looks like a permissions
  problem with the account rather than a typo.
* **Sending no `scope` is not a shortcut.** The grant then carries an empty
  scope set and every library call returns 403.
* A `viewer`-role account *is* granted `assets.write`, so save-state sync works
  for read-only users.
* **The access token lasts 1800 s**, with a 7-day refresh token. A play session
  outlives it, so the client refreshes once on 401/403 and replays the request
  before falling back to the sign-in screen.
* Cover paths and state `download_path` values **contain raw spaces** (both
  carry a `?ts=`/`?timestamp=` cache-buster). `encodeURI()` is the right fix —
  the server accepts the `:` and `+` it leaves alone.
* `GET /api/roms` returns a page; **`total` is the platform's real count**.
  Showing `items.length` labels a 4,414-game platform as "500 games".
