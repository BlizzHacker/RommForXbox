#!/usr/bin/env python3
"""Regenerate the MSIX tile art in msix/Assets.

Kept as a script rather than hand-made PNGs so the whole set stays in one
style, and so a size can be added without redrawing anything. Colours are the
app's own CSS variables.

The splash screen matters more than it looks: a UWP app without one launches to
a black rectangle, which reads as a hang on a console.

    python scripts/make-assets.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BG = (11, 16, 32)          # --bg   #0B1020
LINE = (51, 75, 122)       # --line #334B7A
ACCENT = (125, 211, 252)   # --accent #7DD3FC
GOOD = (74, 222, 128)      # --good #4ADE80

OUT = Path(__file__).resolve().parent.parent / "msix" / "Assets"

FONTS = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def font(size):
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def centred(draw, box, text, fnt, fill):
    """Draw text centred in box=(x0,y0,x1,y1) using its real ink extents."""
    l, t, r, b = draw.textbbox((0, 0), text, font=fnt)
    x = box[0] + (box[2] - box[0] - (r - l)) / 2 - l
    y = box[1] + (box[3] - box[1] - (b - t)) / 2 - t
    draw.text((x, y), text, font=fnt, fill=fill)


def plate(w, h, border=True):
    img = Image.new("RGBA", (w, h), BG + (255,))
    d = ImageDraw.Draw(img)
    if border:
        d.rectangle([0, 0, w - 1, h - 1], outline=LINE, width=max(1, round(min(w, h) / 60)))
    return img, d


def stacked(w, h, romm_frac=0.30, xbox_frac=0.15, border=True):
    """'RomM' over 'XBOX' — the square and splash lockup."""
    img, d = plate(w, h, border)
    fr, fx = font(round(h * romm_frac)), font(round(h * xbox_frac))
    gap = h * 0.06
    rh = d.textbbox((0, 0), "RomM", font=fr)[3] - d.textbbox((0, 0), "RomM", font=fr)[1]
    xh = d.textbbox((0, 0), "XBOX", font=fx)[3] - d.textbbox((0, 0), "XBOX", font=fx)[1]
    total = rh + gap + xh
    top = (h - total) / 2
    centred(d, (0, top, w, top + rh), "RomM", fr, ACCENT)
    centred(d, (0, top + rh + gap, w, top + total), "XBOX", fx, GOOD)
    return img


def inline(w, h):
    """'RomM XBOX' side by side — the wide tile."""
    img, d = plate(w, h)
    fr, fx = font(round(h * 0.40)), font(round(h * 0.24))
    wr = d.textbbox((0, 0), "RomM", font=fr)[2] - d.textbbox((0, 0), "RomM", font=fr)[0]
    wx = d.textbbox((0, 0), "XBOX", font=fx)[2] - d.textbbox((0, 0), "XBOX", font=fx)[0]
    gap = w * 0.04
    x0 = (w - (wr + gap + wx)) / 2
    centred(d, (x0, 0, x0 + wr, h), "RomM", fr, ACCENT)
    centred(d, (x0 + wr + gap, 0, x0 + wr + gap + wx, h), "XBOX", fx, GOOD)
    return img


def mark(size):
    """Just 'RM' — below ~70 px the two-line lockup is unreadable."""
    img, d = plate(size, size)
    centred(d, (0, 0, size, size), "RM", font(round(size * 0.46)), ACCENT)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    built = {
        # Store + tiles
        "StoreLogo.png": lambda: mark(50),
        "Square44x44Logo.png": lambda: mark(44),
        "Square71x71Logo.png": lambda: mark(71),
        "Square150x150Logo.png": lambda: stacked(150, 150),
        "Square310x310Logo.png": lambda: stacked(310, 310),
        "Wide310x150Logo.png": lambda: inline(310, 150),
        # Xbox uses a large square on the home tile
        "Square480x480Logo.png": lambda: stacked(480, 480),
        # Launch screen — 620x300 is the standard 1x splash size
        "SplashScreen.png": lambda: stacked(620, 300, romm_frac=0.30, xbox_frac=0.15),
    }
    for name, make in built.items():
        img = make()
        img.save(OUT / name, "PNG", optimize=True)
        print(f"{name:26} {img.width}x{img.height}")


if __name__ == "__main__":
    main()
