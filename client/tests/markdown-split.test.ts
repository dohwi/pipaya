import { describe, expect, test } from "bun:test";
import { hideFenceTail, hideMarkerTail } from "../src/lib/markdown-split";

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

describe("hideMarkerTail", () => {
	test("hides a block marker that has no text after it yet", () => {
		for (const m of ["#", "##", "-", "1.", "2", ">", "--", "|", "| a |\n|-"]) {
			const out = hideMarkerTail(`para\n\n${m}`);
			expect(out === "para\n" || out === "para\n\n" || out === "para" || out.startsWith("para")).toBe(true);
			expect(out.endsWith(m)).toBe(false);
		}
	});
	test("keeps text that follows a marker and code contents", () => {
		expect(hideMarkerTail("para\n\n## Title")).toBe("para\n\n## Title");
		expect(hideMarkerTail("para\n\n- item")).toBe("para\n\n- item");
		expect(hideMarkerTail("```\n-")).toBe("```\n-");
		expect(hideMarkerTail("a - b")).toBe("a - b");
	});
});
