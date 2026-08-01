#!/usr/bin/env python3
"""Generate the packaged tile art in the same design language as the Store art.

The tiles ship *inside* the MSIX (shell/RommForXbox.Shell/Assets), so changing
them means a version bump and a rebuild — but a listing with neon composed art
and an installed tile drawn from flat rectangles reads as two different
products, so they have to match.

Same pipeline as make-store-art.py: HTML/CSS + the same SVG gamepad,
screenshotted by chromium. Small tiles carry only the glyph — at 44 px there is
no room for type — and everything is rendered at 2x then downscaled with
Lanczos, which is what keeps a 44 px tile crisp.

The splash keeps the app's own background colour (#0B1020) at its edges so
launch still feels seamless; a splash that pops against the app it opens into
reads as a flash.

    python scripts/make-tile-art.py emit    -> writes tile-art-html/ + manifest
    python scripts/make-tile-art.py finish  -> downscales /tmp/out 2x renders
                                               into shell Assets + msix Assets
(the render itself runs wherever a working headless chromium lives; see
render_art.py — headless Brave and Edge on Windows produce nothing, silently)
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
HTML_DIR = ROOT / "tile-art-html"
RENDERED = Path(r"C:\Users\wadei\AppData\Local\Temp\tile-out")
DESTS = [ROOT / "shell/RommForXbox.Shell/Assets", ROOT / "msix/Assets"]

sys.path.insert(0, str(ROOT / "scripts"))
# Reuse the store-art template pieces without re-running its main(). exec()
# has no __file__, which the module uses to find its own paths, so supply it.
_ns = {"__file__": str(ROOT / "scripts" / "make-store-art.py")}
exec((ROOT / "scripts/make-store-art.py").read_text(encoding="utf-8")
     .replace('if __name__ == "__main__":\n    main()', ''), _ns)
fetch_fonts = _ns["fetch_fonts"]
GAMEPAD_SVG = _ns["GAMEPAD_SVG"]

# name -> (final_w, final_h, kind)
TILES = {
    "StoreLogo.png": (50, 50, "glyph"),
    "Square44x44Logo.png": (44, 44, "glyph"),
    "Square71x71Logo.png": (71, 71, "glyph"),
    "Square150x150Logo.png": (150, 150, "tile"),
    "Square310x310Logo.png": (310, 310, "tile"),
    "Square480x480Logo.png": (480, 480, "tile"),
    "Wide310x150Logo.png": (310, 150, "wide"),
    "SplashScreen.png": (620, 300, "splash"),
}


def tile_page(w, h, kind, scale=2):
    """One tile at 2x. Glyphs are the pad alone; tiles add the wordmark when
    there is room; the wide tile puts them side by side; the splash centres the
    lockup on the app's own background."""
    fonts = fetch_fonts()
    W, H = w * scale, h * scale
    if kind == "glyph":
        body = f'<div class="padwrap" style="width:86%">{GAMEPAD_SVG}</div>'
    elif kind == "tile":
        body = f"""
        <div class="mark"><div class="romm" style="font-size:{H * 0.17}px">RomM</div></div>
        <div class="padwrap" style="width:74%;bottom:9%">{GAMEPAD_SVG}</div>"""
    elif kind == "wide":
        body = f"""
        <div class="row">
          <div class="romm" style="font-size:{H * 0.30}px">RomM</div>
          <div class="padwrap-inline" style="width:38%">{GAMEPAD_SVG}</div>
        </div>"""
    else:  # splash
        body = f"""
        <div class="row">
          <div>
            <div class="romm" style="font-size:{H * 0.26}px">RomM</div>
            <div class="tag" style="font-size:{H * 0.055}px">FOR&nbsp;XBOX</div>
          </div>
          <div class="padwrap-inline" style="width:34%">{GAMEPAD_SVG}</div>
        </div>"""
    bg = "#0B1020" if kind == "splash" else "#070b18"
    return f"""<!doctype html><meta charset="utf-8"><style>
@font-face {{ font-family:'Orbitron';
  src:url(data:font/woff2;base64,{fonts['Orbitron']}) format('woff2');
  font-weight:100 900; }}
@font-face {{ font-family:'PressStart';
  src:url(data:font/woff2;base64,{fonts['PressStart']}) format('woff2'); }}
* {{ margin:0; box-sizing:border-box }}
html,body {{ width:{W}px; height:{H}px; overflow:hidden; background:{bg} }}
.stage {{ position:relative; width:100%; height:100%; display:flex;
  align-items:center; justify-content:center;
  background:
    radial-gradient(130% 110% at 20% 10%, rgba(125,211,252,.18), transparent 55%),
    radial-gradient(120% 100% at 85% 90%, rgba(74,222,128,.10), transparent 60%),
    linear-gradient(155deg, #101c38 0%, #0a1226 55%, {bg} 100%); }}
.padwrap {{ position:absolute; left:50%; bottom:7%;
  transform:translateX(-50%); }}
.padwrap .pad, .padwrap-inline .pad {{ width:100%; height:auto; display:block }}
.mark {{ position:absolute; top:7%; left:0; right:0; text-align:center }}
.romm {{ font-family:'Orbitron'; font-weight:900; line-height:1;
  background:linear-gradient(180deg,#ffffff 0%,#a5e3ff 45%,#59b8e8 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:drop-shadow(0 0 {H * 0.015}px rgba(125,211,252,.9)); }}
.tag {{ margin-top:{H * 0.04}px; font-family:'PressStart';
  letter-spacing:.38em; color:#4ade80;
  text-shadow:0 0 {H * 0.012}px rgba(74,222,128,.85); }}
.row {{ display:flex; align-items:center; gap:{W * 0.05}px }}
.vig {{ position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(130% 120% at 50% 45%, transparent 60%, rgba(4,7,15,.6) 100%); }}
</style>
<div class="stage">{body}<div class="vig"></div></div>"""


def emit():
    HTML_DIR.mkdir(exist_ok=True)
    manifest = []
    for name, (w, h, kind) in TILES.items():
        # chromium refuses to lay out a sub-100px window properly — a 44px tile
        # came back as 384 blank bytes — so small tiles render at 8x and the
        # Lanczos downscale in finish() absorbs the difference.
        scale = 8 if min(w, h) < 100 else 2
        fn = name.replace(".png", ".html")
        (HTML_DIR / fn).write_text(tile_page(w, h, kind, scale),
                                   encoding="utf-8")
        manifest.append({"html": fn, "png": name,
                         "w": w * scale, "h": h * scale})
    (HTML_DIR / "manifest.json").write_text(json.dumps(manifest))
    print(f"wrote {len(TILES)} tile pages to {HTML_DIR}")


def finish():
    missing = [n for n in TILES if not (RENDERED / n).exists()]
    if missing:
        sys.exit(f"renders missing from {RENDERED}: {missing}")
    for dest in DESTS:
        dest.mkdir(parents=True, exist_ok=True)
    for name, (w, h, _) in TILES.items():
        img = Image.open(RENDERED / name).convert("RGB")
        img = img.resize((w, h), Image.LANCZOS)
        for dest in DESTS:
            img.save(dest / name, "PNG", optimize=True)
        print(f"  {name:26} -> {w}x{h}")
    print("tile assets replaced in shell/ and msix/")


if __name__ == "__main__":
    {"emit": emit, "finish": finish}.get(
        sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
