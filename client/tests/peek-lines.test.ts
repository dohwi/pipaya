import { describe, expect, test } from "bun:test";
import { peekLines } from "../src/lib/peek-lines";

/** What the work box did before: the whole text cleaned and split, then the last lines. */
const whole = (text: string, n: number, max = 400) =>
	text
		.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter((l) => l.trim())
		.slice(-n)
		.map((l) => (l.length > max ? `${l.slice(0, max - 1)}…` : l));

describe("peekLines", () => {
	test("the last non-blank lines, trailing space and escapes off", () => {
		expect(peekLines("a\n\n  b  \r\n\u001b[32mc\u001b[0m\n   \n", 2)).toEqual(["  b", "c"]);
		expect(peekLines("", 6)).toEqual([]);
		expect(peekLines("only", 6)).toEqual(["only"]);
	});
	test("a long line is cut with an ellipsis", () => {
		const [l] = peekLines("x".repeat(1000), 6);
		expect(l).toHaveLength(400);
		expect(l!.endsWith("…")).toBe(true);
	});
	test("reads only the end of a long output, with the same result as the whole text", () => {
		const out = Array.from({ length: 50_000 }, (_, i) => `\u001b[1mline ${i}\u001b[0m   `).join("\r\n");
		expect(peekLines(out, 6)).toEqual(whole(out, 6));
		expect(peekLines(out, 6).at(-1)).toBe("line 49999");
	});
	test("the window never starts inside a line: a cut line is not shown in part", () => {
		// the line before the last ones is longer than the first window, then trailing blank lines
		const out = `${"a".repeat(3000)}\n${"b".repeat(9000)}\nlast\n\n\n`;
		expect(peekLines(out, 6)).toEqual(whole(out, 6));
		expect(peekLines(out, 2)).toEqual([`${"b".repeat(399)}…`, "last"]);
	});
	test("one huge line, or blank lines past the window, still find the lines above", () => {
		const huge = "y".repeat(100_000);
		expect(peekLines(huge, 6)).toEqual(whole(huge, 6));
		const sparse = `first\nsecond${"\n".repeat(20_000)}`;
		expect(peekLines(sparse, 6)).toEqual(["first", "second"]);
	});
	test("matches the whole-text result on random outputs", () => {
		let seed = 7;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		for (let k = 0; k < 200; k++) {
			const parts: string[] = [];
			for (let i = rnd() * 40; i > 0; i--) parts.push(rnd() < 0.3 ? "" : rnd() < 0.1 ? "z".repeat(Math.floor(rnd() * 6000)) : `l${i} `.repeat(Math.floor(rnd() * 8)));
			const text = parts.join(rnd() < 0.5 ? "\n" : "\r\n");
			expect(peekLines(text, 6)).toEqual(whole(text, 6));
		}
	});
});
