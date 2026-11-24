import { describe, expect, it } from "bun:test";
import { buildEditHunk, buildFullFileDiff, deriveLatestTurnEdits } from "../src/lib/workspace-edits";
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
});
