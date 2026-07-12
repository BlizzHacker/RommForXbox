# RomM for Xbox

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

## Pairing

Uses RomM 4.9 client API tokens — the app never sees your password:

1. Sign into RomM in a browser, create a Client API Token
   (read-only `platforms.read` + `roms.read`), choose **Pair**.
2. Enter the eight-digit code on the Xbox. The scoped token lives in
   `localStorage` and can be revoked in RomM at any time.

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

`node scripts/build-msix.mjs` builds `dist/RommForXbox_<ver>_neutral.msix`, a
hosted web app targeting `Windows.Xbox` whose start page is
`https://xbox.moveweight.com/`. Sideload it on a Dev Mode console (Device
Portal > Add), or submit it to the Microsoft Store for retail installs.
Set `ROMM_XBOX_SIGN_PFX`/`ROMM_XBOX_SIGN_PWD` to sign the output.
