# Microsoft Store submission

Product: **9MXC51W17LH4** — `https://partner.microsoft.com/dashboard/products/9MXC51W17LH4`

Upload **`RommForXbox_0.6.0.0_x64_STORE.msixupload`** — in
`C:\MoveWeight\STORE-SUBMIT\`, and an artifact of the `Build Xbox shell MSIX`
workflow. `.msixupload` is the format Partner Center wants; it carries the
framework dependencies with it.

`RommForXbox_0.6.0.0_x64_SIDELOAD.msix` beside it is the Dev Mode build, for
testing on a console through the Device Portal.

Do **not** submit the older hosted-web-app packages (`RommForXbox_0.1.0.0` or
`0.2.0.0_neutral.msix`) — they cannot play from a customer's own server. See
[xbox-store-status.md](xbox-store-status.md).

Identity is fixed and must not drift from the product:

| | |
|---|---|
| Name | `MOVEWEIGHT.RomMforXbox` |
| Publisher | `CN=6375D74B-5E4F-45B4-B246-B29507C1332A` |
| Version | `0.6.0.0` (raise for every resubmission — the Store rejects a repeat) |
| Architecture | `x64` (Xbox is x64; a C# UWP app cannot be `neutral`) |

Claude cannot sign in to Partner Center or submit on your behalf. Everything
below is yours to click.

## Getting it to friends specifically

If the goal is feedback from a handful of people rather than a public launch, use
a **private audience** instead of publishing publicly:

> Pricing and availability → **Audience** → *Private audience* → add their
> **Microsoft account emails** (the address each of them signs into their Xbox
> with — not a gamertag).

They install from the Store as normal, via a link only they can use. The listing
stays invisible to everyone else, so early feedback does not become a public
one-star review. It still goes through certification, and you can switch to
Public later without resubmitting the package.

Xbox **Dev Mode is not a shortcut here** — activating it needs a paid Partner
Center account per person, so it is not something you can ask friends to do.

## Steps

1. **Packages** → upload the `.msix` from the workflow artifact. Confirm the
   parsed device families list **Xbox** and **Desktop**.
2. **Pricing and availability** → Base price **Free**. Markets All, Public,
   Discoverable (already set).
3. **Properties** → category **Entertainment**. It is an *app*, not a game — this
   matters: new UWP **games** are no longer accepted for the Xbox Store, non-game
   UWP apps are.
4. **Age ratings** → IARC questionnaire, answers below.
5. **Store listing** → paste the copy below, and upload the screenshots from
   `C:\MoveWeight\STORE-SUBMIT\screenshots\` (see below).
6. **Notes for certification** → paste the reviewer notes below, filling in the
   demo credentials.
7. **Submit for certification.**

## Screenshots

In `C:\MoveWeight\STORE-SUBMIT\screenshots\`, all **1920x1080 PNG**, captured
from the running app at console resolution. A listing cannot be submitted without
at least one.

| File | Shows |
|---|---|
| `04-library-gba.png` | Dense cover-art grid — **lead with this one** |
| `05-library-genesis.png` | A second system, proving the library is not one shelf |
| `03-library-snes.png` | A third system |
| `02-keyboard.png` | The controller-driven keyboard entering a server address |
| `01-first-run.png` | First run, asking for a server — sets expectations honestly |

Regenerate them any time with `tests/capture_shots.py` (needs the reviewer
account; it picks platforms with real cover art and scrolls past the numbered
junk entries at the head of each list).

## Store listing copy

**Description**

> Play your own retro game library on Xbox with the controller.
>
> RomM for Xbox is a client for RomM, the self-hosted retro game library manager.
> Point the app at your own RomM server, sign in, and browse your collection as a
> cover-art grid built for a TV and a gamepad. Supported systems run right on the
> console; save states are kept on your server, so you can stop on the Xbox and
> pick up anywhere else.
>
> You need your own RomM server (romm.app) — this app does not host, provide or
> supply any games, and it ships no game content of its own. Everything it shows
> comes from the server you point it at.
>
> Sign in by pairing an eight-digit code from RomM's client-token screen, so the
> app never handles your password, or with your RomM username and password if
> that is easier from the couch.

**Short description**

> A controller-first client for your own self-hosted RomM retro game library.

**Search terms**: `romm`, `retro`, `game library`, `emulator frontend`,
`self-hosted`, `homelab`

**What's new in this version**

> Connect to any RomM server by typing just its address — no scheme or port
> needed, and plain-http servers on your own network now work. Fixes from testing
> on real hardware: the B button no longer closes the app while you are typing
> (backspace is X, shift is Y), the keyboard has the characters an address needs,
> Mega Drive/Genesis and Turbografx-CD libraries are playable, and controller
> input reaches games running on the console.

## IARC answers

Category at the start: this is an **app** (a media/library client), not a game.

* Violence, sexuality, language, controlled substances, gambling, fear/horror —
  **No**. The app renders a library grid and a settings screen; it contains no
  game content of its own.
* User interaction / user-generated content — **No**. No chat, no sharing, no
  social features.
* Shares user location — **No**.
* Personal information shared with third parties — **No**. The only server it
  contacts is the one the customer enters; nothing is sent anywhere else and
  there is no analytics or telemetry.
* Digital purchases — **No**.
* Unrestricted internet access — **No**. It is not a browser: it speaks RomM's
  API to a single customer-configured host and renders its own UI.

Expected result: **Everyone / PEGI 3 / USK 0**.

> The earlier draft justified the last answer with "locked to configured RomM
> server origins". That reasoning changed when the app became server-agnostic —
> the answer is still No, but because it only speaks one API to one host, not
> because the host is fixed.

## Notes for certification (reviewer notes)

Paste this, with the demo values filled in:

```
This app is a client for RomM (https://romm.app), self-hosted retro game
library software. It requires a RomM server; it does not host or supply any
games and contains no game content of its own.

A read-only demo server is provided so you can exercise the app fully:

  Server address:  xbox.moveweight.com/romm
  Username:        msstorereview
  Password:        <see below>

To reproduce the main flow:
  1. Launch the app. The first screen asks for a RomM server address.
  2. Choose "Enter your RomM server address". Use the on-screen keyboard with
     the controller (D-pad to move, A to press, X to backspace, Y for shift,
     Menu to accept) and enter the address above. The app verifies it is a RomM
     server before accepting it.
  3. Choose "Continue", then press RB to switch to "Username & password", press
     A, and enter the credentials above.
  4. The library appears as a cover-art grid. LB/RB change platform, A launches
     a game, Y opens settings.

The account is read-only and is provided solely for certification.
```

**The `msstorereview` account already exists** — created 2026-07-29, `viewer`
role. Its password is in this session's scratchpad at `reviewer.txt`; it is
deliberately not committed. If you have lost it, reset with the snippet below.

Delete it once the app is live:

```bash
ssh root@192.168.0.6 'pct exec 104 -- docker exec romm python3 -c "
from handler.database import db_user_handler
u = db_user_handler.get_user_by_username(\"msstorereview\")
if u: db_user_handler.delete_user(u.id); print(\"deleted\")
"'
```

To create or reset it:

```bash
ssh root@192.168.0.6 'pct exec 104 -- docker exec -e PW="<choose-a-password>" romm python3 -c "
import os
from handler.auth import auth_handler
from handler.database import db_user_handler
from models.user import User, Role
e = db_user_handler.get_user_by_username(\"msstorereview\")
if e: db_user_handler.delete_user(e.id)
u = User(username=\"msstorereview\", hashed_password=auth_handler.get_password_hash(os.environ[\"PW\"]), role=Role.VIEWER, enabled=True)
print(\"created\", db_user_handler.add_user(u).id)
"'
```

A `viewer` role can read the library and write its own save states, and can
change nothing else.

## Known risk to weigh before submitting

**Sideload the package and boot one game before you submit.**

0.3.0.0 ran on a console and produced four bugs in the first few minutes, three
of which only hardware could reveal. 0.6.0.0 fixes them, but the two most
important fixes — claiming the B button so it stops closing the app, and reaching
a plain-http server on the LAN — have themselves only been verified in tests, not
on a console.

Certification runs the app on real Xbox hardware. If B still closes it, or the
reviewer's server will not connect, that is a failed cycle and days of waiting.
Ten minutes with `RommForXbox_0.6.0.0_x64_SIDELOAD.msix` through the Device
Portal is much cheaper.

Still completely unverified anywhere: **whether EmulatorJS actually runs at
playable speed inside WebView2 on console hardware.** Nothing short of trying it
answers that, and it is the assumption the whole app rests on.
