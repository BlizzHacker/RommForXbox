#!/usr/bin/env python3
"""Generate the Partner Center Store art.

These are *not* packaged — they are uploaded to the Store listing, which had
every art slot empty. Partner Center calls 9:16 poster art "required for proper
display for customers on Xbox", so the listing rendered badly on the one
platform this app targets.

Deliberately original artwork: no real game cover art appears here. Screenshots
of the app showing a user's own library are expected and fine, but promotional
art carrying third-party box art invites a certification rejection, so the
"shelf of games" is evoked with tinted plates instead of borrowed IP.

Partner Center's title rules are strict and mutually opposite — super hero and
featured promotional square art MUST NOT carry the product name, branded key art
and titled hero art MUST carry it in the top 3/4 — so every filename ends
_TITLED or _NOTITLE and the same artwork takes a switch.

    python scripts/make-store-art.py
Output: store-art/*.png
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# App palette (src CSS variables), plus jewel tones for the plates.
INK = (7, 11, 24)
MID = (17, 28, 56)
LIFT = (28, 46, 88)
ACCENT = (125, 211, 252)   # --accent
GOOD = (74, 222, 128)      # --good
TINTS = [(96, 165, 250), (167, 139, 250), (244, 114, 182), (251, 191, 36),
         (52, 211, 153), (248, 113, 113), (125, 211, 252), (129, 140, 248)]

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


def backdrop(w, h):
    """Diagonal three-stop gradient. A flat fill is what made the first
    attempt read as a placeholder; the diagonal gives the frame a light
    direction that the glows below can agree with."""
    diag = w + h
    img = Image.new("RGB", (w, h))
    px = img.load()
    # Build one gradient row of length diag, then sample it by (x+y).
    ramp = []
    for i in range(diag):
        f = i / max(1, diag - 1)
        if f < 0.55:
            t = f / 0.55
            c = tuple(round(a + (b - a) * t) for a, b in zip(INK, MID))
        else:
            t = (f - 0.55) / 0.45
            c = tuple(round(a + (b - a) * t) for a, b in zip(MID, LIFT))
        ramp.append(c)
    for y in range(h):
        for x in range(w):
            px[x, y] = ramp[x + y]
    return img


def glow(img, cx, cy, radius, colour, strength=0.55):
    """Soft radial light. Drawn on its own layer and blurred, because a hard
    ellipse looks like a sticker."""
    w, h = img.size
    layer = Image.new("L", (w, h), 0)
    ImageDraw.Draw(layer).ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius], fill=255)
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.55))
    tint = Image.new("RGB", (w, h), colour)
    return Image.composite(
        Image.blend(img, tint, strength), img,
        layer.point(lambda v: int(v * 0.9)))


def plate(w, h, hue, alpha):
    """One cover-sized plate: saturated vertical gradient with a gloss band.

    Built opaque and rounded by putting the rounded mask *in* the alpha channel
    at the end. Compositing the fill against a mask instead (the first attempt)
    knocked the fill's own alpha out and left ghostly outlines.
    """
    tw, th = max(2, int(w)), max(2, int(h))
    top = tuple(min(255, int(c * 1.22)) for c in hue)
    bot = tuple(int(c * 0.34) for c in hue)
    grad = Image.new("RGB", (tw, th))
    d = ImageDraw.Draw(grad)
    for y in range(th):
        f = y / (th - 1)
        d.line([(0, y), (tw, y)],
               fill=tuple(round(a + (b - a) * f) for a, b in zip(top, bot)))
    tile = grad.convert("RGBA")
    gloss = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    ImageDraw.Draw(gloss).rectangle([0, 0, tw, th * 0.34],
                                    fill=(255, 255, 255, 34))
    tile = Image.alpha_composite(tile, gloss)
    # Rounded silhouette carried in alpha, scaled to the requested opacity.
    mask = Image.new("L", (tw, th), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, tw - 1, th - 1], radius=max(2, tw * 0.10), fill=alpha)
    tile.putalpha(mask)
    return tile


def shelf(img, cols, rows, top_frac, tilt=0.0, alpha=64):
    """A shelf of covers, without using anyone's cover.

    Drawn back-to-front: the furthest rank is smallest, highest and dimmest, so
    the front rank overlaps it. Drawing front-to-back (the first attempt) put
    the small dim plates *over* the large ones, which read as a rendering bug.
    """
    w, h = img.size
    base = img.convert("RGBA")
    pad = w * 0.018
    cw = (w - pad * (cols + 1)) / cols
    ch = cw * 1.36
    for r in range(rows - 1, -1, -1):          # back rank first
        depth = r / max(1, rows)               # 0 = front
        k = 1.0 - depth * 0.30
        a = max(70, int(alpha * (1.0 - depth * 0.40)))
        rw, rh = cw * k, ch * k
        row_w = cols * rw + pad * (cols - 1) * k
        x = (w - row_w) / 2
        y = h * top_frac - r * (rh * 0.34)     # further back sits higher
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        for c in range(cols):
            hue = TINTS[(r * 3 + c) % len(TINTS)]
            wob = math.sin((c + r * 1.7) * 1.1) * rh * 0.05
            yy = y + wob + abs(c - (cols - 1) / 2) * tilt * rh * 0.05
            layer.alpha_composite(plate(rw, rh, hue, a),
                                  (int(x), int(yy)))
            x += rw + pad * k
        if depth:                              # depth of field on back ranks
            layer = layer.filter(ImageFilter.GaussianBlur(w / 500 * depth * 2))
        base = Image.alpha_composite(base, layer)
    return base.convert("RGB")


def vignette(img, strength=0.55):
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).ellipse(
        [-w * 0.25, -h * 0.35, w * 1.25, h * 1.35], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(min(w, h) * 0.16))
    dark = Image.new("RGB", (w, h), INK)
    return Image.composite(img, Image.blend(img, dark, strength), mask)


def tracked(d, text, fnt, track):
    """Width of text with letter tracking applied."""
    return sum(d.textlength(ch, font=fnt) for ch in text) + track * (len(text) - 1)


def draw_tracked(base, text, fnt, fill, cx, y, track, glow_px=0):
    """Letter-spaced text with an optional glow. Tracking is what separates a
    wordmark from default-kerned body type."""
    w, h = base.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x = cx - tracked(d, text, fnt, track) / 2
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=fill + (255,))
        x += d.textlength(ch, font=fnt) + track
    if glow_px:
        halo = layer.filter(ImageFilter.GaussianBlur(glow_px))
        base = Image.alpha_composite(base.convert("RGBA"), halo)
        base = Image.alpha_composite(base, halo)
    return Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB")


def wordmark(img, top_frac, romm_frac):
    w, h = img.size
    fr = font(round(h * romm_frac))
    fx = font(round(h * romm_frac * 0.42))
    d = ImageDraw.Draw(img)
    rb = d.textbbox((0, 0), "RomM", font=fr)
    y = h * top_frac
    img = draw_tracked(img, "RomM", fr, ACCENT, w / 2, y,
                       track=h * romm_frac * 0.02, glow_px=h * romm_frac * 0.10)
    y2 = y + (rb[3] - rb[1]) + h * romm_frac * 0.30
    img = draw_tracked(img, "XBOX", fx, GOOD, w / 2, y2,
                       track=h * romm_frac * 0.13, glow_px=h * romm_frac * 0.05)
    return img


def frame(img):
    w, h = img.size
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w - 1, h - 1], outline=(60, 92, 148),
                width=max(2, round(min(w, h) / 300)))
    return img


def compose(w, h, titled, cols, rows, shelf_top, word_top, word_size, alpha=235):
    img = backdrop(w, h)
    img = glow(img, w * 0.24, h * 0.16, max(w, h) * 0.36, ACCENT, 0.30)
    img = glow(img, w * 0.84, h * 0.72, max(w, h) * 0.30, (56, 189, 172), 0.22)
    img = shelf(img, cols, rows, shelf_top, tilt=1.0, alpha=alpha)
    img = vignette(img)
    if titled:
        img = wordmark(img, word_top, word_size)
    return frame(img)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    built = {
        "PosterArt_720x1080.png":
            compose(720, 1080, True, 4, 3, 0.52, 0.17, 0.115),
        "PosterArt_1440x2160.png":
            compose(1440, 2160, True, 4, 3, 0.52, 0.17, 0.115),
        "BoxArt_1080x1080.png":
            compose(1080, 1080, True, 5, 2, 0.55, 0.20, 0.155),
        "BoxArt_2160x2160.png":
            compose(2160, 2160, True, 5, 2, 0.55, 0.20, 0.155),
        # Title FORBIDDEN.
        "SuperHeroArt_1920x1080_NOTITLE.png":
            compose(1920, 1080, False, 8, 2, 0.40, 0, 0),
        "SuperHeroArt_3840x2160_NOTITLE.png":
            compose(3840, 2160, False, 8, 2, 0.40, 0, 0),
        "FeaturedPromoSquare_1080x1080_NOTITLE.png":
            compose(1080, 1080, False, 5, 3, 0.34, 0, 0),
        # Title REQUIRED, in the top 3/4.
        "TitledHeroArt_1920x1080_TITLED.png":
            compose(1920, 1080, True, 8, 2, 0.52, 0.13, 0.20),
        "BrandedKeyArt_584x800_TITLED.png":
            compose(584, 800, True, 4, 3, 0.50, 0.15, 0.135),
    }
    for name, img in built.items():
        path = OUT / name
        img.save(path, "PNG", optimize=True)
        print(f"  {name:44} {img.size[0]}x{img.size[1]:<5} "
              f"{path.stat().st_size / 1024:>5.0f} KB")
    print(f"\nwrote {len(built)} files to {OUT}")


if __name__ == "__main__":
    main()
