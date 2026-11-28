import { describe, expect, test } from "bun:test";
import { Ime } from "../src/lib/composer/ime";
import { edgeNavKey, enterPlan, hangulCommit, historyKey, lastPromptOf, menuAria, sentPrompts } from "../src/lib/composer/input-keys";

const plan = (o: Partial<Parameters<typeof enterPlan>[0]> = {}) => enterPlan({ running: false, combo: "Enter", queueCombo: "Alt+Enter", shift: false, isCommand: false, ...o });

describe("enterPlan", () => {
	test("idle Enter sends, running Enter steers", () => {
		expect(plan()).toBe("send");
		expect(plan({ running: true })).toBe("steer");
	});
	test("the queue shortcut queues only mid-run", () => {
		expect(plan({ running: true, combo: "Alt+Enter" })).toBe("queue");
		expect(plan({ running: false, combo: "Alt+Enter" })).toBe("send");
		expect(plan({ running: true, combo: "Alt+Enter", queueCombo: undefined })).toBe("steer");
	});
	test("Shift+Enter is a newline, even for a command", () => {
		expect(plan({ shift: true })).toBe("newline");
		expect(plan({ shift: true, isCommand: true })).toBe("newline");
	});
	test("known commands run locally, mid-run too; non-commands send or steer", () => {
		expect(plan({ isCommand: true, running: false })).toBe("command");
		expect(plan({ isCommand: true, running: true })).toBe("command");
		expect(plan({ isCommand: false, running: false })).toBe("send");
		expect(plan({ isCommand: false, running: true })).toBe("steer");
	});
	test("the queue shortcut wins over a command while running", () => {
		expect(plan({ running: true, combo: "Alt+Enter", isCommand: true })).toBe("queue");
	});
});

describe("hangulCommit", () => {
	test("Hangul commits send, kana and kanji keep their two presses", () => {
		expect(hangulCommit("녕")).toBe(true);
		expect(hangulCommit("ㅎ")).toBe(true);
		expect(hangulCommit("ᄀ")).toBe(true);
		expect(hangulCommit("かな")).toBe(false);
		expect(hangulCommit("你好")).toBe(false);
		expect(hangulCommit("")).toBe(false);
		expect(hangulCommit(null)).toBe(false);
		expect(hangulCommit(undefined)).toBe(false);
	});
});

describe("Ime", () => {
	test("an Enter during composition is acted on after a Hangul commit, once", () => {
		const ime = new Ime();
		ime.start();
		expect(ime.composing).toBe(true);
		ime.deferEnter("Enter");
		expect(ime.end("녕")).toBe("Enter");
		expect(ime.composing).toBe(false);
		expect(ime.end("녕")).toBeNull();
	});
	test("no Enter, or a non-Hangul commit, acts on nothing (and forgets the Enter)", () => {
		const ime = new Ime();
		ime.start();
		expect(ime.end("녕")).toBeNull();
		ime.start();
		ime.deferEnter("Enter");
		expect(ime.end("日本")).toBeNull();
		expect(ime.end("녕")).toBeNull();
	});
});

describe("historyKey", () => {
	const key = (o: object = {}) => ({ key: "ArrowUp", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...o });
	test("plain arrows with a collapsed selection", () => {
		expect(historyKey(key(), false, true)).toBe(true);
		expect(historyKey(key({ key: "ArrowDown" }), false, true)).toBe(true);
	});
	test("modifiers, IME, a selection or another key are not history", () => {
		for (const o of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }, { key: "Enter" }]) expect(historyKey(key(o), false, true)).toBe(false);
		expect(historyKey(key(), true, true)).toBe(false);
		expect(historyKey(key(), false, false)).toBe(false);
	});
});

describe("edgeNavKey", () => {
	const key = (o: object = {}) => ({ key: "End", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...o });

	test("Home/End map to visual line edges on both platforms (with optional Shift)", () => {
		expect(edgeNavKey(key({ key: "Home" }), false, false)).toEqual({ target: "line-start", extend: false });
		expect(edgeNavKey(key({ key: "End" }), false, false)).toEqual({ target: "line-end", extend: false });
		expect(edgeNavKey(key({ key: "Home", shiftKey: true }), false, false)).toEqual({ target: "line-start", extend: true });
		expect(edgeNavKey(key({ key: "End", shiftKey: true }), false, true)).toEqual({ target: "line-end", extend: true });
	});

	test("Ctrl+Home/End map to document edges only on non-Mac", () => {
		expect(edgeNavKey(key({ key: "Home", ctrlKey: true }), false, false)).toEqual({ target: "doc-start", extend: false });
		expect(edgeNavKey(key({ key: "End", ctrlKey: true, shiftKey: true }), false, false)).toEqual({ target: "doc-end", extend: true });
		expect(edgeNavKey(key({ key: "Home", ctrlKey: true }), false, true)).toBeNull();
		expect(edgeNavKey(key({ key: "End", ctrlKey: true }), false, true)).toBeNull();
	});

	test("Meta+Arrow maps to line/document edges only on Mac", () => {
		expect(edgeNavKey(key({ key: "ArrowLeft", metaKey: true }), false, true)).toEqual({ target: "line-start", extend: false });
		expect(edgeNavKey(key({ key: "ArrowRight", metaKey: true, shiftKey: true }), false, true)).toEqual({ target: "line-end", extend: true });
		expect(edgeNavKey(key({ key: "ArrowUp", metaKey: true }), false, true)).toEqual({ target: "doc-start", extend: false });
		expect(edgeNavKey(key({ key: "ArrowDown", metaKey: true, shiftKey: true }), false, true)).toEqual({ target: "doc-end", extend: true });
		expect(edgeNavKey(key({ key: "ArrowRight", metaKey: true }), false, false)).toBeNull();
	});

	test("ignores IME, Alt combos, Meta+Home/End, and non-edge keys", () => {
		expect(edgeNavKey(key(), true, false)).toBeNull();
		expect(edgeNavKey(key({ isComposing: true }), false, false)).toBeNull();
		expect(edgeNavKey(key({ altKey: true }), false, false)).toBeNull();
		expect(edgeNavKey(key({ metaKey: true }), false, true)).toBeNull();
		expect(edgeNavKey(key({ key: "ArrowRight", metaKey: true, ctrlKey: true }), false, true)).toBeNull();
		expect(edgeNavKey(key({ key: "ArrowRight", ctrlKey: true }), false, false)).toBeNull();
		expect(edgeNavKey(key({ key: "a" }), false, false)).toBeNull();
	});
});

describe("prompts", () => {
	const items = [{ kind: "user", text: "a" }, { kind: "assistant" }, { kind: "user", text: "a" }, { kind: "user", text: "  " }, { kind: "user", text: "b\n c" }];
	test("sentPrompts drops blanks and consecutive repeats", () => {
		expect(sentPrompts(items)).toEqual(["a", "b\n c"]);
		expect(sentPrompts(undefined)).toEqual([]);
	});
	test("lastPromptOf is the newest user text on one line", () => {
		expect(lastPromptOf(items)).toBe("b c");
		expect(lastPromptOf([...items, { kind: "assistant" }].slice(0, 3))).toBe("a");
		expect(lastPromptOf([{ kind: "user", text: " x \n y " }])).toBe("x y");
		expect(lastPromptOf(undefined)).toBe("");
	});
});

describe("menuAria", () => {
	const id = (i: number) => `o${i}`;
	test("a closed menu sets nothing", () => expect(menuAria(false, "l", id, 0, 3)).toEqual({}));
	test("open: the field is a combobox pointing at the list and the highlighted option", () => {
		expect(menuAria(true, "l", id, 2, 3)).toEqual({ role: "combobox", "aria-autocomplete": "list", "aria-controls": "l", "aria-expanded": "true", "aria-activedescendant": "o2" });
	});
	test("open with no rows: no active descendant", () => {
		expect(menuAria(true, "l", id, 0, 0)["aria-activedescendant"]).toBeUndefined();
	});
});
