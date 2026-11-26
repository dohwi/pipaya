import { expect, test } from "bun:test";
import { middleCut, tailCandidates, twinParentCandidates } from "../src/lib/fit-text";

test("a path is tried whole, then with fewer whole folders, never a piece of a name", () => {
	expect(tailCandidates("~/workspace/cliproxyapi")).toEqual(["~/workspace/cliproxyapi", "…/workspace/cliproxyapi", "…/cliproxyapi"]);
	expect(tailCandidates("agent")).toEqual(["agent"]);
	expect(tailCandidates("C:\\a\\b")).toEqual(["C:\\a\\b", "…\\a\\b", "…\\b"]);
});

test("twinParentCandidates drops colliding tails and falls back to the distinguishing folder", () => {
	// simple twins: distinct at the last segment, plus bare segment for narrow rows
	expect(twinParentCandidates("~/pipaya", ["~/test"])).toEqual(["~/pipaya", "…/pipaya", "pipaya"]);
	expect(twinParentCandidates("~/workspace/pipaya", ["~/workspace/test"])).toEqual(["~/workspace/pipaya", "…/workspace/pipaya", "…/pipaya", "pipaya"]);
	// shared trailing folder: never collapses to `…/sub`, falls back to `team-a/…`; leading `/` stays intact when start === 0
	expect(twinParentCandidates("~/team-a/sub", ["~/team-b/sub"])).toEqual(["~/team-a/sub", "…/team-a/sub", "team-a/sub", "team-a/…"]);
	expect(twinParentCandidates("/a/b/c", ["/d/b/c"])).toEqual(["/a/b/c", "a/…"]);
	// three-way twins: compact form is skipped when another peer shares that distinguishing folder anywhere before its leaf
	expect(twinParentCandidates("~/a/x", ["~/b/x", "~/b/y"])).toEqual(["~/a/x", "…/a/x", "a/x", "a/…"]);
	expect(twinParentCandidates("~/b/x", ["~/a/x", "~/b/y"])).toEqual(["~/b/x", "…/b/x", "b/x"]);
	expect(twinParentCandidates("~/b/y", ["~/a/x", "~/b/x"])).toEqual(["~/b/y", "…/b/y", "…/y", "y"]);
	expect(twinParentCandidates("~/a/x", ["~/b/x", "~/a/y/x"])).toEqual(["~/a/x", "…/a/x", "a/x"]);
	// prefix/suffix twins: `~/b` never drops `~` when another twin also ends in `b`
	expect(twinParentCandidates("~/a/b", ["~/b"])).toEqual(["~/a/b", "…/a/b", "a/b", "a/…"]);
	expect(twinParentCandidates("~/b", ["~/a/b"])).toEqual(["~/b"]);
	// home vs root
	expect(twinParentCandidates("~/a/b", ["/a/b"])).toEqual(["~/a/b", "~/…"]);
	expect(twinParentCandidates("/a/b", ["~/a/b"])).toEqual(["/a/b"]);
	expect(twinParentCandidates("~", ["~/workspace"])).toEqual(["~"]);
	expect(twinParentCandidates("/", ["~"])).toEqual(["/"]);
	// Windows paths
	expect(twinParentCandidates("C:\\Users\\me\\sub", ["D:\\Users\\me\\sub"])).toEqual(["C:\\Users\\me\\sub", "C:\\…"]);
	// compact: false (primary worktree subpath/branch labels keep the distinguishing slice without dropping the leaf name)
	expect(twinParentCandidates("work/alpha/dashboard", ["work/beta/dashboard"], { compact: false })).toEqual([
		"work/alpha/dashboard",
		"…/alpha/dashboard",
		"alpha/dashboard",
	]);
	expect(twinParentCandidates("feat/auth", ["fix/auth"], { compact: false })).toEqual(["feat/auth"]);
	// edge cases: empty full, no peers, empty peers, identical peer
	expect(twinParentCandidates("", ["~/a"])).toEqual([""]);
	expect(twinParentCandidates("~/a/b", [])).toEqual(["~/a/b", "…/a/b", "…/b"]);
	expect(twinParentCandidates("~/a/b", [""])).toEqual(["~/a/b", "…/a/b", "…/b"]);
	expect(twinParentCandidates("/a/b", ["/a/b"])).toEqual(["/a/b"]);
});

test("an id loses its middle: both ends stay, the whole of it when it fits", () => {
	expect(middleCut("qwen3-coder-480b", 99)).toBe("qwen3-coder-480b");
	expect(middleCut("abcdefghij", 7)).toBe("abc…hij");
	expect(middleCut("abcdefghij", 6)).toBe("abc…ij");
	expect(middleCut("abcdefghij", 2)).toBe("a…");
	expect(middleCut("abcdefghij", 1)).toBe("…");
});
