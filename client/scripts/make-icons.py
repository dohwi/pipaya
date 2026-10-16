#!/usr/bin/env python3
"""Regenerate every app icon from one master: src-tauri/app-icon.png (1024x1024, opaque, full-bleed square).

Each OS wants a different shape, so the master is never just resized:
  macOS    squircle on a transparent margin (the Dock draws no mask of its own)        -> icons/icon.icns
  Windows  rounded square, full size, glyph with a small margin; the .ico carries every size  -> icons/icon.ico, PNGs, Square*Logo.png
  Linux    same rounded square                                                          -> icons/icon.png
  Android  adaptive icon: flat background colour + transparent glyph (the launcher
           masks it to a circle / squircle / ...), plus legacy rounded and round PNGs   -> icons/android/
  iOS      full-bleed opaque square WITHOUT an alpha channel (iOS applies the mask)    -> icons/ios/

The master is the pipaya app icon (logo/svg/app-icon.svg): a cream tile, the crown fills ~86% of its width and the trunk runs off the
bottom edge, so the master is always used at full size inside each OS shape (never shrunk, which would leave the trunk floating).
app-icon-adaptive.png is the Android adaptive foreground (crown inside the safe zone), app-icon-mark.png the whole tree as a
single-colour silhouette (notification icon). All are rendered from the SVGs by scripts/render-icons.ts (run that first).

Needs Pillow and `bun` (the Tauri CLI builds the .icns/.ico containers).  Run from client/:  python3 scripts/make-icons.py
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / "src-tauri"
ICONS = ROOT / "icons"
MASTER = Image.open(ROOT / "app-icon.png").convert("RGB")
assert MASTER.size == (1024, 1024), MASTER.size
ADAPTIVE = Image.open(ROOT / "app-icon-adaptive.png").convert("RGBA")  # Android adaptive foreground, transparent
SILHOUETTE = Image.open(ROOT / "app-icon-mark.png").convert("RGBA")  # whole tree, single colour, transparent

BG = MASTER.getpixel((4, 4))  # flat background colour of the master
SS = 4  # supersampling for smooth mask edges
# Transparent margin around the tile on macOS (the Dock draws no mask of its own and expects ~10% of air).
MAC_INSET = 0.098


def glyph_alpha() -> Image.Image:
    """The silhouette's alpha channel (taken from the transparent render, not from luminance)."""
    return SILHOUETTE.getchannel("A")


def mask(size: int, inset: float, shape: str, radius: float = 0.22) -> Image.Image:
    """Anti-aliased mask: a shape filling the canvas minus `inset` (fraction) on every side."""
    n = size * SS
    m = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(m)
    a, b = n * inset, n * (1 - inset)
    if shape == "circle":
        d.ellipse([a, a, b, b], fill=255)
    elif shape == "squircle":  # Apple-style continuous corner, approximated by a superellipse
        c, r, e = n / 2, (b - a) / 2, 5.0
        pts = []
        steps = 720
        import math

        for i in range(steps):
            t = 2 * math.pi * i / steps
            cs, sn = math.cos(t), math.sin(t)
            pts.append((c + r * math.copysign(abs(cs) ** (2 / e), cs), c + r * math.copysign(abs(sn) ** (2 / e), sn)))
        d.polygon(pts, fill=255)
    else:
        d.rounded_rectangle([a, a, b, b], radius=(b - a) * radius, fill=255)
    return m.resize((size, size), Image.BOX)  # area average: LANCZOS rings and leaves stray alpha outside the shape


def shaped(size: int, inset: float, shape: str, radius: float = 0.22) -> Image.Image:
    """The master scaled into the shape (the shape fills the canvas minus `inset` on every side), transparent outside it."""
    inner = round(size * (1 - 2 * inset))
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    img.paste(MASTER.resize((inner, inner), Image.LANCZOS).convert("RGBA"), ((size - inner) // 2, (size - inner) // 2))
    img.putalpha(ImageChops.multiply(img.getchannel("A"), mask(size, inset, shape, radius)))
    return img


def save(img: Image.Image, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


def tauri_icon(source: Image.Image, out: Path):
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "src.png"
        source.save(src)
        subprocess.run(["bun", "run", "tauri", "icon", str(src), "-o", str(out)], check=True, cwd=ROOT.parent, stdout=subprocess.DEVNULL)


WIN_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
BORDER = (0, 0, 0)  # hairline around the white tile, so it does not melt into a light taskbar
BORDER_ALPHA = 0.16


def win_tile(size: int) -> Image.Image:
    """One Windows icon size, drawn for that size: a rounded white tile with a clean anti-aliased edge and a hairline border.
    Resizing a finished 1024px icon down to 16/32px leaves ragged corners and a dark fringe, so each size is built from the master."""
    img = MASTER.resize((size, size), Image.LANCZOS).convert("RGBA")
    outer = mask(size, 0.0, "round", 0.2)
    if size >= 24:
        w = max(1.0, size / 128) / size  # ~1px at 128px and below, thicker on the big sizes
        inner = mask(size, w, "round", 0.2)
        ring = ImageChops.subtract(outer, inner)
        edge = Image.new("RGBA", img.size, BORDER + (0,))
        edge.putalpha(ring.point(lambda v: round(v * BORDER_ALPHA)))
        img = Image.alpha_composite(img, edge)
    img.putalpha(outer)
    return img


def windows_icons(tmp: Path):
    tiles = {s: win_tile(s) for s in WIN_SIZES}
    big = tiles[256]
    big.save(ICONS / "icon.ico", format="ICO", sizes=[(s, s) for s in WIN_SIZES], append_images=[tiles[s] for s in WIN_SIZES if s != 256])
    for name, size in {"32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256}.items():
        save(tiles[size], ICONS / name)
    save(win_tile(512), ICONS / "icon.png")
    for p in (tmp / "win").glob("Square*Logo.png"):
        n = Image.open(p).size[0]
        save(win_tile(n) if n in tiles else win_tile(n), ICONS / p.name)
    save(win_tile(50), ICONS / "StoreLogo.png")


def desktop():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # Windows / Linux: rounded square, full size
        tauri_icon(shaped(1024, 0.0, "round", 0.2), tmp / "win")
        windows_icons(tmp)
        # macOS: squircle with the standard ~10% transparent margin
        tauri_icon(shaped(1024, MAC_INSET, "squircle"), tmp / "mac")
        shutil.copyfile(tmp / "mac" / "icon.icns", ICONS / "icon.icns")


def android():
    base = ICONS / "android"
    (base / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">#%02X%02X%02X</color>\n</resources>' % BG
    )
    # density -> launcher icon size (dp 48) and adaptive layer size (dp 108)
    for dens, scale in {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}.items():
        legacy, layer = round(48 * scale), round(108 * scale)
        d = base / f"mipmap-{dens}"
        # adaptive foreground: transparent, drawn for the full 108dp layer. Launchers show only the centre 72dp and
        # mask it further (circle, squircle, ...), so the crown sits inside the 66dp safe circle and the trunk runs to the bottom.
        save(ADAPTIVE.resize((layer, layer), Image.LANCZOS), d / "ic_launcher_foreground.png")
        # pre-Android 8 launchers draw the file as is
        save(shaped(legacy, 0.04, "round", 0.2), d / "ic_launcher.png")
        save(shaped(legacy, 0.02, "circle"), d / "ic_launcher_round.png")


def notification_icon():
    """The status bar draws only the alpha channel, tinted by the system: a white glyph on transparent, at 24dp."""
    base = ICONS / "android"
    alpha = glyph_alpha()
    bbox = alpha.point(lambda v: 255 if v > 40 else 0).getbbox()
    glyph = alpha.crop(bbox)
    for dens, scale in {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}.items():
        size = round(24 * scale)
        inner = round(size * 0.84)  # the status bar crops tight, so leave a small margin
        fit = min(inner / glyph.width, inner / glyph.height)
        small = glyph.resize((max(1, round(glyph.width * fit)), max(1, round(glyph.height * fit))), Image.LANCZOS)
        a = Image.new("L", (size, size), 0)
        a.paste(small, ((size - small.width) // 2, (size - small.height) // 2))
        out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
        out.putalpha(a)
        save(out, base / f"drawable-{dens}" / "ic_stat_pipaya.png")

def ios():
    """iOS masks the icon itself; it must be a square without transparency (the App Store rejects an alpha channel)."""
    for p in (ICONS / "ios").glob("*.png"):
        size = Image.open(p).size
        save(MASTER.resize(size, Image.LANCZOS), p)  # RGB: no alpha


def web():
    # apple-touch-icon: also masked by iOS, so a flat square
    save(MASTER.resize((180, 180), Image.LANCZOS), ROOT.parent / "public" / "apple-icon.png")


if __name__ == "__main__":
    desktop()
    android()
    notification_icon()
    ios()
    web()
    print("icons regenerated")
