import { describe, expect, test } from "bun:test";
import { pair, pane, paneToward, splitAt, type Layout } from "../src/lib/layout";
import { firstUnseen, sessionOrder, sidebarDirs, stepDir, stepFrom, tabOf } from "../src/lib/nav";
import { registerRenamePlace, renameNow } from "../src/lib/rename-places";
import { ACTIONS, DEFAULT_BINDINGS, MAX_KEYS, RENAME_KEY, actionFor, fixedActionFor, buildCombo, chordNext, hasLongerBinding, nextChord, emptyRecording, escapeShouldStop, escapeShouldUnzoom, renameShouldFallThrough, yieldsToTyping, OVERLAY_SELECTOR, keyCount, recordKey, recordingCombo, recordingIsEmpty, recordingLabel, undoRecording, type Recording } from "../src/lib/keys";
import type { Group, Session } from "../src/lib/types";

const sess = (id: string, cwd: string, updatedAt: number) => ({ id, cwd, updatedAt }) as Session;
const grp = (id: string, layout: Layout) => ({ id, layout }) as Group;

describe("paneToward", () => {
	// a | b
	const row = pair("a", "b");

	test("moves across a vertical divider", () => {
		expect(paneToward(row, "a", "right")).toBe("b");
		expect(paneToward(row, "b", "left")).toBe("a");
	});

	test("is null at the edge of the group", () => {
		expect(paneToward(row, "a", "left")).toBeNull();
		expect(paneToward(row, "b", "right")).toBeNull();
		expect(paneToward(row, "a", "top")).toBeNull();
		expect(paneToward(row, "a", "bottom")).toBeNull();
	});

	test("an unknown pane has no neighbour", () => {
		expect(paneToward(row, "zzz", "right")).toBeNull();
	});

	// a | b
	//     c      (c is under b)
	const l = splitAt(row, "b", "c", "bottom");

	test("goes up and down inside a column", () => {
		expect(paneToward(l, "b", "bottom")).toBe("c");
		expect(paneToward(l, "c", "top")).toBe("b");
	});

	test("a tall pane reaches the neighbour it faces", () => {
		expect(paneToward(l, "a", "right")).toBe("b"); // a spans both rows; b is the nearer-aligned one (top half centre)
		expect(paneToward(l, "c", "left")).toBe("a");
		expect(paneToward(l, "b", "left")).toBe("a");
	});

	test("does not jump to a pane that is not beside it", () => {
		// a | b over c: nothing is above a, and c is not to the right of a pane that does not overlap it vertically
		const stacked = splitAt(pane("a"), "a", "b", "bottom");
		expect(paneToward(stacked, "a", "right")).toBeNull();
		expect(paneToward(stacked, "a", "bottom")).toBe("b");
	});
});

describe("sessionOrder / stepFrom", () => {
	const sess = (id: string, cwd: string, createdAt: number) => ({ id, cwd, createdAt, updatedAt: 100 - createdAt }) as Session;
	const sessions = [sess("x", "/p/one", 5), sess("y", "/p/two", 9), sess("z", "/p/one", 7), sess("g1", "/p/three", 1), sess("g2", "/p/three", 2)];
	const groups = [grp("G", pair("g1", "g2"))];

	test("directories in the order they were opened; a group is a tab of the directory its panes work in", () => {
		// opened first: /p/three (1), then /p/one (5), then /p/two (9, newest, at the bottom)
		expect(sessionOrder(sessions, groups)).toEqual(["g1", "g2", "x", "z", "y"]);
	});

	test("hand-set directory and tab orders are followed", () => {
		const two = [...sessions, sess("h1", "/p/four", 3), sess("h2", "/p/four", 4)];
		const gs = [grp("G", pair("g1", "g2")), grp("H", pair("h1", "h2"))];
		expect(sessionOrder(two, gs)).toEqual(["g1", "g2", "h1", "h2", "x", "z", "y"]);
		// placed directories come before the ones not placed yet; tabs follow their hand-set order inside a directory
		expect(sessionOrder(two, gs, ["/p/one", "/p/two"], ["z", "x"])).toEqual(["z", "x", "y", "g1", "g2", "h1", "h2"]);
	});

	test("a pinned folder stays listed with no tabs, in its place", () => {
		const ss = [sess("a", "/p/one", 1), sess("b", "/p/two", 2)];
		const paths = (o: Parameters<typeof sidebarDirs>[3]) => sidebarDirs(ss, [], [], o).map((d) => d.path);
		expect(paths({ keep: ["/p/empty"] })).toEqual(["/p/one", "/p/two", "/p/empty"]);
		expect(paths({ keep: ["/p/empty"], dirOrder: ["/p/empty", "/p/one"] })).toEqual(["/p/empty", "/p/one", "/p/two"]);
		expect(sidebarDirs(ss, [], [], { keep: ["/p/one"] }).find((d) => d.path === "/p/one")!.tabs).toHaveLength(1);
		expect(sidebarDirs([], [], [], { keep: ["/p/empty"] })).toEqual([{ path: "/p/empty", tabs: [] }]);
	});

	test("a group stays in the folder it was first listed under while a pane still works there", () => {
		const ss = [sess("a", "/p/one", 1), sess("b", "/p/two", 2), sess("c", "/p/two", 3)];
		const g = [grp("G", pair("a", "b"))];
		const dirsOf = (gd?: Record<string, string>) => sidebarDirs(ss, g, [], { groupDir: gd }).map((d) => [d.path, d.tabs.map((t) => t.id)]);
		expect(dirsOf()).toEqual([["/p/one", ["G"]], ["/p/two", ["c"]]]);
		// by tie the first pane (/p/one) wins; pinned to /p/two it stays there
		expect(sidebarDirs(ss, g, [], { groupDir: { G: "/p/two" } }).map((d) => d.path)).toEqual(["/p/two"]);
		// the pinned folder is gone from the group: falls back to the majority
		expect(sidebarDirs(ss, g, [], { groupDir: { G: "/p/gone" } }).map((d) => d.path)).toEqual(["/p/one", "/p/two"]);
	});

	test("a pane whose session is gone is skipped", () => {
		expect(sessionOrder(sessions.filter((s) => s.id !== "g2"), groups)).toEqual(["g1", "x", "z", "y"]);
	});

	test("steps forward and back, wrapping at both ends", () => {
		const order = ["a", "b", "c"];
		expect(stepFrom(order, "a", 1)).toBe("b");
		expect(stepFrom(order, "c", 1)).toBe("a");
		expect(stepFrom(order, "a", -1)).toBe("c");
		expect(stepFrom(order, "b", -1)).toBe("a");
	});

	test("from a new chat, forward starts at the first and back at the last", () => {
		expect(stepFrom(["a", "b", "c"], null, 1)).toBe("a");
		expect(stepFrom(["a", "b", "c"], null, -1)).toBe("c");
		expect(stepFrom(["a", "b", "c"], "gone", 1)).toBe("a");
	});

	test("nothing to step to in an empty list", () => {
		expect(stepFrom([], null, 1)).toBeNull();
	});
});

describe("shortcut catalogue", () => {
	test("ids are unique", () => {
		const ids = ACTIONS.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every action has a label and a default entry", () => {
		for (const a of ACTIONS) {
			expect(a.label.length).toBeGreaterThan(0);
			expect(a.id in DEFAULT_BINDINGS).toBe(true);
		}
	});

	test("default combos do not collide", () => {
		const bound = ACTIONS.map((a) => a.default).filter(Boolean);
		expect(new Set(bound).size).toBe(bound.length);
	});

	test("default combos stay within the key limit", () => {
		for (const a of ACTIONS) expect(keyCount(a.default)).toBeLessThanOrEqual(MAX_KEYS);
	});

	test("modifiers do not count against the three-key limit", () => {
		const all = { mod: true, alt: true, shift: true };
		expect(buildCombo(all, ["K"])).toBe("Mod+Alt+Shift+K");
		expect(keyCount(buildCombo(all, ["L", "J", "K"]))).toBe(3);
		expect(buildCombo({ mod: true, alt: false, shift: false }, ["L", "J", "K"])).toBe("Mod+L+J+K"); // order pressed is kept
		expect(keyCount(buildCombo(all, ["A", "B", "C", "D"]))).toBe(4); // one too many: rejected by the recorder and the handler
	});

	test("a new chat and starting over are two actions", () => {
		const by = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));
		expect(by.newChat.default).toBe("Mod+N");
		expect(by.clearChat.default).toBe("Mod+Shift+N");
		expect(by.clearChat.fixed).toBeUndefined(); // rebindable like the rest
		expect(by.newChat.group).toBe("general");
		expect(by.clearChat.group).toBe("general");
	});

	test("stopping the agent is fixed to Esc", () => {
		const stop = ACTIONS.find((a) => a.id === "stop")!;
		expect(stop.default).toBe("Escape");
		expect(stop.fixed).toBe(true);
		expect(ACTIONS.filter((a) => a.id !== "stop" && a.default === "Escape")).toEqual([]);
		expect(ACTIONS.filter((a) => a.fixed).map((a) => a.id)).toEqual(["renameTab", "stop", "steer"]);
	});

	test("renaming is fixed to F2, shown in Settings, and no other action can take it", () => {
		const rename = ACTIONS.find((a) => a.id === "renameTab")!;
		expect(rename.default).toBe(RENAME_KEY);
		expect(rename.fixed).toBe(true);
		expect(ACTIONS.filter((a) => a.id !== "renameTab" && a.default === RENAME_KEY)).toEqual([]);
		expect(fixedActionFor("F2")).toBe("renameTab");
		expect(fixedActionFor("Escape")).toBe("stop");
		expect(fixedActionFor("Mod+B")).toBeUndefined();
		expect(fixedActionFor("")).toBeUndefined();
	});

	test("steering is fixed to Enter; queueing is rebindable (Alt+Enter by default)", () => {
		const steer = ACTIONS.find((a) => a.id === "steer")!;
		expect(steer.default).toBe("Enter");
		expect(steer.fixed).toBe(true);
		const queue = ACTIONS.find((a) => a.id === "queueMessage")!;
		expect(queue.default).toBe("Alt+Enter");
		expect(queue.fixed).toBeUndefined();
	});

	test("Esc stops the agent only when nothing else is using it", () => {
		const composer = { tagName: "TEXTAREA", dataset: { composer: "" } };
		const base = { busy: true, overlayOpen: false, target: composer };
		expect(escapeShouldStop(base)).toBe(true);
		expect(escapeShouldStop({ ...base, target: { tagName: "BODY" } })).toBe(true);
		expect(escapeShouldStop({ ...base, target: null })).toBe(true);
		expect(escapeShouldStop({ ...base, busy: false })).toBe(false); // nothing running
		expect(escapeShouldStop({ ...base, overlayOpen: true })).toBe(false); // Esc closes the dialog instead
		expect(escapeShouldStop({ ...base, target: { tagName: "INPUT" } })).toBe(false); // rename field, search box
		expect(escapeShouldStop({ ...base, target: { tagName: "TEXTAREA", dataset: {} } })).toBe(false);
		expect(escapeShouldStop({ ...base, target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
	});

	test("F2 renames the open conversation when a click left focus on the body (macOS webviews do not focus a button)", () => {
		const base = { key: "F2", defaultPrevented: false, repeat: false, mod: false, target: { tagName: "BODY" }, inTerminal: false, overlayOpen: false, recording: false, renaming: false };
		expect(renameShouldFallThrough(base)).toBe(true);
		expect(renameShouldFallThrough({ ...base, target: null })).toBe(true);
		expect(renameShouldFallThrough({ ...base, key: "F3" })).toBe(false);
		expect(renameShouldFallThrough({ ...base, defaultPrevented: true })).toBe(false); // a row took it
		expect(renameShouldFallThrough({ ...base, repeat: true })).toBe(false);
		expect(renameShouldFallThrough({ ...base, mod: true })).toBe(false); // Shift+F2 and friends are not rename
		expect(renameShouldFallThrough({ ...base, inTerminal: true })).toBe(false); // the shell gets F2
		expect(renameShouldFallThrough({ ...base, overlayOpen: true })).toBe(false); // a dialog or menu is open
		expect(renameShouldFallThrough({ ...base, recording: true })).toBe(false); // recording a shortcut in Settings
		expect(renameShouldFallThrough({ ...base, renaming: true })).toBe(false); // already renaming
		expect(renameShouldFallThrough({ ...base, target: { tagName: "INPUT" } })).toBe(false);
		expect(renameShouldFallThrough({ ...base, target: { tagName: "TEXTAREA" } })).toBe(false);
		expect(renameShouldFallThrough({ ...base, target: { tagName: "TEXTAREA", dataset: { composer: "" } } })).toBe(true); // the composer takes focus on a switch
		expect(renameShouldFallThrough({ ...base, target: { tagName: "SELECT" } })).toBe(false);
		expect(renameShouldFallThrough({ ...base, target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
	});

	test("Esc shrinks the zoomed pane only when nothing else uses it", () => {
		expect(escapeShouldUnzoom({ overlayOpen: false, target: { tagName: "BODY" } })).toBe(true);
		expect(escapeShouldUnzoom({ overlayOpen: false, target: { tagName: "TEXTAREA", dataset: { composer: "" } } })).toBe(true); // the input box
		expect(escapeShouldUnzoom({ overlayOpen: true, target: { tagName: "BODY" } })).toBe(false); // a menu closes first
		expect(escapeShouldUnzoom({ overlayOpen: false, target: { tagName: "INPUT" } })).toBe(false); // a rename field cancels
	});
	test("an open context menu counts as an overlay: its Esc closes it, not the zoomed pane or the agent", () => {
		expect(OVERLAY_SELECTOR).toContain('[role="menu"]');
		expect(OVERLAY_SELECTOR).toContain('[role="dialog"]');
	});
});

describe("settings navigation", () => {
	test("roving keys follow the axis of the list", async () => {
		const { axisKey } = await import("../src/lib/roving");
		// a vertical list: up/down move, left/right do nothing
		expect(axisKey("ArrowDown", "y")).toBe("ArrowRight");
		expect(axisKey("ArrowUp", "y")).toBe("ArrowLeft");
		expect(axisKey("ArrowRight", "y")).toBe("");
		// a row: unchanged
		expect(axisKey("ArrowRight", "x")).toBe("ArrowRight");
		expect(axisKey("ArrowDown", "x")).toBe("ArrowDown");
		// both (a column that becomes a row on a phone)
		expect(axisKey("ArrowDown", "both")).toBe("ArrowRight");
		expect(axisKey("ArrowLeft", "both")).toBe("ArrowLeft");
		expect(axisKey("Home", "y")).toBe("Home");
	});

	test("settings pieces compile", async () => {
		const { compile } = await import("svelte/compiler");
		for (const f of ["settings/Settings", "server/ServerForm", "ui/Switch", "ui/Accordion", "extensions/Extensions", "settings/Shortcuts"]) {
			const source = await Bun.file(`src/components/${f}.svelte`).text();
			expect(() => compile(source, { filename: `${f}.svelte`, generate: "client" }), f).not.toThrow();
		}
	});
});

describe("recording a shortcut key by key", () => {
	const ev = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
	const press = (r: Recording, ...events: ReturnType<typeof ev>[]) => events.reduce((acc, e) => recordKey(acc, e).next, r);

	test("keys pile up in the order they were pressed, even when released in between", () => {
		const r = press(emptyRecording(), ev("KeyJ"), ev("KeyK"), ev("KeyL"));
		expect(r.keys).toEqual(["J", "K", "L"]);
		expect(recordingLabel(r)).toBe("J+K+L");
		expect(recordingCombo(r)).toBe("J+K+L");
		expect(recordingCombo(press(emptyRecording(), ev("KeyL"), ev("KeyJ")))).toBe("L+J"); // saved in the order pressed
	});
	test("modifiers are kept on the way and shown first", () => {
		const r = press(emptyRecording(), ev("ControlLeft", { ctrlKey: true }), ev("ShiftLeft", { ctrlKey: true, shiftKey: true }), ev("KeyK", { ctrlKey: true, shiftKey: true }));
		expect(recordingCombo(r)).toBe("Mod+Shift+K");
		expect(r.keys).toEqual(["K"]);
	});
	test("a modifier let go before the next key still counts (it was part of what the user built)", () => {
		const r = press(emptyRecording(), ev("AltLeft", { altKey: true }), ev("KeyA"));
		expect(recordingCombo(r)).toBe("Alt+A");
	});
	test("a fourth plain key is refused and leaves the recording as it was", () => {
		const three = press(emptyRecording(), ev("KeyA"), ev("KeyB"), ev("KeyC"));
		const out = recordKey(three, ev("KeyD"));
		expect(out.rejected).toBe(true);
		expect(out.next).toBe(three);
		expect(recordKey(three, ev("KeyB")).rejected).toBe(true); // a repeat is a fourth press too
	});
	test("the same key twice is recorded twice: Ctrl+B+B", () => {
		const r = press({ ...emptyRecording(), mod: true }, ev("KeyB"), ev("KeyB"));
		expect(r.keys).toEqual(["B", "B"]);
		expect(recordingCombo(r)).toBe("Mod+B+B");
	});
	test("digits and numpad keys use the same names as the app's handler", () => {
		expect(press(emptyRecording(), ev("Digit1"), ev("Period")).keys).toEqual(["1", "Period"]);
	});
	test("Backspace removes the last key, then the modifiers", () => {
		let r = press(emptyRecording(), ev("ControlLeft", { ctrlKey: true }), ev("KeyA", { ctrlKey: true }), ev("KeyB", { ctrlKey: true }));
		r = undoRecording(r);
		expect(recordingCombo(r)).toBe("Mod+A");
		r = undoRecording(undoRecording(r));
		expect(recordingIsEmpty(r)).toBe(true);
	});
	test("modifiers alone make no shortcut", () => {
		const r = press(emptyRecording(), ev("ControlLeft", { ctrlKey: true }));
		expect(r.keys).toEqual([]);
		expect(recordingIsEmpty(r)).toBe(false);
	});
});

describe("shortcut combinations", () => {
	test("two plain keys, with or without a modifier, make distinct saved combos", () => {
		const none = { mod: false, alt: false, shift: false };
		expect(buildCombo(none, ["B", "A"])).toBe("B+A");
		expect(buildCombo({ ...none, mod: true }, ["B", "A"])).toBe("Mod+B+A");
		expect(buildCombo({ ...none, mod: true, shift: true }, ["C", "A", "B"])).toBe("Mod+Shift+C+A+B");
	});

	const none = { mod: false, alt: false, shift: false };
	const key = (code: string, o: Partial<typeof none> = {}) => ({ code, ctrlKey: !!o.mod, metaKey: false, altKey: !!o.alt, shiftKey: !!o.shift });
	const bound = { toggleSidebar: "Mod+B", newChat: "Mod+B+C", retry: "Mod+B+D", workdir: "Alt+N" };
	const prefix = { ...none, mod: true, keys: ["B"] };

	test("Ctrl+B then C completes Mod+B+C, with no time limit and without Ctrl still held", () => {
		expect(nextChord(prefix, key("KeyC"), bound)).toEqual({ kind: "run", id: "newChat" });
	});
	test("a key that leads nowhere ends the chord and runs nothing", () => {
		expect(nextChord(prefix, key("KeyX"), bound)).toEqual({ kind: "none", combo: "Mod+B+X" });
	});
	test("Ctrl+B then B completes Mod+B+B, and the plain Mod+B waits for it", () => {
		const twice = { toggleSidebar: "Mod+B", newChat: "Mod+B+B" };
		expect(hasLongerBinding("Mod+B", twice)).toBe(true);
		expect(hasLongerBinding("Mod+B+B", twice)).toBe(false);
		expect(nextChord(prefix, key("KeyB"), twice)).toEqual({ kind: "run", id: "newChat" });
		expect(chordNext(prefix, twice).map((n) => n.rest)).toEqual(["B"]);
	});
	test("Ctrl+B waits when only Ctrl+B+B and Ctrl+B+C are bound, and Ctrl+B itself is unbound", () => {
		const longOnly = { newChat: "Mod+B+B", retry: "Mod+B+C" };
		expect(actionFor("Mod+B", longOnly)).toBeUndefined();
		expect(hasLongerBinding("Mod+B", longOnly)).toBe(true);
		expect(nextChord(prefix, key("KeyB"), longOnly)).toEqual({ kind: "run", id: "newChat" });
		expect(nextChord(prefix, key("KeyC"), longOnly)).toEqual({ kind: "run", id: "retry" });
		expect(chordNext(prefix, longOnly).map((n) => n.rest).sort()).toEqual(["B", "C"]);
	});
	test("B+B is not B+C: a repeated key only matches a binding that has it twice", () => {
		expect(hasLongerBinding("Mod+B", { a: "Mod+B+C" })).toBe(true);
		expect(hasLongerBinding("Mod+B+B", { a: "Mod+B+C" })).toBe(false);
		expect(nextChord(prefix, key("KeyB"), { toggleSidebar: "Mod+B", newChat: "Mod+B+C" })).toEqual({ kind: "none", combo: "Mod+B+B" });
	});
	test("a chord can keep waiting while a longer one is still possible", () => {
		const longer = { toggleSidebar: "Mod+B", newChat: "Mod+B+C", retry: "Mod+B+C+D" };
		expect(nextChord(prefix, key("KeyC"), longer)).toEqual({ kind: "wait", prefix: { ...prefix, keys: ["B", "C"] } });
	});
	test("lists what can follow a waiting chord", () => {
		expect(chordNext(prefix, bound).map((n) => n.rest).sort()).toEqual(["C", "D"]);
		expect(chordNext({ ...none, alt: true, keys: ["N"] }, bound)).toEqual([]);
	});
	test("a shortcut that starts a longer one is told apart, so it can wait for the next key", () => {
		const b = { a: "Mod+B", b: "Mod+B+C", c: "Alt+B+C", d: "" };
		expect(hasLongerBinding("Mod+B", b)).toBe(true);
		expect(hasLongerBinding("Mod+B+C", b)).toBe(false);
		expect(hasLongerBinding("Alt+B", b)).toBe(true);
		expect(hasLongerBinding("Shift+B", b)).toBe(false); // other modifiers: not a prefix
		expect(hasLongerBinding("Mod+C", b)).toBe(false); // C is only the second key of Mod+B+C: Ctrl+C alone starts nothing
	});
	test("Ctrl+V alone does not start Ctrl+B+V; only the first key is a prefix", () => {
		const b = { toggleSidebar: "Mod+B", newChat: "Mod+B+V" };
		expect(hasLongerBinding("Mod+V", b)).toBe(false);
		expect(hasLongerBinding("Mod+B", b)).toBe(true);
		expect(nextChord(prefix, key("KeyV"), b)).toEqual({ kind: "run", id: "newChat" });
	});
	test("keys held together match in any order, chords only in the order pressed", () => {
		const b = { newChat: "J+K+L", retry: "Mod+B+V" };
		expect(actionFor("L+J+K", b, true)).toBe("newChat");
		expect(actionFor("Mod+V+B", b, false)).toBeUndefined();
		expect(actionFor("Mod+B+V", b)).toBe("retry");
	});
});

describe("firstUnseen", () => {
	const order = ["a", "b", "c", "d"];
	test("takes the topmost marked session and walks down as marks clear", () => {
		const marks = new Set(["b", "d"]);
		expect(firstUnseen(order, (id) => marks.has(id), "a")).toBe("b");
		marks.delete("b");
		expect(firstUnseen(order, (id) => marks.has(id), "b")).toBe("d");
	});
	test("skips the open session and returns null when nothing is marked", () => {
		expect(firstUnseen(order, (id) => id === "a", "a")).toBeNull();
		expect(firstUnseen(order, () => false, null)).toBeNull();
		expect(firstUnseen(order, (id) => id === "c", null)).toBe("c");
	});
});

describe("hand-ordered tabs", () => {
	const all = [sess("a", "/p", 3), sess("b", "/p", 2), sess("c", "/p", 1)];
	test("a placed order wins inside a directory, and prev/next follows it", () => {
		expect(sessionOrder(all, [], [], [], [])).toEqual(["a", "b", "c"]);
		expect(sessionOrder(all, [], [], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
	});
	test("tabs not placed yet come after the placed ones, like a new editor tab", () => {
		expect(sessionOrder(all, [], [], ["c", "b"])).toEqual(["c", "b", "a"]);
	});
});

describe("sidebarDirs / tabOf", () => {
	const sessions = [sess("a", "/w", 1), sess("b", "/w", 2), sess("c", "/x", 3), sess("d", "/w", 4)];
	test("a group lands in the directory most of its panes work in", () => {
		const dirs = sidebarDirs(sessions, [grp("G", pair("c", "b"))]);
		// two dirs: /w holds a, d and the group (b in /w, c in /x: a tie goes to the first pane, c -> /x)
		expect(dirs.find((d) => d.path === "/x")!.tabs.map((t) => t.id)).toEqual(["G"]);
		const three = sidebarDirs(sessions, [grp("G", splitAt(pair("c", "b"), "b", "d", "right"))]);
		// same age: groups first
		expect(three.find((d) => d.path === "/w")!.tabs.map((t) => t.id)).toEqual(["G", "a"]);
	});
	test("tabOf finds the tab of a pane or of a group id", () => {
		const dirs = sidebarDirs(sessions, [grp("G", pair("a", "b"))]);
		expect(tabOf(dirs, "b")?.tab.id).toBe("G");
		expect(tabOf(dirs, "G")?.dir.path).toBe("/w");
		expect(tabOf(dirs, "d")?.tab.kind).toBe("session");
		expect(tabOf(dirs, "zz")).toBeNull();
	});
	test("search keeps a group with a matching member, showing only that member", () => {
		const dirs = sidebarDirs(sessions, [grp("G", pair("a", "b"))], [], { match: (s) => s.id === "b" });
		const g = dirs[0]!.tabs[0]!;
		expect(g.kind === "group" && g.members.map((m) => m.id)).toEqual(["b"]);
	});
});

describe("stepDir", () => {
	const dirs = sidebarDirs([sess("a", "/x", 3), sess("b", "/x", 2), sess("c", "/y", 1)], [], [], { dirOrder: ["/x", "/y"] });

	test("jumps to the first pane of the next / previous folder, wrapping", () => {
		expect(stepDir(dirs, "b", 1)).toBe("c");
		expect(stepDir(dirs, "c", 1)).toBe("a");
		expect(stepDir(dirs, "a", -1)).toBe("c");
	});

	test("from a new chat, forward starts at the first folder, back at the last", () => {
		expect(stepDir(dirs, null, 1)).toBe("a");
		expect(stepDir(dirs, null, -1)).toBe("c");
	});

	test("nothing to step through", () => {
		expect(stepDir([], "a", 1)).toBeNull();
	});
});

describe("F2 renames the open thing", () => {
	test("the sidebar row wins while it shows; the header title takes it when the sidebar has nothing", () => {
		const made: string[] = [];
		const offTitle = registerRenamePlace({ order: 1, open: () => ({ id: "s1", title: "one" }), start: (id, title) => made.push(`title:${id}:${title}`) });
		const offEmptyRow = registerRenamePlace({ order: 0, open: () => null, start: (id, title) => made.push(`row:${id}:${title}`) });
		let now = renameNow();
		expect(now?.target).toEqual({ id: "s1", title: "one" });
		now?.place.start(now.target.id, now.target.title);
		expect(made).toEqual(["title:s1:one"]);
		offEmptyRow();
		const offRow = registerRenamePlace({ order: 0, open: () => ({ id: "g1", title: "grp" }), start: (id, title) => made.push(`row:${id}:${title}`) });
		now = renameNow();
		expect(now?.target).toEqual({ id: "g1", title: "grp" });
		offRow();
		offTitle();
		expect(renameNow()).toBeUndefined();
	});

	test("a click picks the place it landed in, and an empty one falls back to the order", () => {
		const place = (order: number, zone: string | undefined, title: string) => ({
			order,
			zone,
			open: () => (title ? { id: `id${order}`, title } : null),
			start: () => {},
		});
		const click = (zone: string) => ({ closest: (sel: string) => (sel === zone ? {} : null) }) as unknown as Element;
		const offRow = registerRenamePlace(place(0, '[data-part="sidebar"]', "row"));
		const offStrip = registerRenamePlace(place(1, '[data-part="tabbar"]', "tab"));
		const offPane = registerRenamePlace(place(3, '[data-pane="s1"]', "")); // a pane with nothing to rename
		expect(renameNow(click('[data-part="tabbar"]'))?.target.title).toBe("tab");
		expect(renameNow(click('[data-pane="s1"]'))?.target.title).toBe("row"); // an empty place lets the order decide
		expect(renameNow(click("[data-part=dialog]"))?.target.title).toBe("row");
		expect(renameNow()?.target.title).toBe("row");
		offPane();
		offStrip();
		offRow();
		expect(renameNow()).toBeUndefined();
	});
});

describe("shortcuts in a text field", () => {
	test("a bare key stays typing, a modified one fires", () => {
		expect(yieldsToTyping("newChat", "J")).toBe(true);
		expect(yieldsToTyping("newChat", "Mod+J")).toBe(false);
		expect(yieldsToTyping(null, "J")).toBe(true);
	});

	test("voice input fires from a field: a transcription leaves the caret in the composer", () => {
		expect(yieldsToTyping("voiceInput", "J")).toBe(false);
		expect(yieldsToTyping("voiceInput", "Shift+Space")).toBe(false);
		expect(yieldsToTyping("voiceInput", "Mod+Shift+V")).toBe(false);
	});
});
