import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { StoredMessage } from "../src/lib/api";
import { setLang } from "../src/lib/i18n";
import { gridNext, PREVIEW_MAX, previewOfItems, previewOfStored, previewText, shortPath, tabCountText } from "../src/lib/tab-overview";
import type { ChatItem } from "../src/lib/types";

const user = (text: string): ChatItem => ({ kind: "user", key: text, seq: 1, text, images: [], ts: 0 });
const reply = (...texts: string[]): ChatItem => ({
	kind: "assistant",
	key: texts.join(),
	seq: 2,
	blocks: [{ type: "thinking", text: "hmm", done: true }, ...texts.map((text) => ({ type: "text" as const, text })), { type: "tool", id: "c", name: "bash", args: {} }],
	streaming: false,
	stopReason: "stop",
	ts: 0,
});
const stored = (seq: number, message: unknown): StoredMessage => ({ seq, role: (message as { role: string }).role, createdAt: 0, message: message as StoredMessage["message"] });

beforeEach(() => setLang("ko"));
afterAll(() => setLang("en"));

describe("tab count", () => {
	test("up to 99 as is, then 99+", () => {
		expect(tabCountText(0)).toBe("0");
		expect(tabCountText(7)).toBe("7");
		expect(tabCountText(99)).toBe("99");
		expect(tabCountText(100)).toBe("99+");
		expect(tabCountText(-3)).toBe("0");
	});
});

describe("preview text", () => {
	test("markdown folds into one line of prose", () => {
		expect(previewText("# Title\n\n- **one** and `two`\n> quoted [link](http://x) ![pic](a.png)")).toBe("Title one and two quoted link pic");
		expect(previewText("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
		expect(previewText("hi <pipaya-files>[{}]</pipaya-files> there")).toBe("hi there");
	});
	test("long text is cut with an ellipsis", () => {
		const out = previewText("a".repeat(PREVIEW_MAX * 2));
		expect(out.length).toBe(PREVIEW_MAX);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("preview of a loaded chat", () => {
	test("the newest message with text wins, a reply's thinking and tools are skipped", () => {
		expect(previewOfItems([user("question"), reply("answer", "more")])).toEqual({ who: "assistant", text: "answer more" });
	});
	test("a reply with no text yet falls back to the prompt before it", () => {
		expect(previewOfItems([user("question"), reply()])).toEqual({ who: "user", text: "question" });
	});
	test("notices are not messages; an empty chat has no preview", () => {
		expect(previewOfItems([user("q"), { kind: "notice", key: "n", text: "error", ts: 0 }])).toEqual({ who: "user", text: "q" });
		expect(previewOfItems([])).toBeNull();
	});
});

describe("preview of stored messages", () => {
	test("tool results are skipped, content arrays and strings both read", () => {
		const list = [
			stored(1, { role: "user", content: "hello", timestamp: 0 }),
			stored(2, { role: "assistant", content: [{ type: "text", text: "**done**" }, { type: "toolCall", id: "1", name: "x", arguments: {} }], stopReason: "toolUse", timestamp: 0 }),
			stored(3, { role: "toolResult", toolCallId: "1", toolName: "x", content: [{ type: "text", text: "output" }], isError: false, timestamp: 0 }),
		];
		expect(previewOfStored(list)).toEqual({ who: "assistant", text: "done" });
		expect(previewOfStored(list.slice(0, 1))).toEqual({ who: "user", text: "hello" });
		expect(previewOfStored([])).toBeNull();
	});
});

describe("grid keys", () => {
	// 7 cards in 3 columns:  0 1 2 / 3 4 5 / 6
	test("left / right step and wrap across rows, stopping at the ends", () => {
		expect(gridNext("ArrowRight", 2, 7, 3)).toBe(3);
		expect(gridNext("ArrowLeft", 3, 7, 3)).toBe(2);
		expect(gridNext("ArrowRight", 6, 7, 3)).toBe(6);
		expect(gridNext("ArrowLeft", 0, 7, 3)).toBe(0);
	});
	test("up / down move a row and stay put where there is none", () => {
		expect(gridNext("ArrowDown", 1, 7, 3)).toBe(4);
		expect(gridNext("ArrowDown", 4, 7, 3)).toBe(4);
		expect(gridNext("ArrowDown", 3, 7, 3)).toBe(6);
		expect(gridNext("ArrowUp", 6, 7, 3)).toBe(3);
		expect(gridNext("ArrowUp", 2, 7, 3)).toBe(2);
	});
	test("Home / End, other keys and an unknown index", () => {
		expect(gridNext("Home", 5, 7, 3)).toBe(0);
		expect(gridNext("End", 0, 7, 3)).toBe(6);
		expect(gridNext("Enter", 0, 7, 3)).toBeNull();
		expect(gridNext("ArrowRight", -1, 7, 3)).toBeNull();
		expect(gridNext("ArrowRight", 0, 0, 3)).toBeNull();
	});
});

describe("short path", () => {
	test("the last two steps, on either separator", () => {
		expect(shortPath("/home/u/proj/app")).toBe("proj/app");
		expect(shortPath("C:\\work\\proj\\app")).toBe("proj/app");
		expect(shortPath("/")).toBe("/");
	});
});
