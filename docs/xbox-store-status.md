# Xbox + Microsoft Store: what works, and the one open risk

Status as of 2026-07-29.

## Two delivery paths, and they do not behave the same

| Path | Engine on console | Status |
|---|---|---|
| **Xbox Edge browser** → `https://xbox.moveweight.com/` | Chromium | Works. This is the verified path. |
| **Store app (MSIX, hosted web app)** | Legacy **EdgeHTML** | Ships, but EmulatorJS is unproven — see below. |

## The open risk

The MSIX in `dist/` is a *hosted web app* (HWA): the package contains only a
manifest plus tile art, and `StartPage` is the deployed URL. That is the legacy
UWP web-app model and it runs in **WWAHost on EdgeHTML**, not Chromium.

EmulatorJS needs WebAssembly, WebGL2 and AudioWorklet. EdgeHTML predates the
relevant versions of all three. So the library-browsing half of the app will
probably work inside the packaged app while **the actual emulation probably will
not** — even though both work fine in the Xbox Edge browser.

Supporting facts:

* The Xbox team stated in 2022 that **PWAs are not supported on Xbox** and that
  there was no plan to add them, pointing developers at WebView2 instead.
* **WebView2 (Chromium) became available for Xbox apps in November 2023**, and
  Microsoft described it as letting Xbox app developers "migrate from the
  EdgeHTML WebView control" — i.e. EdgeHTML is what packaged Xbox web apps used.
* The UWP `WebView` (EdgeHTML) control is formally deprecated in favour of
  WebView2.

**This has not been tested on hardware.** There is no Xbox on the LAN (nothing
answering on the Device Portal port) and no console in dev mode, so the packaged
app has never been launched on a console. Do not claim the Store build works on
Xbox until it has been.

## Non-game apps can still target Xbox

Worth recording, because the neighbouring rule is easy to misread: new **UWP
games** are no longer accepted for the Xbox Store. This is not a game. For a
non-game app, a `neutral`/`x64` UWP package built against SDK 14393 or later can
still check the Xbox device family in Partner Center — which is what product
`9MXC51W17LH4` already has selected.

## The second problem, which is the decisive one

Independently of the engine, the hosted-web-app package **cannot let a Store
customer play from their own RomM**.

The package's start page is `https://xbox.moveweight.com/` — our origin. RomM
serves ROM bytes through nginx (`X-Accel-Redirect`) and `/assets` directly, and
neither response carries a CORS header, so a page on our origin can browse a
customer's RomM but cannot fetch a ROM or EmulatorJS from it. See
[multi-tenancy.md](multi-tenancy.md).

A customer therefore gets: sign-in works, library and cover art appear, pressing
A fails. That is worse than not shipping — it is a functionality rejection at
certification if the reviewer gets that far, and a bad app if they do not.

The fix is not a web fix. It needs a native host that can either proxy the
fetches or inject the header — which is what option 1 below buys, using
WebView2's `WebResourceRequested` interception.

## The three ways forward

1. **WinUI 2 UWP shell hosting WebView2** — the architecture Microsoft actually
   supports for this on Xbox today, and the only one that fixes *both* problems.
   A thin native shell hosts a WebView2 (Chromium, so EmulatorJS can run) with
   the app content packaged locally, and intercepts `WebResourceRequested` to
   add the CORS header RomM omits — so a customer's own remote RomM works.
   Requires the Visual Studio **UWP workload**, which is *not* installed on the
   build machine (MSBuild and MSVC are there; the `AppxPackage` targets are
   missing). Still needs a console to verify.
2. **Ship the browser path, deployed alongside each RomM.** Works today: the
   app is static files served same-origin with RomM, opened in the Xbox Edge
   browser — no dev mode, no sideloading, no Store review. Distribute it as a
   compose/nginx snippet rather than as an app. Park the Store submission.
3. **Submit the hosted web app as-is.** Not recommended. It cannot play from a
   customer's own server, so it earns either a certification rejection or a
   one-star listing.

## What *is* verified (2026-07-29)

Driven end to end in real Chromium (`scripts/../docs` note: harness lives in the
session scratchpad, `drive_xbox_app.py`) against the live RomM at
`romm.moveweight.com`, using a scoped throwaway account:

* app boots, first run shows setup, on-screen keyboard captures typed text
* a typed server address is probed and identified as RomM
* username/password sign-in succeeds
* platforms and the game grid render, cover art loads from the RomM server
* RB switches platform
* authenticated ROM download works
* EmulatorJS is reachable from the configured server
* a save state uploads and reads back byte-identical

See [multi-tenancy.md](multi-tenancy.md) for how the client became
server-agnostic and the RomM API bugs that fixed.
