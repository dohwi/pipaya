import { describe, expect, it } from "bun:test";
import { buildEditHunk, buildFullFileDiff, deriveLatestTurnEdits, formatCompactCount, formatLineSpec, splitHighlightedHtml } from "../src/lib/workspace-edits";
import type { ChatState } from "../src/lib/chat.svelte";

function fakeChat(items: ChatState["items"], tools: ChatState["tools"] = {}): ChatState {
	return { items, tools } as unknown as ChatState;
}

describe("workspace-viewer recent edits", () => {
	it("returns no changes for an empty session", () => {
		const res = deriveLatestTurnEdits(fakeChat([]), "/repo");
		expect(res.changes).toEqual([]);
		expect(res.turnKey).toBeNull();
	});

	it("returns only the latest editing turn and ignores earlier turns or errored edits", () => {
		const chat = fakeChat(
			[
				{ kind: "user", key: "u1", seq: 1, text: "first", images: [], files: [], ts: 1 },
				{
					kind: "assistant",
					key: "a1",
					seq: 2,
					streaming: false,
					ts: 2,
					blocks: [
						{ type: "tool", id: "t1", name: "edit", args: { path: "old.ts", oldText: "a", newText: "b" } },
					],
				},
				{ kind: "user", key: "u2", seq: 3, text: "second", images: [], files: [], ts: 3 },
				{
					kind: "assistant",
					key: "a2",
					seq: 4,
					streaming: false,
					ts: 4,
					blocks: [
						{ type: "tool", id: "t2", name: "edit", args: { path: "/repo/src/app.ts", oldText: "x", newText: "y" } },
						{ type: "tool", id: "t3", name: "edit", args: { path: "failed.ts", oldText: "1", newText: "2" } },
						{ type: "tool", id: "t4", name: "write", args: { path: "./src/new.ts", content: "export const ok = 1;\n" } },
					],
				},
			],
			{
				t1: { state: "done", output: "" },
				t2: { state: "done", output: "" },
				t3: { state: "error", output: "not found" },
				t4: { state: "running", output: "" },
			},
		);

		const res = deriveLatestTurnEdits(chat, "/repo");
		expect(res.changes.map((c) => ({ path: c.path, status: c.status, pending: c.pending }))).toEqual([
			{ path: "src/app.ts", status: "M", pending: false },
			{ path: "src/new.ts", status: "A", pending: true },
		]);
		expect(res.diffs.get("src/app.ts")?.hunks.length).toBe(1);
		expect(res.diffs.get("src/new.ts")?.additions).toBe(1);
	});

	it("extracts multiple hunks from edit.edits[] calls", () => {
		const chat = fakeChat(
			[
				{ kind: "user", key: "u1", seq: 1, text: "batch edit", images: [], files: [], ts: 1 },
				{
					kind: "assistant",
					key: "a1",
					seq: 2,
					streaming: false,
					ts: 2,
					blocks: [
						{
							type: "tool",
							id: "t1",
							name: "edit",
							args: {
								path: "src/app.ts",
								edits: [
									{ oldText: "const a = 1;", newText: "const a = 10;" },
									{ oldText: "const b = 2;", newText: "const b = 20;\nconst c = 30;" },
								],
							},
						},
					],
				},
			],
			{ t1: { state: "done", output: "" } },
		);
		const res = deriveLatestTurnEdits(chat, "/repo");
		expect(res.changes).toEqual([{ path: "src/app.ts", status: "M", additions: 3, deletions: 2, pending: false }]);
		expect(res.diffs.get("src/app.ts")?.hunks.length).toBe(2);
	});

	it("anchors diff hunk line numbers to actual file lines when file content is available", () => {
		const content = "line1\nline2\nline3\nconst x = 2;\nline5\n";
		const { hunk, additions, deletions } = buildEditHunk("const x = 1;", "const x = 2;", content);
		expect(additions).toBe(1);
		expect(deletions).toBe(1);
		expect(hunk.newStart).toBe(4);
		expect(hunk.lines.find((l) => l.type === "add")?.newLine).toBe(4);
	});

	it("merges hunks into the complete file contents with inline del/add rows and changeStart markers", () => {
		const content = ["line1", "line2", "addedA", "addedB", "line4", "line5", "line6"].join("\n");
		const { hunk } = buildEditHunk("line2\noldLine3\nline4", "line2\naddedA\naddedB\nline4", content);
		const rows = buildFullFileDiff(content, [hunk]);

		expect(rows.map((r) => `${r.type}:${r.text}`)).toEqual([
			"context:line1",
			"context:line2",
			"del:oldLine3",
			"add:addedA",
			"add:addedB",
			"context:line4",
			"context:line5",
			"context:line6",
		]);
		expect(rows.filter((r) => r.changeStart).map((r) => r.text)).toEqual(["oldLine3"]);
		expect(rows.find((r) => r.text === "line6")?.newLine).toBe(7);
		expect(rows.find((r) => r.text === "line6")?.oldLine).toBe(6);
	});

	it("snaps hunks with unanchored line numbers to their actual position in the full file", () => {
		const content = ["a", "b", "c", "d", "NEW_LINE", "f", "g"].join("\n");
		// Simulate a hunk whose newStart was 1 (created before file content was loaded)
		const { hunk } = buildEditHunk("d\nOLD_LINE\nf", "d\nNEW_LINE\nf");
		expect(hunk.newStart).toBe(1);
		const rows = buildFullFileDiff(content, [hunk]);
		expect(rows.map((r) => `${r.type}:${r.text}`)).toEqual([
			"context:a",
			"context:b",
			"context:c",
			"context:d",
			"del:OLD_LINE",
			"add:NEW_LINE",
			"context:f",
			"context:g",
		]);
	});

	it("formats non-contiguous and contiguous line numbers cleanly", () => {
		expect(formatLineSpec([6])).toBe("6");
		expect(formatLineSpec([3, 4, 5, 6])).toBe("3-6");
		expect(formatLineSpec([14, 3, 5, 4, 9, 15])).toBe("3-5,9,14-15");
	});

	it("formats large diff and file counts compactly without overflowing narrow chrome", () => {
		expect(formatCompactCount(0)).toBe("0");
		expect(formatCompactCount(-5)).toBe("0");
		expect(formatCompactCount(Number.NaN)).toBe("0");
		expect(formatCompactCount(Number.POSITIVE_INFINITY)).toBe("0");
		expect(formatCompactCount(42)).toBe("42");
		expect(formatCompactCount(999)).toBe("999");
		expect(formatCompactCount(1_000)).toBe("1k");
		expect(formatCompactCount(1_049)).toBe("1k");
		expect(formatCompactCount(1_250)).toBe("1.3k");
		expect(formatCompactCount(9_949)).toBe("9.9k");
		expect(formatCompactCount(9_950)).toBe("10k");
		expect(formatCompactCount(12_450)).toBe("12k");
		expect(formatCompactCount(999_499)).toBe("999k");
		expect(formatCompactCount(999_500)).toBe("1M");
		expect(formatCompactCount(1_250_000)).toBe("1.3M");
		expect(formatCompactCount(12_000_000)).toBe("12M");
		expect(formatCompactCount(1_000_000_000)).toBe("999M+");
	});

	it("splits multi-line highlighted HTML while keeping span tags balanced on every line", () => {
		const html = '<span class="hljs-comment">/* line 1\n * <span class="hljs-doctag">@param</span> x\n */</span>\nconst a = 1;';
		expect(splitHighlightedHtml(html)).toEqual([
			'<span class="hljs-comment">/* line 1</span>',
			'<span class="hljs-comment"> * <span class="hljs-doctag">@param</span> x</span>',
			'<span class="hljs-comment"> */</span>',
			"const a = 1;",
		]);
		expect(splitHighlightedHtml("")).toEqual([]);
	});

	it("counts huge write tool payloads without allocating all lines", () => {
		const big = "line\n".repeat(100_000);
		const chat = fakeChat([
			{ key: "u1", kind: "user", text: "gen", images: [], seq: 1 } as never,
			{
				key: "a1",
				kind: "assistant",
				seq: 2,
				blocks: [{ type: "tool", id: "t1", name: "write", args: { path: "big.txt", content: big } }],
			} as never,
		], { t1: { state: "done" } as never });
		const t0 = performance.now();
		const res = deriveLatestTurnEdits(chat, "/repo");
		const ms = performance.now() - t0;
		expect(res.changes[0]?.additions).toBe(100_000);
		expect(res.diffs.get("big.txt")?.truncated).toBe(true);
		expect(res.diffs.get("big.txt")?.hunks[0]?.lines.length).toBe(400);
		expect(ms).toBeLessThan(200);
	});
});
