import { describe, expect, test } from "bun:test";
import { hideFenceTail } from "../src/lib/markdown-split";

const code = "text\n\n```ts\nfunction f() {\n  return 1;\n}\n";

describe("hideFenceTail", () => {
	test("hides a closing fence that is still being typed", () => {
		expect(hideFenceTail(`${code}\``)).toBe(code.slice(0, -1));
		expect(hideFenceTail(`${code}\`\``)).toBe(code.slice(0, -1));
	});
	test("keeps a complete fence and ordinary text", () => {
		expect(hideFenceTail(`${code}\`\`\``)).toBe(`${code}\`\`\``);
		expect(hideFenceTail("a `b")).toBe("a `b");
		expect(hideFenceTail("one\n\n`")).toBe("one\n\n`");
	});
});
