#!/usr/bin/env python3
"""Render the Partner Center Store art from a real design, not PIL primitives.

The art is an HTML/CSS composition — display typography (Orbitron for the
wordmark, Press Start 2P for the tag), a hand-drawn SVG gamepad with rim light
and under-glow, an arc of cartridge cards, a synthwave floor grid, scanlines,
noise and a vignette — screenshotted at exact pixel size by headless Chromium.
CSS is simply a better design medium than drawing rectangles in Python; the
first PIL attempt looked like a wireframe because it was one.

Original artwork throughout: no third-party game covers appear in promotional
images (that invites a certification rejection). The cartridge cards are
anonymous.

Partner Center's title rules are strict and mutually opposite — super hero art
and featured promotional square art MUST NOT carry the product name; branded
key art and titled hero art MUST carry it in the top 3/4 — so filenames end
_TITLED or _NOTITLE and the template takes a switch.

    python scripts/make-store-art.py
Needs: a Chromium-based browser (Brave/Chrome/chromium) and network the first
run to fetch the two open fonts (cached in .fontcache/ after).
Output: store-art/*.png
"""
import base64
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store-art"
FONT_CACHE = ROOT / ".fontcache"

BROWSERS = [
    r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/bin/chromium", "/usr/bin/chromium",
]

# Google Fonts css2 endpoints; parsed for the woff2 URL at run time because the
# gstatic URLs are versioned and go stale if hardcoded.
FONTS = {
    "Orbitron": ("https://fonts.googleapis.com/css2"
                 "?family=Orbitron:wght@700;900&display=swap"),
    "PressStart": ("https://fonts.googleapis.com/css2"
                   "?family=Press+Start+2P&display=swap"),
}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def fetch_fonts() -> dict:
    """Font-family → base64 woff2, cached on disk so one network fetch ever."""
    FONT_CACHE.mkdir(exist_ok=True)
    out = {}
    for name, css_url in FONTS.items():
        cache = FONT_CACHE / f"{name}.woff2"
        if not cache.exists():
            req = urllib.request.Request(css_url, headers={"User-Agent": UA})
            css = urllib.request.urlopen(req, timeout=30).read().decode()
            m = re.search(r"url\((https://fonts\.gstatic\.com/[^)]+\.woff2)\)",
                          css)
            if not m:
                sys.exit(f"could not resolve woff2 for {name}")
            urllib.request.urlretrieve(m.group(1), cache)
        out[name] = base64.b64encode(cache.read_bytes()).decode()
    return out


# ----------------------------------------------------------------- the design

GAMEPAD_SVG = """
<svg class="pad" viewBox="0 0 560 340" fill="none"
     xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b3a63"/>
      <stop offset=".45" stop-color="#17233f"/>
      <stop offset="1" stop-color="#0b1326"/>
    </linearGradient>
    <radialGradient id="stick" cx=".35" cy=".3" r="1">
      <stop offset="0" stop-color="#3c4f7d"/>
      <stop offset=".6" stop-color="#141d33"/>
      <stop offset="1" stop-color="#0a1122"/>
    </radialGradient>
    <filter id="rim" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="#7dd3fc"
                    flood-opacity="0.85"/>
    </filter>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000"
                    flood-opacity="0.55"/>
    </filter>
  </defs>

  <!-- body: two grips flowing into a bridge -->
  <g filter="url(#soft)">
    <path filter="url(#rim)" d="
      M 152 78
      C 196 62 364 62 408 78
      C 458 96 500 120 516 190
      C 530 252 520 300 484 312
      C 448 324 420 296 402 268
      C 386 244 362 232 336 232
      L 224 232
      C 198 232 174 244 158 268
      C 140 296 112 324 76 312
      C 40 300 30 252 44 190
      C 60 120 102 96 152 78 Z"
      fill="url(#body)" stroke="#8fd8ff" stroke-width="2.5"/>
  </g>

  <!-- left stick -->
  <circle cx="166" cy="150" r="40" fill="#0a1122" opacity=".9"/>
  <circle cx="166" cy="150" r="31" fill="url(#stick)"
          stroke="#7dd3fc" stroke-width="2"/>
  <circle cx="158" cy="141" r="10" fill="#4b628f" opacity=".55"/>

  <!-- right stick (lower, inboard) -->
  <circle cx="342" cy="204" r="34" fill="#0a1122" opacity=".9"/>
  <circle cx="342" cy="204" r="26" fill="url(#stick)"
          stroke="#7dd3fc" stroke-width="2"/>
  <circle cx="335" cy="196" r="8" fill="#4b628f" opacity=".55"/>

  <!-- d-pad -->
  <g fill="#0e1730" stroke="#5f7bb0" stroke-width="1.6">
    <rect x="204" y="182" width="24" height="66" rx="7"/>
    <rect x="183" y="203" width="66" height="24" rx="7"/>
  </g>

  <!-- face buttons, palette hues not console trade dress -->
  <g stroke-width="1.8">
    <circle cx="404" cy="112" r="15" fill="#facc15" stroke="#fde68a"/>
    <circle cx="436" cy="144" r="15" fill="#f87171" stroke="#fecaca"/>
    <circle cx="372" cy="144" r="15" fill="#60a5fa" stroke="#bfdbfe"/>
    <circle cx="404" cy="176" r="15" fill="#4ade80" stroke="#bbf7d0"/>
  </g>

  <!-- menu / view -->
  <circle cx="252" cy="132" r="9" fill="#0e1730" stroke="#5f7bb0"/>
  <circle cx="308" cy="132" r="9" fill="#0e1730" stroke="#5f7bb0"/>
</svg>
"""


def cards_html(n):
    hues = ["#60a5fa", "#a78bfa", "#f472b6", "#fbbf24", "#34d399",
            "#f87171", "#7dd3fc", "#818cf8"]
    cards = []
    for i in range(n):
        hue = hues[i % len(hues)]
        cards.append(
            f'<div class="card" style="--h:{hue};--i:{i};--n:{n}"></div>')
    return "\n".join(cards)


def page(w, h, titled, pad_scale, word_vh, cards_n,
         card_w=7.2, cards_bottom=30, pad_bottom=9):
    fonts = fetch_fonts()
    wordmark = "" if not titled else f"""
    <div class="mark" style="top:{word_vh}%">
      <div class="romm">Cartridge</div>
      <div class="tag">FOR&nbsp;XBOX</div>
    </div>"""
    return f"""<!doctype html><meta charset="utf-8"><style>
@font-face {{ font-family:'Orbitron';
  src:url(data:font/woff2;base64,{fonts['Orbitron']}) format('woff2');
  font-weight:100 900; }}
@font-face {{ font-family:'PressStart';
  src:url(data:font/woff2;base64,{fonts['PressStart']}) format('woff2'); }}
* {{ margin:0; box-sizing:border-box }}
html,body {{ width:{w}px; height:{h}px; overflow:hidden; background:#070b18 }}
.stage {{ position:relative; width:100%; height:100%;
  background:
    radial-gradient(120% 90% at 18% 8%,  rgba(125,211,252,.16), transparent 55%),
    radial-gradient(110% 80% at 85% 30%, rgba(129,140,248,.14), transparent 55%),
    radial-gradient(120% 90% at 50% 115%, rgba(74,222,128,.10), transparent 60%),
    linear-gradient(155deg, #0d1730 0%, #0a1226 45%, #070b18 100%); }}

/* synthwave floor */
.floor {{ position:absolute; left:-25%; right:-25%; bottom:-4%; height:46%;
  background:
    repeating-linear-gradient(90deg, rgba(125,211,252,.18) 0 2px, transparent 2px 90px),
    repeating-linear-gradient(0deg,  rgba(125,211,252,.16) 0 2px, transparent 2px 64px);
  transform:perspective(700px) rotateX(62deg);
  transform-origin:50% 0;
  -webkit-mask-image:linear-gradient(to bottom, transparent, #000 28%, #000 72%, transparent);
  mask-image:linear-gradient(to bottom, transparent, #000 28%, #000 72%, transparent); }}

/* cartridge arc */
.cards {{ position:absolute; inset:0; display:flex; justify-content:center;
  align-items:flex-end; gap:1.4%; bottom:{cards_bottom}%; filter:blur(1.2px); }}
.card {{ --mid:calc((var(--n) - 1)/2);
  width:{card_w}%; aspect-ratio:.72; border-radius:10px;
  background:linear-gradient(165deg,
     color-mix(in srgb, var(--h) 92%, white) 0%,
     var(--h) 38%,
     color-mix(in srgb, var(--h) 38%, black) 100%);
  box-shadow: inset 0 2px 0 rgba(255,255,255,.5),
              inset 0 -14px 26px rgba(0,0,0,.38),
              0 24px 46px rgba(0,0,0,.55);
  transform:
    translateY(calc((cos((var(--i) - var(--mid)) * .52rad) * -1 + 1) * 90px))
    rotate(calc((var(--i) - var(--mid)) * 4.5deg));
  opacity:.92; position:relative; }}
.card::after {{ content:""; position:absolute; left:12%; right:12%; top:10%;
  height:34%; border-radius:6px;
  background:linear-gradient(180deg, rgba(255,255,255,.34), rgba(255,255,255,.06));
}}

/* gamepad */
.padwrap {{ position:absolute; left:50%; bottom:{pad_bottom}%;
  width:{pad_scale}%; transform:translateX(-50%); }}
.pad {{ width:100%; height:auto; display:block }}
.underglow {{ position:absolute; left:50%; bottom:{ pad_bottom - 3 }%;
  width:{pad_scale * 0.9}%; height:7%;
  transform:translateX(-50%);
  background:radial-gradient(50% 100% at 50% 100%, rgba(125,211,252,.5), transparent 70%);
  filter:blur(14px); }}

/* wordmark */
.mark {{ position:absolute; left:0; right:0; text-align:center }}
.romm {{ font:900 { round(h * 0.073) }px/1 'Orbitron';
  letter-spacing:.02em; color:#dff3ff;
  background:linear-gradient(180deg,#ffffff 0%,#a5e3ff 45%,#59b8e8 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:
    drop-shadow(0 0 { round(h * 0.012) }px rgba(125,211,252,.95))
    drop-shadow(0 0 { round(h * 0.045) }px rgba(56,152,224,.55)); }}
.tag {{ margin-top:{ round(h * 0.028) }px;
  font:{ round(h * 0.030) }px/1 'PressStart';
  letter-spacing:.42em; text-indent:.42em; color:#4ade80;
  text-shadow:0 0 { round(h * 0.010) }px rgba(74,222,128,.9),
              0 0 { round(h * 0.036) }px rgba(74,222,128,.45); }}

/* atmosphere */
.scan {{ position:absolute; inset:0; pointer-events:none; opacity:.5;
  background:repeating-linear-gradient(0deg,
     rgba(0,0,0,.16) 0 2px, transparent 2px 5px); }}
.noise {{ position:absolute; inset:0; opacity:.05; pointer-events:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23n)'/%3E%3C/svg%3E"); }}
.vig {{ position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(120% 105% at 50% 42%, transparent 55%, rgba(4,7,15,.75) 100%); }}
.frame {{ position:absolute; inset:0; pointer-events:none;
  box-shadow:inset 0 0 0 2px rgba(96,146,208,.45); }}
</style>
<div class="stage">
  <div class="floor"></div>
  <div class="cards">{cards_html(cards_n)}</div>
  <div class="underglow"></div>
  <div class="padwrap">{GAMEPAD_SVG}</div>
  {wordmark}
  <div class="scan"></div><div class="noise"></div>
  <div class="vig"></div><div class="frame"></div>
</div>"""


def browser():
    for b in BROWSERS:
        if Path(b).exists():
            return b
    b = shutil.which("chromium") or shutil.which("chrome")
    if b:
        return b
    sys.exit("no Chromium-based browser found")


def render(name, w, h, titled, pad_scale=58, word_vh=10, cards_n=9,
           card_w=7.2, cards_bottom=30, pad_bottom=9):
    html = page(w, h, titled, pad_scale, word_vh, cards_n,
                card_w, cards_bottom, pad_bottom)
    # Brave releases its profile lockfile a beat after the process exits, which
    # makes strict cleanup lose a race on Windows.
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
        src = Path(td) / "a.html"
        src.write_text(html, encoding="utf-8")
        dst = OUT / name
        r = subprocess.run(
            [browser(), "--headless=new", f"--screenshot={dst}",
             f"--window-size={w},{h}", "--force-device-scale-factor=1",
             "--hide-scrollbars", "--disable-gpu", "--no-sandbox",
             f"--user-data-dir={td}/profile", src.as_uri()],
            capture_output=True, text=True, timeout=120)
        if not dst.exists():
            sys.exit(f"render failed for {name}: {r.stderr[-400:]}")
        print(f"  {name:44} {w}x{h:<5} "
              f"{dst.stat().st_size / 1024:>5.0f} KB")


def main():
    OUT.mkdir(exist_ok=True)
    render("PosterArt_720x1080.png", 720, 1080, True,
           pad_scale=80, word_vh=9, cards_n=7, card_w=15, cards_bottom=34)
    render("PosterArt_1440x2160.png", 1440, 2160, True,
           pad_scale=80, word_vh=9, cards_n=7, card_w=15, cards_bottom=34)
    render("BoxArt_1080x1080.png", 1080, 1080, True,
           pad_scale=66, word_vh=8, cards_n=8, card_w=12.5, cards_bottom=36)
    render("BoxArt_2160x2160.png", 2160, 2160, True,
           pad_scale=66, word_vh=8, cards_n=8, card_w=12.5, cards_bottom=36)
    render("SuperHeroArt_1920x1080_NOTITLE.png", 1920, 1080, False,
           pad_scale=46, cards_n=11, card_w=8.4, cards_bottom=32, pad_bottom=12)
    render("SuperHeroArt_3840x2160_NOTITLE.png", 3840, 2160, False,
           pad_scale=46, cards_n=11, card_w=8.4, cards_bottom=32, pad_bottom=12)
    render("FeaturedPromoSquare_1080x1080_NOTITLE.png", 1080, 1080, False,
           pad_scale=62, cards_n=8, card_w=13, cards_bottom=42, pad_bottom=18)
    render("TitledHeroArt_1920x1080_TITLED.png", 1920, 1080, True,
           pad_scale=44, word_vh=10, cards_n=11, card_w=8.4, cards_bottom=32)
    render("BrandedKeyArt_584x800_TITLED.png", 584, 800, True,
           pad_scale=78, word_vh=9, cards_n=7, card_w=15, cards_bottom=36)
    print(f"\nwrote 9 files to {OUT}")


if __name__ == "__main__":
    main()
