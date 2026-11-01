#!/usr/bin/env python3
"""Static design lint for client styles (DESIGN.md). No server, no browser: run it before every UI commit.

  python3 scripts/ui-lint.py            # check client/src/**/*.svelte <style> and client/src/app.css
  python3 scripts/ui-lint.py --all      # also list the exceptions that carry a comment

Flags, unless the same line or the line above carries a /* comment */ that says why:
  spacing   margin / padding / gap / inset values off the 4px scale (0, 1, 4, 8, 12, 16, 20, 24, … ; 1px hairlines allowed)
  em-space  margin / padding / gap in em (scales with the font: 0.85em of 15px = 12.75px)
  z-index   a raw number above 9 (use a --z-* token from app.css; 0-9 inside one component is fine)
  nudge     margin-left/right/top: -Npx used to centre or nudge (fix the box instead)
Exit code 1 when something is flagged.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "client/src"
SPACE = re.compile(r"(?<![-\w])(margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left)(-(?:top|right|bottom|left|inline|block)(?:-start|-end)?)?\s*:\s*([^;{}]+);")
Z = re.compile(r"(?<![-\w])z-index\s*:\s*(-?\d+)")
PX = re.compile(r"(-?\d*\.?\d+)px")
EM = re.compile(r"(-?\d*\.?\d+)em\b")


def style_blocks(path: pathlib.Path):
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".css":
        yield 0, text
        return
    for m in re.finditer(r"<style[^>]*>(.*?)</style>", text, re.S):
        yield text[: m.start(1)].count("\n"), m.group(1)


def commented(lines, i):
    """A comment on the line, or in the same rule just above it (up to 4 lines back, not past the previous rule's end)."""
    if "/*" in lines[i]:
        return True
    for j in range(i - 1, max(-1, i - 5), -1):
        s = lines[j]
        if "*/" in s or "/*" in s:
            return True
        if "}" in s:
            return False
    return False


def on_scale(v: float) -> bool:
    v = abs(v)
    return v in (0, 1) or (v.is_integer() and v % 4 == 0)


def main():
    show_all = "--all" in sys.argv
    files = sorted(SRC.rglob("*.svelte")) + [SRC / "app.css"]
    hits, allowed = [], []
    for f in files:
        for offset, css in style_blocks(f):
            lines = css.split("\n")
            for i, line in enumerate(lines):
                where = f"{f.relative_to(ROOT)}:{offset + i + 1}"
                ok = commented(lines, i)
                for m in SPACE.finditer(line):
                    prop, val = m.group(1) + (m.group(2) or ""), m.group(3)
                    if prop in ("top", "right", "bottom", "left", "inset") and "%" in val:
                        continue
                    pos = prop in ("top", "right", "bottom", "left") or prop.startswith("inset")
                    if "calc(" not in val and "var(" not in val:
                        bad = [float(x) for x in PX.findall(val) if not on_scale(float(x))]
                        if bad and not pos:
                            (allowed if ok else hits).append((where, "spacing", f"{prop}: {val.strip()}"))
                        if prop.startswith("margin") and any(float(x) < -1 for x in PX.findall(val)) and not ok:
                            hits.append((where, "nudge", f"{prop}: {val.strip()}"))
                    if not pos and EM.search(val) and "calc(" not in val:
                        (allowed if ok else hits).append((where, "em-space", f"{prop}: {val.strip()}"))
                for m in Z.finditer(line):
                    if abs(int(m.group(1))) > 9:
                        (allowed if ok else hits).append((where, "z-index", line.strip()))
    seen = set()
    for where, kind, what in hits:
        if (where, kind) in seen:
            continue
        seen.add((where, kind))
        print(f"{where}  {kind:8s} {what}")
    if show_all:
        print(f"\n-- {len(allowed)} commented exceptions --")
        for where, kind, what in allowed:
            print(f"{where}  {kind:8s} {what}")
    print(f"\nui-lint: {len(seen)} problem(s)" + ("" if seen else " — clean"))
    sys.exit(1 if seen else 0)


if __name__ == "__main__":
    main()
