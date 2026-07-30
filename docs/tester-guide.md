# RomM for Xbox — tester guide

Ten minutes, five checks. If any of them fails, **open Diagnostics and send that
screen** — it is there so you do not have to describe the problem in words.

## Install, or update

Dev Mode console, via the Xbox Device Portal:

1. Console: Settings → System → Console info → Developer settings → note the
   Device Portal address (`https://<console-ip>:11443`).
2. Browser on a PC: open that address, accept the certificate warning.
3. **Home → Add** → upload `RommForXbox_0.8.0.0_x64_SIDELOAD.msix` →
   **Start**.

It appears under *Apps* as **RomM for Xbox**.

### Already have an older build?

**Just install the new one the same way — do not uninstall first.** Every build
shares one package identity (`MOVEWEIGHT.RomMforXbox`) and the version only ever
goes up, so a higher version replaces the lower one in place and your server
address and sign-in are kept.

**Then confirm which build you are actually running:** press **X** on the first
screen. The top line of Diagnostics reads `Build 0.8.0.0`. If it says anything
lower, the update did not take — the usual cause is the console still running the
old copy, so close the app fully from the dashboard (Menu → Quit) and reopen it.

If you would rather be certain than careful, uninstalling first works too and
costs you only the server address, which takes twenty seconds to retype.

> **One thing an update cannot fix by itself:** settings written by an older build
> survive it. Builds before 0.6 saved a bare address you typed as `https://…`,
> which is wrong for most servers on a home network. On first launch after
> updating, this build re-checks your saved address and switches the scheme if the
> other one answers, telling you it did so. That is expected, not a bug.

## The controls, because they are not the Xbox defaults everywhere

On the keyboard screen: **A** press a key · **X** backspace · **Y** shift ·
**Menu** done · **B** cancel.

Backspace is X, not B. That is deliberate: on Xbox, B is the system's own "back"
and the app has to wrestle it away. If it ever loses that fight the app closes, so
nothing important is bound to B.

## What to check

**1. It launches.** You should see "RomM server address", not a black screen or a
crash back to the dashboard. *If it black-screens, that is the WebView2 host
failing — the most important thing you can report.*

**2. Typing works and B does not eject you.** Choose *Enter your RomM server
address* and type your server. Press **B** a few times while typing — it should
cancel the keyboard, **not** close the app.
*If the app closes: relaunch it and go back to the keyboard — what you typed
should still be there. Tell me both halves: that it closed, and whether the text
came back.*

**3. A plain-http server on your LAN connects.** Type just the address —
`192.168.1.42`. No `http://`, no port, no domain name. The app tries http first
for private addresses.
*If it says it could not reach it, open Diagnostics (**X** on the first screen)
and press **A** to re-test. The result line names which step failed.*

**4. The library loads with cover art.** Sign in (RB switches to username &
password if you cannot make a pairing code from the couch). **LB/RB** change
platform.
*Look at the line under the grid: it says how many games need a stream server and
how many cannot run on an Xbox at all. Those numbers should roughly match your
library, not be silently missing.*

**5. A game actually boots and responds.** Try a **Game Boy Color** or **C64**
game specifically — both were broken until this build, so they are the best
evidence the fix landed. Then a **Genesis** game.
*If a game loads but ignores the controller, say so — that is a different bug from
it not loading.*

## Diagnostics

**X** on the first screen. It shows the build, whether the native host is live,
whether a controller is seen, how requests are being routed, and the last failure.
**A** re-tests the server and reports which of reachable / library / EmulatorJS
works.

A photo of that screen is worth more than a paragraph.

## Known, already understood — no need to report

* **Switch, Wii U, Xbox, Xbox 360, PS3, Vita games do not appear.** No emulator
  exists for them; the app says how many it hid.
* **Streamed Dreamcast, PS2, MSX, Intellivision and X68000 are unavailable** until
  console firmware is placed on the stream server. The app names the files.
* **Streamed games have no analog sticks.** Buttons and d-pad only —
  see [RommStreamServer/docs/analog-input.md](../../RommStreamServer/docs/analog-input.md).
* **Only the first 500 games per platform load.** The header says "500 of 3873".

## What has never been tested on hardware

Be sceptical of these; they are why you are here.

| | |
|---|---|
| Launching at all on console | untested since 0.3.0.0 |
| B not closing the app | fix is test-verified only |
| Plain-http LAN servers | fix is test-verified only |
| EmulatorJS speed in WebView2 on console silicon | **never measured anywhere** |

The last one is the assumption the whole app rests on. If games run but at 10 fps,
that is the single most valuable thing you can tell me.
