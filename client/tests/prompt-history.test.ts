import { describe, expect, test } from "bun:test";
import { newHistory, stepHistory } from "../src/lib/prompt-history";

const prompts = ["first", "second", "third"];
const up = (h: ReturnType<typeof newHistory>, text = "", before = "", after = "") => stepHistory(h, "ArrowUp", text, before, after, prompts);
const down = (h: ReturnType<typeof newHistory>, text: string, before = "", after = "") => stepHistory(h, "ArrowDown", text, before, after, prompts);

describe("prompt history", () => {
	test("Up walks back from the newest and stops at the oldest", () => {
		const h = newHistory();
		expect(up(h)).toEqual({ used: true, text: "third" });
		expect(up(h, "third")).toEqual({ used: true, text: "second" });
		expect(up(h, "second")).toEqual({ used: true, text: "first" });
		expect(up(h, "first")).toEqual({ used: true }); // at the oldest: swallowed, nothing changes
	});
	test("Down walks forward and finally restores what was being typed", () => {
		const h = newHistory();
		up(h, "draft");
		up(h, "third");
		expect(down(h, "second")).toEqual({ used: true, text: "third" });
		expect(down(h, "third")).toEqual({ used: true, text: "draft" });
		expect(h.index).toBe(-1);
		expect(down(h, "draft")).toEqual({ used: false });
	});
	test("with no history Up is left to the textarea", () => {
		expect(stepHistory(newHistory(), "ArrowUp", "", "", "", [])).toEqual({ used: false });
	});
	test("a multi-line input moves its caret first", () => {
		const h = newHistory();
		expect(up(h, "a\nb", "a\nb")).toEqual({ used: false });
		up(h);
		expect(down(h, "third", "", "x\ny")).toEqual({ used: false });
	});
	test("editing a recalled prompt starts over from the newest", () => {
		const h = newHistory();
		up(h);
		up(h, "third");
		expect(up(h, "third edited")).toEqual({ used: true, text: "third" });
		expect(h.draft).toBe("third edited");
	});
	test("Down does nothing unless browsing", () => {
		expect(down(newHistory(), "x")).toEqual({ used: false });
	});
});
