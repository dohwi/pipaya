import { expect, test } from "bun:test";
import { makeQuote, splitQuote } from "../src/lib/quote";

test("quote round trip", () => {
	const q = makeQuote("a\nb");
	expect(q).toBe("> a\n> b\n\n");
	expect(splitQuote(`${q}answer`)).toEqual({ quote: "a\nb", rest: "answer" });
	expect(splitQuote("plain")).toEqual({ quote: "", rest: "plain" });
});
