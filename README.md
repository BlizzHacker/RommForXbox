# Cartridge for Xbox

Browse your self-hosted RomM library with an Xbox controller, then play through a compatible browser core or your configured streaming server.

[![Build Cartridge for Xbox](https://github.com/BlizzHacker/RommForXbox/actions/workflows/shell-msix.yml/badge.svg)](https://github.com/BlizzHacker/RommForXbox/actions/workflows/shell-msix.yml)

**[Connect](#connect-your-library)** · **[Browser deployment](#browser-deployment)** · **[Native Xbox build](#native-xbox-app)** · **[Known limits](#what-is-and-is-not-verified)** · **[Report a problem](https://github.com/BlizzHacker/RommForXbox/issues)**

## What you need

- A RomM server with your own library and actual ROM files.
- An Xbox controller and a compatible Xbox/browser environment.
- A supported player/core for the selected file. A streaming server is optional and adds remote play for its configured systems.

Cartridge is a client. RomM supplies library data, covers, files and save-state services. [ROMarr](https://github.com/BlizzHacker/romarr) can help acquire and organize files separately; it is not required to browse an existing RomM library.

## Two ways to run

| Path | What it runs | Setup |
|---|---|---|
| **Xbox Edge** | Static web client in the Xbox's Chromium browser | Host the files with the same origin as RomM, or configure the required proxy/headers. |
| **Native Xbox app** | UWP shell with WebView2, native gamepad input and a network bridge | Use an approved Store build, or build/test the MSIX through a supported developer installation. |

The native shell is the current package project under `shell/`. The older `scripts/build-msix.mjs` generates a legacy hosted-web-app package; it is not the native WebView2 build and should not be substituted for it.

## Connect your library

1. Start Cartridge and enter your RomM server address, including the port if needed.
2. Let the connection check finish. Its status and failure reason are shown on screen.
3. Pair using **RomM → Settings → Client API Tokens → Add → Pair**, if your server provides that flow, or use your RomM username/password.
4. Choose a platform and a game. Start with a small file and verify playback and saving before relying on a long session.

An installed native shell can route plain-HTTP LAN requests through its native bridge. The browser client still follows browser origin and certificate rules: a page served over HTTPS cannot simply fetch every HTTP server. [Network setup and why browsing can work while playback fails](docs/multi-tenancy.md).

Self-signed certificate support is an explicit opt-in for your selected server in the native app. Keep normal certificate validation enabled for other hosts. Connection and transport logic is tested in CI; successful playback with your server and console still needs a real test.

### Controller basics

- D-pad: move; **A**: choose/play; **B**: back through menus.
- **LB/RB**: switch platform.
- During a game, **B belongs to the game**. Hold **Menu + View** to leave playback.
- **X** on the setup page: diagnostics, including build and connection information.

## How playback works

A supported EmulatorJS system runs locally in the browser/WebView2. A configured streaming server can provide remote playback for other systems. Available routes depend on the platform, file format, core, firmware and server configuration; library visibility is not a guarantee that every game can launch.

Save-state upload is implemented through RomM. Validate a save and reload on your own setup before depending on it. Controller timing, memory limits and streaming latency are hardware/network dependent.

## Browser deployment

The web client is static HTML/CSS/JavaScript; it needs no Node build step. Serve it from the same origin as your RomM or use a reverse proxy. A typical layout is:

```text
/        -> Cartridge web files
/romm/   -> RomM, with the prefix stripped
/api/    -> optional streaming server, including WebSocket signalling
/emu/    -> your EmulatorJS data, if using this layout
```

Adapt this to your RomM deployment rather than assuming those paths already exist. See [network deployment](docs/multi-tenancy.md) and the separate [Cartridge streaming server](https://github.com/BlizzHacker/RommStreamServer).

## Native Xbox app

The Store product remains **[9MXC51W17LH4](https://apps.microsoft.com/detail/9mxc51w17lh4)**. The public name is **Cartridge for Xbox**. The package identity `MOVEWEIGHT.RomMforXbox` and registered publisher are retained so this remains an update to the same product.

Store approval/publication is separate from a successful GitHub build. An unsigned CI artifact is not a retail-console installer. Dev Mode testing requires the appropriate package trust/signing and device setup.

### Build and test

The [Windows CI workflow](.github/workflows/shell-msix.yml) runs on relevant pull requests and main-branch changes. It:

1. Validates the package identity and visible product name.
2. Tests EmulatorJS core keys, native URL/error logic, controller/connection logic and the real JavaScript transport bridge.
3. Restores and builds the actual x64 UWP/WebView2 project with .NET Native.
4. Unpacks the output and checks its identity, Xbox target family and required web content.
5. Uploads the package as a workflow artifact.

Run the portable checks locally with Node.js and Python 3:

```bash
python3 tests/validate_manifest.py
node tests/validate_cores.js
node shell/tests/bridge-logic.test.mjs
node shell/tests/native-fetch.test.mjs
```

Building the native app itself requires Windows, Visual Studio/MSBuild with UWP tools, the Windows SDK and NuGet restore. The canonical project is `shell/RommForXbox.Shell/RommForXbox.Shell.csproj`; CI records the complete build command and toolchain. Do not infer that a Linux syntax check built the MSIX.

## What is and is not verified

CI checks real source logic and the actual Windows package build. It cannot validate Xbox hardware input, WebView2 behavior on a particular console, each emulator core, all RomM versions, or save-state persistence across every device. This rebrand does not add a new hardware proof claim.

The [package history and hardware test checklist](docs/xbox-store-status.md) explain the older hosted package and the current native shell. For a bug report, include the build/version, Xbox model, RomM version, server address scheme (HTTP/HTTPS), failing action and diagnostics message. Remove tokens and passwords.

## Other Cartridge projects

- [Cartridge for Windows](https://github.com/BlizzHacker/RommForDesktop): optional desktop companion.
- [ROMarr](https://github.com/BlizzHacker/romarr): acquisition and library automation.
- [ROM Hub](https://github.com/BlizzHacker/rom-hub): source and metadata plugins.

Cartridge for Xbox is independent and unofficial, and is not endorsed by the RomM or Microsoft projects.
