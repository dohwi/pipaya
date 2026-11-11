import { describe, expect, test } from "bun:test";
import { enterPlan, hangulCommit, historyKey, lastPromptOf, menuAria, sentPrompts } from "../src/lib/composer/input-keys";
import { Ime } from "../src/lib/composer/ime";

const plan = (o: Partial<Parameters<typeof enterPlan>[0]> = {}) => enterPlan({ running: false, combo: "Enter", queueCombo: "Alt+Enter", shift: false, isCommand: false, isUnknownCommand: false, ...o });

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
	test("commands run locally, mid-run too; a mistyped one is refused", () => {
		expect(plan({ isCommand: true, running: true })).toBe("command");
		expect(plan({ isUnknownCommand: true })).toBe("unknown-command");
		expect(plan({ isUnknownCommand: true, running: true })).toBe("unknown-command");
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
