#!/usr/bin/env python3
"""Split the terminal font into text and icons, so the icons are fetched only when a terminal shows one.

Usage: python3 client/scripts/split-terminal-font.py <MapleMono-NF-Regular> <MapleMono-NF-Bold>   (ttf or woff2)
Writes client/public/fonts/maplemono-regular.woff2, maplemono-bold.woff2 and maplemono-icons.woff2, and prints the
`unicode-range` values for the @font-face rules in client/src/app.css. Paste them there when they change.
Needs: pip install fonttools brotli.

Maple Mono NF carries about 10,000 Nerd Font icons in the Unicode private-use ranges; they are 90% of each file and a
plain shell prompt uses none. Matching `unicode-range`s are what make a browser fetch the icon file only when a page
shows a character from it.
The icons are drawn the same at both weights, except a few; those few stay in the text files, so that one icon file can
serve both weights and nothing looks different from the unsplit font.
In app.css the icon file needs one @font-face per weight (400 and 700), not `font-weight: 400 700`: with a weight range
Chromium picks that face for regular text and never fetches the regular file.
Every OpenType feature (ligatures, character variants) is kept; the files are subsets, nothing is redrawn.
"""
import pathlib, sys

from fontTools import subset
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

# Private Use Area (BMP) and Supplementary Private Use Area-A: where Nerd Fonts puts its icons.
ICONS = [(0xE000, 0xF8FF), (0xF0000, 0xFFFFD)]
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "fonts"


def in_icon_blocks(cp: int) -> bool:
    return any(lo <= cp <= hi for lo, hi in ICONS)


def drawing(font: TTFont, cp: int):
    name = font.getBestCmap()[cp]
    pen = RecordingPen()
    font.getGlyphSet()[name].draw(pen)
    return pen.value, font["hmtx"][name]


def ranges(cps) -> str:
    """`U+E000-E0A0, U+E0A2` for a set of code points."""
    out, run = [], []
    for cp in sorted(cps):
        if run and cp == run[-1] + 1:
            run.append(cp)
        else:
            if run:
                out.append(run)
            run = [cp]
    if run:
        out.append(run)
    return ", ".join(f"U+{r[0]:X}" if len(r) == 1 else f"U+{r[0]:X}-{r[-1]:X}" for r in out)


def write(src: str, cps, name: str) -> int:
    font = TTFont(src)
    opts = subset.Options()
    opts.layout_features = ["*"]  # ligatures and variants stay
    opts.flavor = "woff2"
    opts.notdef_outline = True
    opts.name_IDs = ["*"]
    s = subset.Subsetter(opts)
    s.populate(unicodes=sorted(cps))
    s.subset(font)
    path = OUT / name
    font.flavor = "woff2"
    font.save(path)
    return path.stat().st_size


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    regular, bold = (TTFont(p) for p in sys.argv[1:])
    every = set(regular.getBestCmap())
    if every != set(bold.getBestCmap()):
        sys.exit("the two weights do not cover the same characters")
    # An icon whose drawing depends on the weight cannot come from the shared file.
    shared = {cp for cp in every if in_icon_blocks(cp) and drawing(regular, cp) == drawing(bold, cp)}
    text = every - shared
    sizes = {
        "maplemono-regular.woff2": write(sys.argv[1], text, "maplemono-regular.woff2"),
        "maplemono-bold.woff2": write(sys.argv[2], text, "maplemono-bold.woff2"),
        "maplemono-icons.woff2": write(sys.argv[1], shared, "maplemono-icons.woff2"),
    }
    for name, size in sizes.items():
        print(f"{size / 1024:7.0f} kB  {name}")
    kept = set(TTFont(OUT / "maplemono-regular.woff2").getBestCmap()) | set(TTFont(OUT / "maplemono-icons.woff2").getBestCmap())
    if kept != every:
        sys.exit(f"characters lost: {len(every - kept)}")
    print(f"{len(every)} characters, none lost; {len(shared)} icons shared by both weights, {len(text) - len([c for c in text if not in_icon_blocks(c)])} icons kept per weight")
    # The text faces claim everything the icon face does not, so a character outside both files still falls through
    # to the next font of the stack exactly as before.
    icon_cps = set()
    for lo, hi in ICONS:
        icon_cps.update(range(lo, hi + 1))
    per_weight = sorted(cp for cp in text if in_icon_blocks(cp))
    holes = ranges(icon_cps - set(per_weight))
    print("\nunicode-range of the two text faces:\n  " + ", ".join(["U+0-DFFF", *(f"U+{cp:X}" for cp in per_weight), "U+F900-EFFFF"]))
    print("unicode-range of the icon faces:\n  " + holes)


if __name__ == "__main__":
    main()
