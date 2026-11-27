import { describe, expect, test } from "bun:test";
import { pair } from "../src/lib/layout";
import { sessionOrder, sidebarDirs } from "../src/lib/nav";
import { DEFAULT_BINDINGS } from "../src/lib/keys";
import { PROTOCOL_VERSION } from "../src/lib/protocol";
import { appTakesKey, clipboardKey, isTerminalId, localEcho, platformName, terminalEditAction, terminalSocketUrl, type TerminalInfo } from "../src/lib/terminal";
import type { Group, Session } from "../src/lib/types";

const sess = (id: string, cwd: string, updatedAt: number) => ({ id, cwd, updatedAt, title: id }) as Session;
const term = (id: string, cwd: string, createdAt = 0) => ({ id, cwd, createdAt, title: id }) as TerminalInfo;
const key = (code: string, m: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({ code, ctrlKey: !!m.ctrl, metaKey: !!m.meta, altKey: !!m.alt, shiftKey: !!m.shift });

describe("terminal ids and urls", () => {
	test("terminal ids are told apart by their prefix", () => {
		expect(isTerminalId("term_123")).toBe(true);
		expect(isTerminalId("abc")).toBe(false);
		expect(isTerminalId(null)).toBe(false);
	});
	test("the socket url swaps the scheme and carries the credential it is given", () => {
		expect(terminalSocketUrl("https://h:1", "ticket=abc", "term_x")).toBe(`wss://h:1/terminals/term_x/ws?protocol=${PROTOCOL_VERSION}&ticket=abc`);
		expect(terminalSocketUrl("http://h", "token=t", "x").startsWith("ws://h/")).toBe(true);
	});
	test("platform names", () => {
		expect(platformName("win32")).toBe("Windows");
		expect(platformName("darwin")).toBe("macOS");
		expect(platformName("linux")).toBe("Linux");
	});
});

describe("keys in a terminal", () => {
	test("plain and Ctrl/Alt keys belong to the shell", () => {
		expect(appTakesKey(key("KeyB", { ctrl: true }), DEFAULT_BINDINGS)).toBe(false); // Ctrl+B = toggle sidebar elsewhere
		expect(appTakesKey(key("KeyN", { alt: true }), DEFAULT_BINDINGS)).toBe(false);
		expect(appTakesKey(key("KeyA"), DEFAULT_BINDINGS)).toBe(false);
	});
	test("Mod+Shift shortcuts still reach the app", () => {
		expect(appTakesKey(key("KeyN", { ctrl: true, alt: true }), DEFAULT_BINDINGS)).toBe(true); // new terminal
		expect(appTakesKey(key("KeyZ", { ctrl: true, shift: true }), DEFAULT_BINDINGS)).toBe(false); // unbound
	});
});

describe("app shortcuts first in a terminal", () => {
	test("off by default: Ctrl+B and Ctrl+N stay with the shell", () => {
		expect(appTakesKey(key("KeyB", { ctrl: true }), DEFAULT_BINDINGS, false)).toBe(false);
		expect(appTakesKey(key("KeyN", { ctrl: true }), DEFAULT_BINDINGS, false)).toBe(false);
	});
	test("on: bound Ctrl/Alt combos and chord starts go to the app", () => {
		expect(appTakesKey(key("KeyN", { ctrl: true }), DEFAULT_BINDINGS, true)).toBe(true); // Ctrl+N
		expect(appTakesKey(key("KeyB", { ctrl: true }), DEFAULT_BINDINGS, true)).toBe(true); // Ctrl+B (starts Ctrl+B+B, Ctrl+B+V)
	});
	test("on: plain and Shift-only keys and unbound combos still go to the shell", () => {
		expect(appTakesKey(key("KeyA"), DEFAULT_BINDINGS, true)).toBe(false);
		expect(appTakesKey(key("KeyA", { shift: true }), DEFAULT_BINDINGS, true)).toBe(false);
		expect(appTakesKey(key("KeyQ", { ctrl: true }), {}, true)).toBe(false);
	});
	test("nativeEdit keeps non-Shift OS cursor/delete keys in the terminal even when appKeysFirst is on", () => {
		const bindings = {
			...DEFAULT_BINDINGS,
			prevTab: "Mod+ArrowLeft",
			nextTab: "Mod+ArrowRight",
			navBack: "Alt+ArrowLeft",
			navForward: "Alt+ArrowRight",
			closeSession: "Mod+Backspace",
			prevRow: "Mod+Shift+ArrowLeft",
			findChat: "Mod+Home",
		};
		// macOS: Cmd+Arrow, Opt+Arrow, Cmd+Backspace stay in terminal when nativeEdit is on
		expect(appTakesKey(key("ArrowLeft", { meta: true }), bindings, true, true, true)).toBe(false);
		expect(appTakesKey(key("ArrowRight", { meta: true }), bindings, true, true, true)).toBe(false);
		expect(appTakesKey(key("ArrowLeft", { alt: true }), bindings, true, true, true)).toBe(false);
		expect(appTakesKey(key("Backspace", { meta: true }), bindings, true, true, true)).toBe(false);
		// macOS: nativeEdit off -> appKeysFirst takes them
		expect(appTakesKey(key("ArrowLeft", { meta: true }), bindings, true, false, true)).toBe(true);
		expect(appTakesKey(key("Backspace", { meta: true }), bindings, true, false, true)).toBe(true);
		// macOS: physical Ctrl+Arrow is NOT a macOS Cmd edit shortcut, so appKeysFirst still takes it
		expect(appTakesKey(key("ArrowLeft", { ctrl: true }), bindings, true, true, true)).toBe(true);
		// macOS: Shift variants and non-edit combos still go to the app
		expect(appTakesKey(key("ArrowLeft", { meta: true, shift: true }), bindings, true, true, true)).toBe(true);
		expect(appTakesKey(key("ArrowLeft", { meta: true, shift: true }), bindings, false, true, true)).toBe(true);
		expect(appTakesKey(key("KeyN", { meta: true }), bindings, true, true, true)).toBe(true);

		// Windows/Linux: Ctrl+Arrow, Ctrl+Home, Ctrl+Backspace stay in terminal when nativeEdit is on
		expect(appTakesKey(key("ArrowLeft", { ctrl: true }), bindings, true, true, false)).toBe(false);
		expect(appTakesKey(key("Home", { ctrl: true }), bindings, true, true, false)).toBe(false);
		expect(appTakesKey(key("Backspace", { ctrl: true }), bindings, true, true, false)).toBe(false);
		// Windows/Linux: nativeEdit off -> appKeysFirst takes them
		expect(appTakesKey(key("ArrowLeft", { ctrl: true }), bindings, true, false, false)).toBe(true);
		// Windows/Linux: Win/Meta+Arrow and Alt+Arrow are not Win/Linux edit shortcuts -> appKeysFirst takes them
		expect(appTakesKey(key("ArrowLeft", { meta: true }), bindings, true, true, false)).toBe(true);
		expect(appTakesKey(key("ArrowLeft", { alt: true }), bindings, true, true, false)).toBe(true);
		// Windows/Linux: Shift variant still goes to the app
		expect(appTakesKey(key("ArrowLeft", { ctrl: true, shift: true }), bindings, true, true, false)).toBe(true);
	});
});

describe("macOS native line/word editing in terminals", () => {
	const unix = { mac: true, nativeEdit: true, pty: true, alternate: false, platform: "linux" };
	const win = { mac: true, nativeEdit: true, pty: true, alternate: false, platform: "win32" };

	test("translates Cmd+Left/Right, Cmd+Backspace, and Opt+Left/Right in normal buffer", () => {
		expect(terminalEditAction(key("ArrowLeft", { meta: true }), unix)).toEqual({ kind: "send", data: "\x01" });
		expect(terminalEditAction(key("ArrowRight", { meta: true }), unix)).toEqual({ kind: "send", data: "\x05" });
		expect(terminalEditAction(key("Backspace", { meta: true }), unix)).toEqual({ kind: "send", data: "\x15" });
		expect(terminalEditAction(key("ArrowLeft", { alt: true }), unix)).toEqual({ kind: "send", data: "\x1bb" });
		expect(terminalEditAction(key("ArrowRight", { alt: true }), unix)).toEqual({ kind: "send", data: "\x1bf" });
		// Opt+Backspace stays with xterm (\x1b\x7f)
		expect(terminalEditAction(key("Backspace", { alt: true }), unix)).toBeNull();
		// Cmd+Up/Down are swallowed so the browser ignores them
		expect(terminalEditAction(key("ArrowUp", { meta: true }), unix)).toEqual({ kind: "swallow" });
		expect(terminalEditAction(key("ArrowDown", { meta: true }), unix)).toEqual({ kind: "swallow" });
	});

	test("uses Windows/PowerShell sequences when the server runs on win32", () => {
		expect(terminalEditAction(key("ArrowLeft", { meta: true }), win)).toEqual({ kind: "send", data: "\x1b[H" });
		expect(terminalEditAction(key("ArrowRight", { meta: true }), win)).toEqual({ kind: "send", data: "\x1b[F" });
		expect(terminalEditAction(key("Backspace", { meta: true }), win)).toEqual({ kind: "send", data: "\x1b[1;5H" });
		expect(terminalEditAction(key("ArrowLeft", { alt: true }), win)).toEqual({ kind: "send", data: "\x1b[1;5D" });
		expect(terminalEditAction(key("ArrowRight", { alt: true }), win)).toEqual({ kind: "send", data: "\x1b[1;5C" });
	});

	test("skips translation in alternate buffer, without pty, or when nativeEdit is off, while still swallowing Cmd+Arrow", () => {
		for (const opts of [
			{ ...unix, alternate: true },
			{ ...unix, pty: false },
			{ ...unix, nativeEdit: false },
		]) {
			expect(terminalEditAction(key("ArrowLeft", { meta: true }), opts)).toEqual({ kind: "swallow" });
			expect(terminalEditAction(key("ArrowRight", { meta: true }), opts)).toEqual({ kind: "swallow" });
			expect(terminalEditAction(key("Backspace", { meta: true }), opts)).toBeNull();
			expect(terminalEditAction(key("ArrowLeft", { alt: true }), opts)).toBeNull();
		}
	});

	test("ignores IME composition, Shift/Ctrl combinations, and non-macOS clients", () => {
		expect(terminalEditAction({ ...key("ArrowLeft", { meta: true }), isComposing: true }, unix)).toBeNull();
		expect(terminalEditAction(key("ArrowLeft", { meta: true, shift: true }), unix)).toBeNull();
		expect(terminalEditAction(key("ArrowLeft", { meta: true, ctrl: true }), unix)).toBeNull();
		expect(terminalEditAction(key("ArrowLeft", { meta: true, alt: true }), unix)).toBeNull();
		expect(terminalEditAction(key("ArrowLeft", { meta: true }), { ...unix, mac: false })).toBeNull();
		expect(terminalEditAction(key("ArrowLeft", { ctrl: true }), { ...unix, mac: false })).toBeNull();
	});
});

describe("copy and paste keys in a terminal", () => {
	test("Ctrl+C copies only with a selection", () => {
		expect(clipboardKey(key("KeyC", { ctrl: true }), true)).toBe("copy");
		expect(clipboardKey(key("KeyC", { ctrl: true }), false)).toBe(null); // interrupt
	});
	test("Ctrl+Shift+C always copies, Ctrl+V and Ctrl+Shift+V paste", () => {
		expect(clipboardKey(key("KeyC", { ctrl: true, shift: true }), false)).toBe("copy");
		expect(clipboardKey(key("KeyV", { ctrl: true }), false)).toBe("paste");
		expect(clipboardKey(key("KeyV", { ctrl: true, shift: true }), false)).toBe("paste");
	});
	test("Ctrl+Win+V (Windows clipboard history) pastes", () => {
		expect(clipboardKey(key("KeyV", { ctrl: true, meta: true }), false)).toBe("paste");
		expect(clipboardKey(key("KeyC", { ctrl: true, meta: true }), true)).toBe(null);
	});
	test("other keys are not clipboard keys", () => {
		expect(clipboardKey(key("KeyC"), true)).toBe(null);
		expect(clipboardKey(key("KeyV", { alt: true }), false)).toBe(null);
		expect(clipboardKey(key("KeyX", { ctrl: true }), true)).toBe(null);
	});
});

test("local echo over plain pipes", () => {
	expect(localEcho("ls\r")).toBe("ls\r\n");
	expect(localEcho("ab\x7f")).toBe("ab\b \b");
	expect(localEcho("\x1b[A")).toBe("[A");
});

describe("terminals in the sidebar", () => {
	const sessions = [sess("a", "/p/one", 5), sess("b", "/p/one", 7)];
	test("loose terminals are tabs of their directory; a directory with only a terminal is listed", () => {
		const dirs = sidebarDirs(sessions, [], [term("term_1", "/p/one"), term("term_2", "/p/two", 99)]);
		expect(dirs.map((d) => d.path)).toEqual(["/p/one", "/p/two"]);
		expect(dirs[0]!.tabs.map((t) => t.id)).toEqual(["a", "b", "term_1"]);
		expect(dirs[1]!.tabs.map((t) => t.kind)).toEqual(["terminal"]);
	});
	test("a terminal in a group is a pane of that group's tab only", () => {
		const groups = [{ id: "G", layout: pair("term_1", "b") } as Group];
		const dirs = sidebarDirs(sessions, groups, [term("term_1", "/p/one")]);
		expect(dirs[0]!.tabs.map((t) => t.id)).toEqual(["G", "a"]); // same age: groups first
		const g = dirs[0]!.tabs[0]!;
		expect(g.kind === "group" && g.members.map((m) => m.id)).toEqual(["term_1", "b"]);
		expect(sessionOrder(sessions, groups, [], [], [term("term_1", "/p/one")])).toEqual(["term_1", "b", "a"]);
	});
});
