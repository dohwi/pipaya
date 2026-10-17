import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchOf, briefLine, capPeerRead, groupHandle, groupHint, MAX_HINT_CHARS, MAX_LISTED, mentionedGroups, type MemberBrief } from "../src/group-mention.ts";

const brief = (name: string, over: Partial<MemberBrief> = {}): MemberBrief => ({ name, purpose: "", cwd: "/w/x", branch: null, running: false, last: "", ...over });

describe("@group mentions", () => {
	const groups = [{ name: "결제 개편" }, { name: "docs" }];

	test("finds groups by handle (spaces become dashes), once each, in order", () => {
		expect(groupHandle("결제 개편")).toBe("결제-개편");
		expect(mentionedGroups("@docs 정리하고 @결제-개편 PR 해줘 @docs", groups)).toEqual(["docs", "결제-개편"]);
	});

	test("ignores unknown tags, emails and longer ascii words", () => {
		expect(mentionedGroups("mail me@docs or @nobody or @docsfoo", groups)).toEqual([]);
	});

	test("accepts a Korean particle after the handle", () => {
		expect(mentionedGroups("@결제-개편에 구현한 거 PR", groups)).toEqual(["결제-개편"]);
	});

	test("a session with the same name wins the tag", () => {
		expect(mentionedGroups("@docs hi", groups, ["docs"])).toEqual([]);
		expect(mentionedGroups("@docs hi", groups, ["doc"])).toEqual(["docs"]);
	});
});

describe("group hint stays small", () => {
	test("one line per session with role, state, branch, dir and a cut last message", () => {
		const line = briefLine(brief("미나", { purpose: "결제 API", running: true, branch: "feat/pay", last: "x".repeat(500) }));
		expect(line).toContain("@미나 (결제 API) · working · branch feat/pay · /w/x");
		expect(line.length).toBeLessThan(300);
	});

	test("lists at most MAX_LISTED sessions and caps the whole hint", () => {
		const many = Array.from({ length: 40 }, (_, i) => brief(`s${i}`, { purpose: "p".repeat(60), last: "y".repeat(400) }));
		const hint = groupHint("<h>", [{ handle: "g", members: many }]);
		expect(hint.match(/^- @s/gm)?.length).toBe(MAX_LISTED);
		expect(hint).toContain(`+${40 - MAX_LISTED} more`);
		expect(hint.length).toBeLessThan(MAX_HINT_CHARS + 800);
		expect(hint.startsWith("<h>")).toBe(true);
		expect(hint.endsWith("</pipaya-hint>")).toBe(true);
	});

	test("does not contain transcripts, only the index", () => {
		const hint = groupHint("<h>", [{ handle: "g", members: [brief("a"), brief("b")] }]);
		expect(hint).toContain("peer_read");
		expect(hint).toContain("Group @g (2 sessions)");
	});
});

describe("peer_read output cap", () => {
	test("cuts long messages and drops the oldest past the total cap", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `m${i}: ${"z".repeat(2000)}`);
		const out = capPeerRead(lines);
		expect(out.length).toBeLessThan(7500);
		expect(out).toContain("m39:");
		expect(out).not.toContain("m0:");
		expect(out).toContain("older message(s) left out");
	});

	test("short reads pass through unchanged", () => {
		expect(capPeerRead(["a: hi", "b: yo"])).toBe("a: hi\nb: yo");
	});
});

describe("branchOf", () => {
	test("reads a normal repo and a worktree pointer file, null outside git", () => {
		const root = mkdtempSync(join(tmpdir(), "pipaya-branch-"));
		mkdirSync(join(root, "repo/.git"), { recursive: true });
		mkdirSync(join(root, "repo/sub"), { recursive: true });
		writeFileSync(join(root, "repo/.git/HEAD"), "ref: refs/heads/feat/a\n");
		expect(branchOf(join(root, "repo/sub"))).toBe("feat/a");

		mkdirSync(join(root, "meta/wt"), { recursive: true });
		writeFileSync(join(root, "meta/wt/HEAD"), "ref: refs/heads/fix/b\n");
		mkdirSync(join(root, "work"), { recursive: true });
		writeFileSync(join(root, "work/.git"), `gitdir: ${join(root, "meta/wt")}\n`);
		expect(branchOf(join(root, "work"))).toBe("fix/b");

		writeFileSync(join(root, "repo/.git/HEAD"), "0123456789abcdef\n");
		expect(branchOf(join(root, "repo"))).toBeNull();
	});
});
