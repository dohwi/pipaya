import { expect, test } from "bun:test";
import { tailCandidates } from "../src/lib/fit-text";

test("a path is tried whole, then with fewer whole folders, never a piece of a name", () => {
	expect(tailCandidates("~/workspace/cliproxyapi")).toEqual(["~/workspace/cliproxyapi", "…/workspace/cliproxyapi", "…/cliproxyapi"]);
	expect(tailCandidates("agent")).toEqual(["agent"]);
	expect(tailCandidates("C:\\a\\b")).toEqual(["C:\\a\\b", "…\\a\\b", "…\\b"]);
});
