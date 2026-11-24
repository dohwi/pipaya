#!/usr/bin/env python3
"""Static design lint for client styles (DESIGN.md). No server, no browser: run it before every UI commit.

  python3 scripts/ui-lint.py            # check client/src/**/*.svelte <style> and client/src/app.css
  python3 scripts/ui-lint.py --all      # also list the exceptions that carry a comment

Flags, unless the same line or the line above carries a /* comment */ that says why:
  spacing   margin / padding / gap / inset values off the 4px scale (0, 1, 4, 8, 12, 16, 20, 24, … ; 1px hairlines allowed)
  em-space  margin / padding / gap in em (scales with the font: 0.85em of 15px = 12.75px)
  z-index   a raw number above 9 (use a --z-* token from app.css; 0-9 inside one component is fine)
  nudge     margin-left/right/top: -Npx used to centre or nudge (fix the box instead)
  hover     a :hover rule that only tints (background / border / color) outside @media (hover: hover): it sticks on touch
  radius    a literal px corner above 3 (use a --radius-* token, or calc() / min() of one, so an extension theme reaches it)
  glow      a box-shadow / drop-shadow with a blur and a colour from a token or color-mix (a decorative halo; grey
            elevation tokens like var(--shadow) and hard focus spreads `0 0 0 3px` pass)
  shadow    box-shadow: var(--shadow | --shadow-soft | --shadow-sm | --shadow-up) or a literal elevation: hybrid zero-shadow, the only
            elevation is var(--shadow-overlay) on a light non-modal overlay (a hairline `inset 0 0 0 1px` ring is not elevation)
  halo      a focus halo `0 0 0 Npx var(--accent-soft | --danger-soft)`: focus is `outline: 2px solid` (offset -1px on bordered fields)
  disabled  `opacity` in a :disabled / .disabled rule (blanket fade): use --disabled-bg / --disabled-border / --disabled-fg
  motion    --ease-spring, a `shake` / `ping` keyframe, or box-shadow in a transition (restrained 120-180ms ease-out, transform / opacity)
  chip      markup `class="chip …"`: a hand-made state pill (use Badge; a toggle is a Switch, one-of-N a Segmented).
            Allowed when the element carries `data-lint-ok` or the line holds a <!-- comment --> saying why
Exit code 1 when something is flagged.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "client/src"
SPACE = re.compile(r"(?<![-\w])(margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left)(-(?:top|right|bottom|left|inline|block)(?:-start|-end)?)?\s*:\s*([^;{}]+);")
Z = re.compile(r"(?<![-\w])z-index\s*:\s*(-?\d+)")
RADIUS = re.compile(r"(?<![-\w])border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius\s*:\s*([^;{}]+);")
PX = re.compile(r"(-?\d*\.?\d+)px")
EM = re.compile(r"(-?\d*\.?\d+)em\b")
# the PinMark hosts (PinMark.svelte's :where list): a rule reaching every svg inside them also hits the mark's own pin
PIN_HOSTS = ("lead", "dicon", "ico", "agent")
PINHOST = re.compile(r"\.(" + "|".join(PIN_HOSTS) + r")\s+(?::global\()?svg\b")
# properties a hover may change and still be "only a tint"; anything else (opacity, display, transform) reveals or moves something
# a blurred coloured shadow: `0 0 <blur>px …` (any blur > 0 with a 0 offset) in a colour, not an elevation token
GLOW = re.compile(r"^0(?:px)?\s+0(?:px)?\s+([1-9]\d*(?:\.\d+)?)px\b.*(?:var\(--(?!shadow)|color-mix|#|rgb)")


def layers(value: str):
    """The comma-separated layers of a shadow, not split inside color-mix( … , … )."""
    out, depth, cur = [], 0, ""
    for c in value:
        depth += (c == "(") - (c == ")")
        if c == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += c
    return out + [cur.strip()]
ELEVATION = re.compile(r"var\(--shadow(?:-soft|-sm|-up)?\)|^0(?:px)?\s+[1-9]\d*(?:px)?\s+[1-9]\d*px")
HALO = re.compile(r"0(?:px)?\s+0(?:px)?\s+(?:0(?:px)?\s+)?[1-9]\d*px\s+var\(--(?:accent|danger)-soft\)")
GLOW_FILTER = re.compile(r"drop-shadow\(")
# a hand-made pill in markup (the global .chip): states are a Badge, toggles a Switch
CHIP = re.compile(r'class="(?:[^"]*\s)?chip(?:\s[^"]*)?"')
# the model button's level / speed labels: part of a control (they size with the trigger and shrink in a narrow pane), not a state badge
CHIP_OK = {"client/src/components/models/ModelField.svelte"}
TINT = re.compile(r"^(background(-color|-image)?|color|border(-\w+)?-color|box-shadow|text-decoration(-\w+)?|outline(-color)?|filter|stroke|fill|--[\w-]+)$")


def bare_hovers(css: str):
    """(line index, selector) of every :hover rule that only tints and is not inside @media (hover: hover)."""
    css_nc = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), css, flags=re.S)
    stack, start = [], 0
    for j, c in enumerate(css_nc):
        if c == "{":
            stack.append((css_nc[start:j].strip(), j))
            start = j + 1
        elif c == "}":
            if not stack:
                start = j + 1
                continue
            sel, at = stack.pop()
            start = j + 1
            if sel.startswith("@") or ":hover" not in sel:
                continue
            if any(s.startswith("@media") and re.search(r"hover:\s*hover", s) for s, _ in stack):
                continue
            props = [p.split(":", 1)[0].strip() for p in css_nc[at + 1 : j].split(";") if ":" in p]
            if props and all(TINT.match(p) for p in props):
                yield css_nc[:at].count("\n"), " ".join(sel.split())


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
        has_pin = "pinmark" in f.read_text(encoding="utf-8").lower()
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
                if has_pin and PINHOST.search(line.split("/*")[0]):
                    hits.append((where, "pinhost", line.strip()))
                for m in RADIUS.finditer(line):
                    if "var(" not in m.group(1) and any(float(x) > 3 for x in PX.findall(m.group(1))):
                        (allowed if ok else hits).append((where, "radius", f"border-radius: {m.group(1).strip()}"))
                for m in Z.finditer(line):
                    if abs(int(m.group(1))) > 9:
                        (allowed if ok else hits).append((where, "z-index", line.strip()))
            nc = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), css, flags=re.S)
            for m in re.finditer(r"(?<![-\w])box-shadow\s*:([^;{}]+);", nc):
                i = nc[: m.start()].count("\n")
                if any(GLOW.search(x) for x in layers(" ".join(m.group(1).split()))):
                    (allowed if commented(lines, i) else hits).append((f"{f.relative_to(ROOT)}:{offset + i + 1}", "glow", " ".join(m.group(0).split())[:90]))
            for m in re.finditer(r"(?<![-\w])box-shadow\s*:([^;{}]+);", nc):
                i = nc[: m.start()].count("\n")
                val = " ".join(m.group(1).split())
                where = f"{f.relative_to(ROOT)}:{offset + i + 1}"
                if HALO.search(val):
                    (allowed if commented(lines, i) else hits).append((where, "halo", val[:90]))
                elif any(ELEVATION.search(x) for x in layers(val)) and "--shadow-overlay" not in val:
                    (allowed if commented(lines, i) else hits).append((where, "shadow", val[:90]))
            for m in re.finditer(r"(?<![-\w])transition\s*:[^;{}]*box-shadow[^;{}]*;", nc):
                i = nc[: m.start()].count("\n")
                (allowed if commented(lines, i) else hits).append((f"{f.relative_to(ROOT)}:{offset + i + 1}", "motion", "transition: … box-shadow"))
            for m in re.finditer(r"--ease-spring|@keyframes\s+(?:shake|[\w-]*ping)\b", nc):
                i = nc[: m.start()].count("\n")
                (allowed if commented(lines, i) else hits).append((f"{f.relative_to(ROOT)}:{offset + i + 1}", "motion", m.group(0)))
            for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", nc):
                if re.search(r":disabled|\.disabled\b", m.group(1)) and re.search(r"(?<![-\w])opacity\s*:\s*(?!0\s*(?:;|$))\S", m.group(2)):
                    i = nc[: m.start(2)].count("\n")
                    (allowed if commented(lines, i) else hits).append((f"{f.relative_to(ROOT)}:{offset + i + 1}", "disabled", " ".join(m.group(1).split())[:90]))
            for m in GLOW_FILTER.finditer(nc):
                i = nc[: m.start()].count("\n")
                (allowed if commented(lines, i) else hits).append((f"{f.relative_to(ROOT)}:{offset + i + 1}", "glow", lines[i].strip()[:90]))
            for i, sel in bare_hovers(css):
                (allowed if commented(lines, i) else hits).append((f"{f.relative_to(ROOT)}:{offset + i + 1}", "hover", sel[:90]))
    for f in files:
        if f.suffix != ".svelte":
            continue
        text = re.sub(r"<style[^>]*>.*?</style>", lambda m: "\n" * m.group(0).count("\n"), f.read_text(encoding="utf-8"), flags=re.S)
        for i, line in enumerate(text.split("\n")):
            if CHIP.search(line):
                ok = "data-lint-ok" in line or "<!--" in line or str(f.relative_to(ROOT)) in CHIP_OK
                (allowed if ok else hits).append((f"{f.relative_to(ROOT)}:{i + 1}", "chip", line.strip()[:90]))
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
