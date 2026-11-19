import { expect, test } from "bun:test";
import { middleCut, tailCandidates } from "../src/lib/fit-text";

test("a path is tried whole, then with fewer whole folders, never a piece of a name", () => {
	expect(tailCandidates("~/workspace/cliproxyapi")).toEqual(["~/workspace/cliproxyapi", "…/workspace/cliproxyapi", "…/cliproxyapi"]);
	expect(tailCandidates("agent")).toEqual(["agent"]);
	expect(tailCandidates("C:\\a\\b")).toEqual(["C:\\a\\b", "…\\a\\b", "…\\b"]);
});

test("an id loses its middle: both ends stay, the whole of it when it fits", () => {
	expect(middleCut("qwen3-coder-480b", 99)).toBe("qwen3-coder-480b");
	expect(middleCut("abcdefghij", 7)).toBe("abc…hij");
	expect(middleCut("abcdefghij", 6)).toBe("abc…ij");
	expect(middleCut("abcdefghij", 2)).toBe("a…");
	expect(middleCut("abcdefghij", 1)).toBe("…");
});
