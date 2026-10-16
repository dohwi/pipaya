import { describe, expect, test } from "bun:test";
import { pair, pane, paneToward, splitAt, type Layout } from "../src/lib/layout";
import { firstUnseen, sessionOrder, stepFrom } from "../src/lib/nav";
import { ACTIONS, DEFAULT_BINDINGS, MAX_KEYS, actionFor, buildCombo, chordNext, hasLongerBinding, nextChord, emptyRecording, escapeShouldStop, keyCount, recordKey, recordingCombo, recordingIsEmpty, recordingLabel, undoRecording, type Recording } from "../src/lib/keys";
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
	const sessions = [sess("x", "/p/one", 5), sess("y", "/p/two", 9), sess("z", "/p/one", 7), sess("g1", "/p/three", 1), sess("g2", "/p/three", 2)];
	const groups = [grp("G", pair("g1", "g2"))];

	test("directories by recency come first, groups last", () => {
		// /p/two (9) is the newest, then /p/one (7 via z)
		expect(sessionOrder(sessions, groups)).toEqual(["y", "x", "z", "g1", "g2"]);
	});

	test("hand-set directory and group orders are followed", () => {
		const two = [...sessions, sess("h1", "/p/four", 3), sess("h2", "/p/four", 4)];
		const gs = [grp("G", pair("g1", "g2")), grp("H", pair("h1", "h2"))];
		// default: groups in creation order, below the directories
		expect(sessionOrder(two, gs)).toEqual(["y", "x", "z", "g1", "g2", "h1", "h2"]);
		expect(sessionOrder(two, gs, ["/p/one", "/p/two"], [gs[1]!.id, gs[0]!.id])).toEqual(["x", "z", "y", "h1", "h2", "g1", "g2"]);
	});

	test("a pane whose session is gone is skipped", () => {
		expect(sessionOrder(sessions.filter((s) => s.id !== "g2"), groups)).toEqual(["y", "x", "z", "g1"]);
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

	test("stopping the agent is fixed to Esc", () => {
		const stop = ACTIONS.find((a) => a.id === "stop")!;
		expect(stop.default).toBe("Escape");
		expect(stop.fixed).toBe(true);
		expect(ACTIONS.filter((a) => a.id !== "stop" && a.default === "Escape")).toEqual([]);
		expect(ACTIONS.filter((a) => a.fixed).map((a) => a.id)).toEqual(["stop", "steer"]);
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
		for (const f of ["Settings", "ServerForm", "Switch", "Accordion", "Extensions", "Shortcuts"]) {
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

describe("hand-ordered sessions", () => {
	const all = [sess("a", "/p", 3), sess("b", "/p", 2), sess("c", "/p", 1)];
	test("a placed order wins inside a directory, and prev/next follows it", () => {
		expect(sessionOrder(all, [], [], [], [], [])).toEqual(["a", "b", "c"]);
		expect(sessionOrder(all, [], [], [], [], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
	});
	test("sessions not placed yet come first", () => {
		expect(sessionOrder(all, [], [], [], [], ["c", "b"])).toEqual(["a", "c", "b"]);
	});
});
