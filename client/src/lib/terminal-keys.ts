/** Soft-keyboard helper keys for the terminal on touch devices: what each key sends, and sticky Ctrl/Alt. Pure, so tests can import it. */

export type KeyName = "esc" | "tab" | "up" | "down" | "left" | "right" | "home" | "end" | "pgup" | "pgdn" | "del";
export interface Mods {
	ctrl: boolean;
	alt: boolean;
}

const CURSOR: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
const TILDE: Record<string, number> = { pgup: 5, pgdn: 6, del: 3 };

/** Bytes a helper key sends. `appCursor`: the shell asked for application cursor keys (vim, less, readline in some modes). */
export function keySequence(key: KeyName, mods: Partial<Mods> = {}, appCursor = false): string {
	const m = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
	if (key === "esc") return "\x1b";
	if (key === "tab") return mods.alt ? "\x1b\t" : "\t";
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
 * Apply sticky Ctrl/Alt to what the soft keyboard typed. Only a single character is touched (a paste or an escape
 * sequence passes through). `used` tells the caller to release the sticky keys.
 */
export function applyMods(data: string, mods: Mods): { data: string; used: boolean } {
	if (!mods.ctrl && !mods.alt) return { data, used: false };
	const chars = [...data];
	if (chars.length !== 1 || data.startsWith("\x1b")) return { data, used: false };
	let out = data;
	if (mods.ctrl) out = ctrlChar(data) ?? data;
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

/** Keys of the bar: [label, key or literal text, aria-label]. Order matters for the layout. */
export const BAR_KEYS: readonly { id: string; label: string; send?: KeyName; text?: string; repeat?: boolean; title: string }[] = [
	{ id: "esc", label: "Esc", send: "esc", title: "Escape" },
	{ id: "tab", label: "Tab", send: "tab", title: "Tab" },
	{ id: "left", label: "←", send: "left", repeat: true, title: "Left" },
	{ id: "down", label: "↓", send: "down", repeat: true, title: "Down" },
	{ id: "up", label: "↑", send: "up", repeat: true, title: "Up" },
	{ id: "right", label: "→", send: "right", repeat: true, title: "Right" },
	{ id: "home", label: "Home", send: "home", title: "Home" },
	{ id: "end", label: "End", send: "end", title: "End" },
	{ id: "pgup", label: "PgUp", send: "pgup", repeat: true, title: "Page up" },
	{ id: "pgdn", label: "PgDn", send: "pgdn", repeat: true, title: "Page down" },
	{ id: "slash", label: "/", text: "/", title: "/" },
	{ id: "dash", label: "-", text: "-", title: "-" },
	{ id: "pipe", label: "|", text: "|", title: "|" },
	{ id: "tilde", label: "~", text: "~", title: "~" },
	{ id: "bslash", label: "\\", text: "\\", title: "\\" },
	{ id: "ctrlc", label: "^C", text: "\x03", title: "Ctrl+C" },
	{ id: "ctrld", label: "^D", text: "\x04", title: "Ctrl+D" },
	{ id: "ctrll", label: "^L", text: "\x0c", title: "Ctrl+L" },
	{ id: "ctrlr", label: "^R", text: "\x12", title: "Ctrl+R" },
];
