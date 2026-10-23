/** Terminal look settings: shape, defaults and validation (kept free of runes so tests can import it). */
/** How the terminal looks. `fontFamily` is a CSS font-family list; the fallbacks of the app's mono stack always follow it. */
export interface TerminalPrefs {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  scrollback: number;
  /** App shortcuts win over the shell for every bound Ctrl/Alt/⌘ combo (not only Mod+Shift/Alt and F-keys). */
  appKeysFirst: boolean;
}

/** Maple Mono NGS NF when the device has it; the bundled Maple Mono (app.css) is what draws otherwise. */
export const DEFAULT_TERMINAL_FONT = '"Maple Mono NGS NF", "Maple Mono NF", "Maple Mono"';

export const DEFAULT_TERMINAL: TerminalPrefs = {
  fontFamily: DEFAULT_TERMINAL_FONT,
  fontSize: 13,
  lineHeight: 1.15,
  cursorBlink: true,
  scrollback: 5000,
  appKeysFirst: false,
};

export const TERMINAL_LIMITS = {
  fontSize: { min: 8, max: 32 },
  lineHeight: { min: 1, max: 2 },
  scrollback: { min: 0, max: 100_000 },
} as const;

const clamp = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

function fontFamily(v: unknown): string {
  const f = typeof v === "string" ? v.trim().slice(0, 300) : "";
  return f || DEFAULT_TERMINAL_FONT;
}

/** Keep only valid fields of a stored value; anything missing or broken falls back to the default. */
export function sanitizeTerminal(raw: unknown): TerminalPrefs {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const L = TERMINAL_LIMITS;
  return {
    fontFamily: fontFamily(r.fontFamily),
    fontSize: Math.round(clamp(r.fontSize, L.fontSize.min, L.fontSize.max, DEFAULT_TERMINAL.fontSize)),
    lineHeight: Math.round(clamp(r.lineHeight, L.lineHeight.min, L.lineHeight.max, DEFAULT_TERMINAL.lineHeight) * 100) / 100,
    cursorBlink: typeof r.cursorBlink === "boolean" ? r.cursorBlink : DEFAULT_TERMINAL.cursorBlink,
    scrollback: Math.round(clamp(r.scrollback, L.scrollback.min, L.scrollback.max, DEFAULT_TERMINAL.scrollback)),
    appKeysFirst: typeof r.appKeysFirst === "boolean" ? r.appKeysFirst : DEFAULT_TERMINAL.appKeysFirst,
  };
}
