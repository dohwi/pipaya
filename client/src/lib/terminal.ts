import { actionFor, buildCombo, hasLongerBinding, isMac, isNativeTextEditEvent, keyName } from "./keys";
import { PROTOCOL_QUERY, PROTOCOL_VERSION } from "./protocol";

/**
 * Terminals: shells running on the server's own OS (bash/zsh on Linux and macOS, PowerShell on Windows). A terminal
 * is shown in a pane like a conversation and can share a group with conversations; its id starts with `term_`, so a
 * layout tells the two apart by the id alone.
 */

export const TERMINAL_PREFIX = "term_";
export const isTerminalId = (id: string | null | undefined): id is string => !!id && id.startsWith(TERMINAL_PREFIX);

export interface TerminalInfo {
	id: string;
	title: string;
	/** Absolute path on the server */
	cwd: string;
	/** Executable path of the shell */
	shell: string;
	/** false: plain pipes (Windows), so what is typed is echoed by the client */
	pty: boolean;
	pid: number;
	createdAt: number;
}

export interface TerminalShell {
	name: string;
	path: string;
}

export interface TerminalSupport {
	enabled: boolean;
	/** process.platform of the server */
	platform: string;
	pty: boolean;
	shell: TerminalShell | null;
	shells: TerminalShell[];
	max: number;
}

/** "Linux", "macOS", "Windows": what the server runs, for labels. */
export function platformName(platform: string | undefined): string {
	switch (platform) {
		case "linux": return "Linux";
		case "darwin": return "macOS";
		case "win32": return "Windows";
		case "freebsd": return "FreeBSD";
		default: return platform ?? "";
	}
}

/**
 * URL of a terminal's I/O socket. Browsers cannot set headers on a WebSocket, so the credential rides in the query:
 * `credential` is the fragment `Api.streamCredential()` returns (a one-time ticket, or the token for an older server).
 */
export function terminalSocketUrl(baseUrl: string, credential: string, id: string): string {
	const base = baseUrl.replace(/^http/i, "ws");
	return `${base}/terminals/${encodeURIComponent(id)}/ws?${PROTOCOL_QUERY}=${PROTOCOL_VERSION}&${credential}`;
}

/**
 * Keys typed in a terminal belong to the shell (Ctrl+B, Ctrl+W, Esc, Alt+F all mean something there). Only a few app
 * shortcuts reach through: the ones bound with Ctrl/⌘ together with Shift or Alt, and function keys, so the user can
 * still leave the terminal or split it without the mouse (F6 moves to the next pane, Mod+Shift+[ / ] to the next tab).
 * When `nativeEdit` is true, non-Shift OS cursor/delete shortcuts (e.g. ⌘←/→, ⌥←/→, ⌘⌫ on macOS; Ctrl+←/→/Home/End/⌫
 * on Win/Linux) stay with the terminal even when `appFirst` is enabled.
 */
export function appTakesKey(
	e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
	bindings: Record<string, string>,
	appFirst = false,
	nativeEdit = false,
	mac = isMac,
): boolean {
	const mod = e.ctrlKey || e.metaKey;
	const fn = /^F\d{1,2}$/.test(e.code);
	// appFirst: every bound combo with Ctrl/⌘/Alt wins (also the start of a longer one, Ctrl+B of Ctrl+B+\). Plain and
	// Shift-only keys stay the shell's, or typing in the terminal would break.
	if (!fn && !(mod && (e.shiftKey || e.altKey)) && !(appFirst && (mod || e.altKey))) return false;
	const combo = buildCombo({ mod, alt: e.altKey, shift: e.shiftKey }, [keyName(e.code)]);
	if (nativeEdit && !e.shiftKey && isNativeTextEditEvent(e, combo, mac)) return false;
	return !!actionFor(combo, bindings) || (appFirst && hasLongerBinding(combo, bindings));
}

export interface TerminalEditOpts {
	mac?: boolean;
	nativeEdit: boolean;
	pty: boolean;
	/** True while a full-screen TUI (vim, less, tmux) owns the alternate screen buffer. */
	alternate: boolean;
	/** Server OS from `TerminalSupport.platform` ("linux", "darwin", "win32", ...). */
	platform?: string;
}

export type TerminalEditAction = { kind: "send"; data: string } | { kind: "swallow" } | null;

/**
 * macOS line- and word-editing shortcuts that xterm.js does not translate on its own:
 * - ⌘← / ⌘→: line start / end (Ctrl+A / Ctrl+E on Unix, Home / End on Windows)
 * - ⌘⌫: kill to line start (Ctrl+U on Unix, Ctrl+Home on PowerShell/PSReadLine)
 * - ⌥← / ⌥→: word back / forward (ESC+b / ESC+f on Unix, Ctrl+←/→ on Windows)
 * Skips translation in the alternate buffer (vim/less/tmux) or over plain pipes, while still swallowing ⌘+Arrow so
 * the browser never navigates Back/Forward.
 */
export function terminalEditAction(
	e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number },
	opts: TerminalEditOpts,
): TerminalEditAction {
	if (!(opts.mac ?? isMac)) return null;
	if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.shiftKey) return null;
	const translate = opts.nativeEdit && opts.pty && !opts.alternate;
	const win = opts.platform === "win32";
	if (e.metaKey && !e.altKey) {
		if (e.code === "ArrowLeft") return translate ? { kind: "send", data: win ? "\x1b[H" : "\x01" } : { kind: "swallow" };
		if (e.code === "ArrowRight") return translate ? { kind: "send", data: win ? "\x1b[F" : "\x05" } : { kind: "swallow" };
		if (e.code === "ArrowUp" || e.code === "ArrowDown") return { kind: "swallow" };
		if (e.code === "Backspace") return translate ? { kind: "send", data: win ? "\x1b[1;5H" : "\x15" } : null;
		return null;
	}
	if (e.altKey && !e.metaKey && translate) {
		if (e.code === "ArrowLeft") return { kind: "send", data: win ? "\x1b[1;5D" : "\x1bb" };
		if (e.code === "ArrowRight") return { kind: "send", data: win ? "\x1b[1;5C" : "\x1bf" };
	}
	return null;
}

/**
 * Copy / paste keys in a terminal. Ctrl+Shift+C/V always mean copy/paste; plain Ctrl/⌘+C copies only while text is
 * selected (otherwise Ctrl+C stays the shell's interrupt), and plain Ctrl/⌘+V pastes.
 */
export function clipboardKey(e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, hasSelection: boolean): "copy" | "paste" | null {
	if (e.altKey || !(e.ctrlKey || e.metaKey)) return null;
	// The Windows clipboard history (Win+V) pastes by sending Ctrl+V while Win is still held: Ctrl+Meta+V is a paste too.
	if (e.code === "KeyV") return "paste";
	if (e.ctrlKey && e.metaKey) return null;
	if (e.code === "KeyC") return e.shiftKey || hasSelection ? "copy" : null;
	return null;
}

/**
 * Over plain pipes (no PTY) nothing echoes what is typed: draw it locally, roughly like a line editor.
 * Returns what to write on screen for the input `data`.
 */
export function localEcho(data: string): string {
	let out = "";
	for (const ch of data) {
		if (ch === "\r") out += "\r\n";
		else if (ch === "\x7f" || ch === "\b") out += "\b \b";
		else if (ch === "\x1b" || ch.charCodeAt(0) < 0x20) continue;
		else out += ch;
	}
	return out;
}
