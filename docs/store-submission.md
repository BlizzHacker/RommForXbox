# Microsoft Store submission

Product: **9MXC51W17LH4** — `https://partner.microsoft.com/dashboard/products/9MXC51W17LH4`

Upload **`RommForXbox_0.3.0.0_x64_STORE.msixupload`** — in
`C:\MoveWeight\STORE-SUBMIT\`, and an artifact of the `Build Xbox shell MSIX`
workflow. `.msixupload` is the format Partner Center wants; it carries the
framework dependencies with it.

`RommForXbox_0.3.0.0_x64_SIDELOAD.msix` beside it is the Dev Mode build, for
testing on a console through the Device Portal.

Do **not** submit the older hosted-web-app packages (`RommForXbox_0.1.0.0` or
`0.2.0.0_neutral.msix`) — they cannot play from a customer's own server. See
[xbox-store-status.md](xbox-store-status.md).

Identity is fixed and must not drift from the product:

| | |
|---|---|
| Name | `MOVEWEIGHT.RomMforXbox` |
| Publisher | `CN=6375D74B-5E4F-45B4-B246-B29507C1332A` |
| Version | `0.3.0.0` (raise for every resubmission — the Store rejects a repeat) |
| Architecture | `x64` (Xbox is x64; a C# UWP app cannot be `neutral`) |

Claude cannot sign in to Partner Center or submit on your behalf. Everything
below is yours to click.

## Steps

1. **Packages** → upload the `.msix` from the workflow artifact. Confirm the
   parsed device families list **Xbox** and **Desktop**.
2. **Pricing and availability** → Base price **Free**. Markets All, Public,
   Discoverable (already set).
3. **Properties** → category **Entertainment**. It is an *app*, not a game — this
   matters: new UWP **games** are no longer accepted for the Xbox Store, non-game
   UWP apps are.
4. **Age ratings** → IARC questionnaire, answers below.
5. **Store listing** → paste the copy below.
6. **Notes for certification** → paste the reviewer notes below, filling in the
   demo credentials.
7. **Submit for certification.**

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

> Connect the app to any RomM server, an on-screen keyboard you can drive with
> the controller, username/password sign-in beside code pairing, and save states
> synced through your own server.

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

  Server address:  romm.moveweight.com
  Username:        <demo-username>
  Password:        <demo-password>

To reproduce the main flow:
  1. Launch the app. The first screen asks for a RomM server address.
  2. Choose "Enter your RomM server address". Use the on-screen keyboard with
     the controller (D-pad to move, A to press, Menu to accept) and enter the
     address above. The app verifies it is a RomM server.
  3. Choose "Continue", then press RB to switch to "Username & password", press
     A, and enter the credentials above.
  4. The library appears as a cover-art grid. LB/RB change platform, A launches
     a game, Y opens settings.

The account is read-only and is provided solely for certification.
```

Create the demo account on LXC 104 when you are ready to submit, and delete it
afterwards:

```bash
ssh root@192.168.0.6 'pct exec 104 -- docker exec -e PW="<choose-a-password>" romm python3 -c "
import os
from handler.auth import auth_handler
from handler.database import db_user_handler
from models.user import User, Role
u = User(username=\"msstorereview\", hashed_password=auth_handler.get_password_hash(os.environ[\"PW\"]), role=Role.VIEWER, enabled=True)
print(\"created\", db_user_handler.add_user(u).id)
"'
```

A `viewer` role can read the library and write its own save states, and can
change nothing else.

## Known risk to weigh before submitting

The packaged app has **never been run on an Xbox** — there is no console here.
WebView2 on Xbox is a documented, developer-open scenario, and the shell exists
specifically to give the page Chromium, controller input and CORS-clean file
access. But whether EmulatorJS actually runs at acceptable speed inside WebView2
on Xbox hardware is unverified. If you can put a console in Dev Mode, sideload
the package through the Device Portal and confirm a game boots before spending a
certification cycle on it.
