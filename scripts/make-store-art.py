#!/usr/bin/env python3
"""Generate the Partner Center Store art (poster + box art).

These are *not* packaged — they are uploaded to the Store listing. They were
missing entirely, and Partner Center calls 9:16 poster art "required for proper
display for customers on Xbox", so the listing rendered badly on the one
platform this app targets.

Same palette as the tile art in make-assets.py so the listing and the installed
app look like the same product. The faded tile grid behind the wordmark is there
because a flat colour field reads as a placeholder at poster size; it also says
"library of games" without needing a real screenshot.

    python scripts/make-store-art.py
Output: store-art/*.png
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BG = (11, 16, 32)          # --bg     #0B1020
BG2 = (18, 26, 51)         # slightly lifted, for the gradient
LINE = (51, 75, 122)       # --line   #334B7A
ACCENT = (125, 211, 252)   # --accent #7DD3FC
GOOD = (74, 222, 128)      # --good   #4ADE80

OUT = Path(__file__).resolve().parent.parent / "store-art"

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
    l, t, r, b = draw.textbbox((0, 0), text, font=fnt)
    x = box[0] + (box[2] - box[0] - (r - l)) / 2 - l
    y = box[1] + (box[3] - box[1] - (b - t)) / 2 - t
    draw.text((x, y), text, font=fnt, fill=fill)


def gradient(w, h):
    """Vertical BG -> BG2. Flat fills look unfinished at poster sizes."""
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    for y in range(h):
        f = y / max(1, h - 1)
        d.line([(0, y), (w, y)],
               fill=tuple(round(a + (b - a) * f) for a, b in zip(BG, BG2)))
    return img


def tile_grid(img, cols, rows, alpha=26):
    """Faded rounded rectangles suggesting a shelf of cover art."""
    w, h = img.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pad = w * 0.055
    cw = (w - pad * (cols + 1)) / cols
    ch = cw * 1.4
    top = h * 0.60
    for r in range(rows):
        for c in range(cols):
            x0 = pad + c * (cw + pad)
            y0 = top + r * (ch + pad * 0.8)
            if y0 > h:
                break
            d.rounded_rectangle([x0, y0, x0 + cw, y0 + ch],
                                radius=cw * 0.09,
                                fill=(125, 211, 252, alpha),
                                outline=(125, 211, 252, alpha + 18),
                                width=max(1, round(w / 500)))
    return Image.alpha_composite(img.convert("RGBA"), layer)


def wordmark(img, top_frac, romm_frac, xbox_frac):
    w, h = img.size
    d = ImageDraw.Draw(img)
    fr, fx = font(round(h * romm_frac)), font(round(h * xbox_frac))
    gap = h * 0.018
    rb = d.textbbox((0, 0), "RomM", font=fr)
    xb = d.textbbox((0, 0), "XBOX", font=fx)
    rh, xh = rb[3] - rb[1], xb[3] - xb[1]
    top = h * top_frac
    centred(d, (0, top, w, top + rh), "RomM", fr, ACCENT)
    centred(d, (0, top + rh + gap, w, top + rh + gap + xh), "XBOX", fx, GOOD)
    return img


def poster(w, h):
    """9:16 — the main logo on Xbox, so the wordmark sits high and large."""
    img = tile_grid(gradient(w, h), cols=3, rows=3)
    img = wordmark(img, top_frac=0.20, romm_frac=0.115, xbox_frac=0.055)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w - 1, h - 1], outline=LINE + (255,),
                width=max(2, round(min(w, h) / 220)))
    return img.convert("RGB")


def box(size):
    """1:1 — used in several Store layouts; keep it tighter than the poster."""
    img = tile_grid(gradient(size, size), cols=4, rows=2, alpha=22)
    img = wordmark(img, top_frac=0.24, romm_frac=0.155, xbox_frac=0.072)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, size - 1, size - 1], outline=LINE + (255,),
                width=max(2, round(size / 220)))
    return img.convert("RGB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    built = {
        # Both accepted sizes for each slot; the larger is what we upload.
        "PosterArt_720x1080.png": poster(720, 1080),
        "PosterArt_1440x2160.png": poster(1440, 2160),
        "BoxArt_1080x1080.png": box(1080),
        "BoxArt_2160x2160.png": box(2160),
    }
    for name, img in built.items():
        path = OUT / name
        img.save(path, "PNG", optimize=True)
        print(f"  {name:28} {img.size[0]}x{img.size[1]}  "
              f"{path.stat().st_size / 1024:.0f} KB")
    print(f"\nwrote {len(built)} files to {OUT}")


if __name__ == "__main__":
    main()
