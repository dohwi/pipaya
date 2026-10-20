import { describe, expect, test } from "bun:test";
import { pair } from "../src/lib/layout";
import { sessionOrder, sidebarDirs } from "../src/lib/nav";
import { DEFAULT_BINDINGS } from "../src/lib/keys";
import { PROTOCOL_VERSION } from "../src/lib/protocol";
import { appTakesKey, clipboardKey, isTerminalId, localEcho, platformName, terminalSocketUrl, type TerminalInfo } from "../src/lib/terminal";
import type { Group, Session } from "../src/lib/types";

const sess = (id: string, cwd: string, updatedAt: number) => ({ id, cwd, updatedAt, title: id }) as Session;
const term = (id: string, cwd: string, createdAt = 0) => ({ id, cwd, createdAt, title: id }) as TerminalInfo;
const key = (code: string, m: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({ code, ctrlKey: !!m.ctrl, metaKey: false, altKey: !!m.alt, shiftKey: !!m.shift });

describe("terminal ids and urls", () => {
	test("terminal ids are told apart by their prefix", () => {
		expect(isTerminalId("term_123")).toBe(true);
		expect(isTerminalId("abc")).toBe(false);
		expect(isTerminalId(null)).toBe(false);
	});
	test("the socket url swaps the scheme and carries the token", () => {
		expect(terminalSocketUrl("https://h:1", "a b", "term_x")).toBe(`wss://h:1/terminals/term_x/ws?protocol=${PROTOCOL_VERSION}&token=a%20b`);
		expect(terminalSocketUrl("http://h", "t", "x").startsWith("ws://h/")).toBe(true);
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
		expect(appTakesKey(key("Backquote", { ctrl: true, shift: true }), DEFAULT_BINDINGS)).toBe(true);
		expect(appTakesKey(key("KeyZ", { ctrl: true, shift: true }), DEFAULT_BINDINGS)).toBe(false); // unbound
	});
});

describe("app shortcuts first in a terminal", () => {
	test("off by default: Ctrl+B and Alt+N stay with the shell", () => {
		expect(appTakesKey(key("KeyB", { ctrl: true }), DEFAULT_BINDINGS, false)).toBe(false);
		expect(appTakesKey(key("KeyN", { alt: true }), DEFAULT_BINDINGS, false)).toBe(false);
	});
	test("on: bound Ctrl/Alt combos and chord starts go to the app", () => {
		expect(appTakesKey(key("KeyN", { alt: true }), DEFAULT_BINDINGS, true)).toBe(true); // Alt+N
		expect(appTakesKey(key("KeyB", { ctrl: true }), DEFAULT_BINDINGS, true)).toBe(true); // Ctrl+B (also starts Ctrl+B+V)
	});
	test("on: plain and Shift-only keys and unbound combos still go to the shell", () => {
		expect(appTakesKey(key("KeyA"), DEFAULT_BINDINGS, true)).toBe(false);
		expect(appTakesKey(key("KeyA", { shift: true }), DEFAULT_BINDINGS, true)).toBe(false);
		expect(appTakesKey(key("KeyQ", { ctrl: true }), {}, true)).toBe(false);
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
