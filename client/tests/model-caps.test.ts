import { describe, expect, test } from "bun:test";
import { capsOf } from "../src/lib/model-caps";

const keys = (m: Parameters<typeof capsOf>[0]) => capsOf(m).map((c) => c.key);

describe("model abilities", () => {
	test("a plain model chats", () => {
		expect(keys({ reasoning: false, vision: false })).toEqual(["chat"]);
	});
	test("reasoning and reading pictures are added in a fixed order", () => {
		expect(keys({ reasoning: true, vision: true })).toEqual(["chat", "reasoning", "vision"]);
		expect(keys({ reasoning: false, vision: true })).toEqual(["chat", "vision"]);
	});
});
