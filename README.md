# RomM for Xbox

A project of the [Move Weight Foundation](https://foundation.moveweight.com), an
Oklahoma non-profit corporation with 501(c)(3) status pending.

Play your entire [RomM](https://github.com/rommapp/romm) library on **any retail
Xbox** — no dev mode, no sideloading. Open one URL in the Xbox **Edge** browser
and drive everything with the controller.

## How it plays games

| Tier | Systems | How |
|------|---------|-----|
| **On the Xbox** | NES, SNES, N64, GB/GBC/GBA, NDS, Genesis/MD, SMS/GG, 32X, Sega CD, PSX, PSP, Arcade, Atari, Lynx, Jaguar, 3DO, PCE, WonderSwan, … | EmulatorJS (WASM) runs directly in Edge with native Gamepad API — zero streaming latency |
| **Streamed** | GameCube, Wii, Dreamcast, PS2, Saturn, 3DS | Server-side RetroArch captured over **WebRTC** (~100 ms), controller input over the data channel |

The server picks the tier per platform (`GET /api/play/route`). Windows/installer
platforms are never shown.

Save states persist on the server across both tiers and across devices.

## Connecting to your server

On first run the app asks for your RomM address, checks it really is a RomM, and
remembers it. Everything then comes from your server — library, covers, ROM
bytes, EmulatorJS and save states.

Sign in either way:

* **Pair** (preferred) — in RomM: **Settings → Client API Tokens → Add →
  Pair**, then type the eight-digit code on the console. The app only ever holds
  a scoped token, revocable in RomM at any time; it never sees your password.
* **Username and password** — for a controller-only console that cannot easily
  reach RomM's web UI to mint a code.

**Serve the app from the same origin as your RomM.** RomM sends CORS headers on
its JSON API but not on ROM downloads or `/assets` (nginx serves those), so a
remote RomM will browse but not play. See
[docs/multi-tenancy.md](docs/multi-tenancy.md) for why and for the two-header
workaround.

## Deploy

Static files — no build step. Serve them same-origin with two reverse proxies
(see [RommStreamServer](https://github.com/BlizzHacker/RommStreamServer) for the
backend and full nginx config):

```
/        → these files
/romm/   → RomM (strip prefix)          # avoids CORS
/api/    → stream server :8090 (+ WS upgrade on /api/rtc/signal)
/emu/    → EmulatorJS data
```

Controller reference: LB/RB switch platform · A play · B back ·
in-stream hold **Menu + View** 1 s to quit.

## Installable Xbox app (MSIX)

`python scripts/make-assets.py` regenerates the tile art;
`node scripts/build-msix.mjs` builds `dist/RommForXbox_<ver>_neutral.msix`, a
hosted web app targeting `Windows.Xbox` whose start page is
`https://xbox.moveweight.com/`. Sideload it on a Dev Mode console (Device
Portal > Add), or submit it to the Microsoft Store for retail installs.
Set `ROMM_XBOX_SIGN_PFX`/`ROMM_XBOX_SIGN_PWD` to sign the output.

**Read [docs/xbox-store-status.md](docs/xbox-store-status.md) before relying on
the packaged app.** The browser path above is verified; a hosted web app runs on
the deprecated EdgeHTML engine on console, so whether EmulatorJS can run *inside
the packaged app* is untested — there is no console here to test it on.
