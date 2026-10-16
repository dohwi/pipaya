import { describe, expect, test } from "bun:test";
import { pair } from "../src/lib/layout";
import { sessionOrder, sidebarBlocks } from "../src/lib/nav";
import { DEFAULT_BINDINGS } from "../src/lib/keys";
import { PROTOCOL_VERSION } from "../src/lib/protocol";
import { appTakesKey, isTerminalId, localEcho, platformName, terminalSocketUrl, type TerminalInfo } from "../src/lib/terminal";
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

test("local echo over plain pipes", () => {
	expect(localEcho("ls\r")).toBe("ls\r\n");
	expect(localEcho("ab\x7f")).toBe("ab\b \b");
	expect(localEcho("\x1b[A")).toBe("[A");
});

describe("terminals in the sidebar", () => {
	const sessions = [sess("a", "/p/one", 5), sess("b", "/p/one", 7)];
	test("loose terminals sit in their directory; a directory with only a terminal is listed", () => {
		const { dirs } = sidebarBlocks(sessions, [], undefined, undefined, [], [], [term("term_1", "/p/one"), term("term_2", "/p/two", 99)]);
		expect(dirs.map((d) => d.path)).toEqual(["/p/two", "/p/one"]);
		expect(dirs[1]!.terminals.map((t) => t.id)).toEqual(["term_1"]);
		expect(dirs[0]!.sessions).toEqual([]);
	});
	test("a terminal in a group is listed there only, and walked after the group's chats", () => {
		const groups = [{ id: "G", layout: pair("term_1", "b") } as Group];
		const { dirs, groups: gs } = sidebarBlocks(sessions, groups, undefined, undefined, [], [], [term("term_1", "/p/one")]);
		expect(dirs[0]!.terminals).toEqual([]);
		expect(gs[0]!.terminals.map((t) => t.id)).toEqual(["term_1"]);
		expect(sessionOrder(sessions, groups, [], [], [term("term_1", "/p/one")])).toEqual(["a", "b", "term_1"]);
	});
});
