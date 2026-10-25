/** Soft-keyboard helper keys for the terminal on touch devices: what each key sends, and sticky Ctrl/Alt. Pure, so tests can import it. */

export type KeyName =
	| "esc" | "tab" | "up" | "down" | "left" | "right" | "home" | "end" | "pgup" | "pgdn" | "del" | "ins"
	| "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12";
export interface Mods {
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

const CURSOR: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
const TILDE: Record<string, number> = { ins: 2, del: 3, pgup: 5, pgdn: 6, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 };
const SS3: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };

/** Bytes a helper key sends. `appCursor`: the shell asked for application cursor keys (vim, less, readline in some modes). */
export function keySequence(key: KeyName, mods: Partial<Mods> = {}, appCursor = false): string {
	const m = 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
	if (key === "esc") return "\x1b";
	if (key === "tab") return mods.shift ? "\x1b[Z" : mods.alt ? "\x1b\t" : "\t";
	const ss3 = SS3[key];
	if (ss3) return m > 1 ? `\x1b[1;${m}${ss3}` : `\x1bO${ss3}`;
	const letter = CURSOR[key];
	if (letter) {
		if (m > 1) return `\x1b[1;${m}${letter}`;
		return appCursor && key !== "home" && key !== "end" ? `\x1bO${letter}` : `\x1b[${letter}`;
	}
	const n = TILDE[key];
	return m > 1 ? `\x1b[${n};${m}~` : `\x1b[${n}~`;
}

/** Control character for a typed character (Ctrl+C = 0x03); null when Ctrl has no meaning for it. */
export function ctrlChar(ch: string): string | null {
	if (ch.length !== 1) return null;
	const c = ch.toLowerCase().charCodeAt(0);
	if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
	if (ch === " " || ch === "@") return "\x00";
	if (ch === "[") return "\x1b";
	if (ch === "\\") return "\x1c";
	if (ch === "]") return "\x1d";
	if (ch === "^") return "\x1e";
	if (ch === "_" || ch === "/") return "\x1f";
	if (ch === "?") return "\x7f";
	return null;
}

/**
 * Apply sticky Ctrl/Alt/Shift to what the soft keyboard typed. Only a single character is touched (a paste or an
 * escape sequence passes through). `used` tells the caller to release the sticky keys.
 */
export function applyMods(data: string, mods: Mods): { data: string; used: boolean } {
	if (!mods.ctrl && !mods.alt && !mods.shift) return { data, used: false };
	const chars = [...data];
	if (chars.length !== 1 || data.startsWith("\x1b")) return { data, used: false };
	let out = mods.shift ? data.toUpperCase() : data;
	if (mods.ctrl) out = ctrlChar(data) ?? out;
	if (mods.alt) out = `\x1b${out}`;
	return { data: out, used: true };
}

/**
 * Touch scrolling: turns finger travel into whole lines and keeps the remainder for the next move.
 * Dragging down shows older output (negative lines).
 */
export function touchLines(carry: number, dy: number, cell: number): { lines: number; carry: number } {
	if (!(cell > 0)) return { lines: 0, carry };
	const total = carry + dy / cell;
	const lines = Math.trunc(total);
	return { lines: -lines || 0, carry: total - lines };
}

export interface BarKey {
	id: string;
	label: string;
	send?: KeyName;
	text?: string;
	/** Sticky modifier: on/off toggle, released after the next key */
	mod?: "ctrl" | "alt";
	/** Not a key: what the button does */
	action?: "paste" | "fit" | "bottom";
	repeat?: boolean;
	title: string;
	/** Starts a new group (a gap before it) */
	gap?: boolean;
}

const sym = (c: string): BarKey => ({ id: `s${c.charCodeAt(0)}`, label: c, text: c, title: c });
const ctl = (c: string): BarKey => ({ id: `c${c}`, label: `^${c.toUpperCase()}`, text: ctrlChar(c)!, title: `Ctrl+${c.toUpperCase()}` });

/** The bar: one scrolling row. Kept short on purpose: modifiers, navigation, a few symbols and the usual Ctrl combos. */
export const BAR_KEYS: readonly BarKey[] = [
	{ id: "esc", label: "Esc", send: "esc", title: "Escape" },
	{ id: "tab", label: "Tab", send: "tab", title: "Tab" },
	{ id: "ctrl", label: "Ctrl", mod: "ctrl", title: "Ctrl", gap: true },
	{ id: "alt", label: "Alt", mod: "alt", title: "Alt" },
	{ id: "left", label: "←", send: "left", repeat: true, title: "Left", gap: true },
	{ id: "down", label: "↓", send: "down", repeat: true, title: "Down" },
	{ id: "up", label: "↑", send: "up", repeat: true, title: "Up" },
	{ id: "right", label: "→", send: "right", repeat: true, title: "Right" },
	{ id: "home", label: "Home", send: "home", title: "Home", gap: true },
	{ id: "end", label: "End", send: "end", title: "End" },
	{ id: "pgup", label: "PgUp", send: "pgup", repeat: true, title: "Page up" },
	{ id: "pgdn", label: "PgDn", send: "pgdn", repeat: true, title: "Page down" },
	{ ...sym("/"), gap: true },
	...[..."-|~_\\$"].map(sym),
	{ ...ctl("c"), gap: true },
	...[..."dzlrawu"].map(ctl),
	{ id: "paste", label: "Paste", action: "paste", title: "Paste", gap: true },
	{ id: "fit", label: "Fit", action: "fit", title: "Fit" },
];
