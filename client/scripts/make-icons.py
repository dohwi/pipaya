#!/usr/bin/env python3
"""Regenerate every app icon from one master: src-tauri/app-icon.png (1024x1024, opaque, full-bleed square).

Each OS wants a different shape, so the master is never just resized:
  macOS    squircle on a transparent margin (the Dock draws no mask of its own)        -> icons/icon.icns
  Windows  rounded square, full size, glyph with a small margin; the .ico carries every size  -> icons/icon.ico, PNGs, Square*Logo.png
  Linux    same rounded square                                                          -> icons/icon.png
  Android  adaptive icon: flat background colour + transparent glyph (the launcher
           masks it to a circle / squircle / ...), plus legacy rounded and round PNGs   -> icons/android/
  iOS      full-bleed opaque square WITHOUT an alpha channel (iOS applies the mask)    -> icons/ios/

The master is the pipaya app icon (logo/svg/app-icon.svg). app-icon-glyph.png is the same artwork on a transparent background
(the master with its <rect> removed); both are rendered from the SVG, e.g. with @resvg/resvg-js at 1024 px.

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
GLYPH = Image.open(ROOT / "app-icon-glyph.png").convert("RGBA")  # the artwork alone, transparent background
assert GLYPH.size == (1024, 1024), GLYPH.size

BG = MASTER.getpixel((4, 4))  # flat background colour of the master
SS = 4  # supersampling for smooth mask edges
# How much of the tile the glyph may use on each desktop OS. The master glyph spans ~66% of the tile, which looks cramped once an OS draws
# the icon next to others: the Dock expects ~10% of transparent margin AND air around the artwork, Windows tiles want a little less.
MAC_GLYPH = 0.74
WIN_GLYPH = 0.86
GLYPH_SCALE = 0.62  # master glyph spans ~66% of the canvas; this brings it inside the 61% safe circle of an adaptive icon


def glyph_alpha() -> Image.Image:
    """The artwork's alpha channel (multi-colour logo: taken from the transparent render, not from luminance)."""
    return GLYPH.getchannel("A")


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
    return m.resize((size, size), Image.LANCZOS)


def framed(glyph: float) -> Image.Image:
    """The master with its glyph scaled to `glyph` of the tile, centred on the flat background colour."""
    if glyph == 1.0:
        return MASTER
    out = Image.new("RGB", MASTER.size, BG)
    n = round(MASTER.width * glyph)
    out.paste(MASTER.resize((n, n), Image.LANCZOS), ((MASTER.width - n) // 2, (MASTER.height - n) // 2))
    return out

def shaped(size: int, inset: float, shape: str, radius: float = 0.22, glyph: float = 1.0) -> Image.Image:
    img = framed(glyph).resize((size, size), Image.LANCZOS).convert("RGBA")
    img.putalpha(mask(size, inset, shape, radius))
    return img


def save(img: Image.Image, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


def tauri_icon(source: Image.Image, out: Path):
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "src.png"
        source.save(src)
        subprocess.run(["bun", "run", "tauri", "icon", str(src), "-o", str(out)], check=True, cwd=ROOT.parent, stdout=subprocess.DEVNULL)


def desktop():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # Windows / Linux: rounded square, full size
        tauri_icon(shaped(1024, 0.0, "round", 0.2, WIN_GLYPH), tmp / "win")
        for name in ["icon.ico", "icon.png", "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "StoreLogo.png", *(p.name for p in (tmp / "win").glob("Square*Logo.png"))]:
            shutil.copyfile(tmp / "win" / name, ICONS / name)
        # macOS: squircle with the standard ~10% transparent margin
        tauri_icon(shaped(1024, 0.098, "squircle", glyph=MAC_GLYPH), tmp / "mac")
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
        # adaptive foreground: transparent, glyph only. The master glyph already sits inside the 66% safe zone.
        # Adaptive icons show only the centre 72/108 and circular masks cut further, so the glyph is shrunk to fit
        # inside the 66dp safe circle.
        inner = round(layer * GLYPH_SCALE)
        fg = Image.new("RGBA", (layer, layer), (0, 0, 0, 0))
        fg.paste(GLYPH.resize((inner, inner), Image.LANCZOS), ((layer - inner) // 2, (layer - inner) // 2))
        save(fg, d / "ic_launcher_foreground.png")
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
