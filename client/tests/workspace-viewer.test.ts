import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { buildEditHunk, buildFullFileDiff, deriveLatestTurnEdits, formatCompactCount, formatLineSpec, splitHighlightedHtml } from "../src/lib/workspace-edits";
import type { ChatState } from "../src/lib/chat.svelte";
import type { WorkspaceViewerStore as WorkspaceViewerStoreType } from "../src/lib/workspace-viewer.svelte";

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

describe("WorkspaceViewerStore repo & branch metadata", () => {
	let WorkspaceViewerStore: typeof WorkspaceViewerStoreType;
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "pipaya-wv-store-"));
		const srcPath = resolve("src/lib/workspace-viewer.svelte.ts");
		const build = await Bun.build({
			entrypoints: [srcPath],
			target: "bun",
			plugins: [
				{
					name: "runes",
					setup(builder) {
						builder.onLoad({ filter: /workspace-viewer\.svelte\.ts$/ }, async ({ path }) => {
							const raw = await Bun.file(path).text();
							const rewritten = raw.replace(/from "(\.\/[^"]+)"/g, (_, rel) => `from ${JSON.stringify(resolve("src/lib", rel))}`);
							const source = ts.transpileModule(rewritten, {
								compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
							}).outputText;
							return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
						});
					},
				},
			],
		});
		if (!build.success) throw new Error(build.logs.join("\n"));
		const out = join(tmpDir, "workspace-viewer.mjs");
		await writeFile(out, await build.outputs[0]!.text());
		WorkspaceViewerStore = (await import(out)).WorkspaceViewerStore;
	});

	afterAll(async () => {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	});

	it("hydrates initialRepo hint on bind, updates detached HEAD, notifies onMeta, and clears stale state on dir switch or initial error", async () => {
		const store = new WorkspaceViewerStore();
		const metas: { workDir: string; isRepo: boolean; branch: string | null }[] = [];
		let treeReply: () => Promise<unknown> = async () => ({
			workDir: "/repo-a",
			dir: "",
			isRepo: true,
			branch: null,
			head: "abc1234",
			entries: [{ name: "README.md", path: "README.md", dir: false }],
			truncated: false,
			changes: [],
		});
		const fakeApi = {
			baseUrl: "http://example.test",
			workspaceTree: () => treeReply(),
		} as never;

		store.bind(fakeApi, "s1", "/repo-a", undefined, {
			initialRepo: { branch: "main" },
			onMeta: (m) => metas.push(m),
		});
		expect(store.isRepo).toBe(true);
		expect(store.branch).toBe("main");
		expect(store.head).toBeNull();

		await store.refreshTree();
		expect(store.isRepo).toBe(true);
		expect(store.branch).toBeNull();
		expect(store.head).toBe("abc1234");
		expect(metas).toEqual([{ workDir: "/repo-a", isRepo: true, branch: null }]);

		// Switching to another folder resets repo/branch/head cleanly
		store.bind(fakeApi, "s2", "/plain-dir", undefined, {
			initialRepo: null,
			onMeta: (m) => metas.push(m),
		});
		expect(store.isRepo).toBe(false);
		expect(store.branch).toBeNull();
		expect(store.head).toBeNull();

		// Initial refresh failure clears hinted repo info instead of keeping stale metadata
		store.bind(fakeApi, "s3", "/missing-dir", undefined, {
			initialRepo: { branch: "stale-branch" },
			onMeta: (m) => metas.push(m),
		});
		expect(store.branch).toBe("stale-branch");
		treeReply = async () => {
			throw new Error("working directory not found");
		};
		await store.refreshTree();
		expect(store.treeError).toBeTruthy();
		expect(store.isRepo).toBe(false);
		expect(store.branch).toBeNull();
		expect(store.head).toBeNull();
	});

	it("refreshes branch metadata when a sibling session in the same workDir triggers workspace_changed", async () => {
		const store = new WorkspaceViewerStore();
		let currentBranch = "main";
		let calls = 0;
		let resolveSecond!: () => void;
		const secondDone = new Promise<void>((r) => {
			resolveSecond = r;
		});
		const fakeApi = {
			baseUrl: "http://example.test",
			workspaceTree: async () => {
				calls++;
				const res = {
					workDir: "/repo-shared",
					dir: "",
					isRepo: true,
					branch: currentBranch,
					head: "1112223",
					entries: [],
					truncated: false,
					changes: [],
				};
				if (calls >= 2) queueMicrotask(resolveSecond);
				return res;
			},
		} as never;

		store.bind(fakeApi, "s1", "/repo-shared", undefined, {
			getSessionDir: (id) => (id === "s1" || id === "s2" ? "/repo-shared" : "/other"),
		});
		await store.refreshTree();
		expect(store.branch).toBe("main");

		// Sibling session s2 switches branch via bash in the same directory
		currentBranch = "feat/switched";
		store.onEvent({ id: 1, sessionId: "s2", type: "workspace_changed", data: { tool: "bash", path: null }, ts: Date.now() });
		await Promise.race([
			secondDone,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for sibling refresh")), 2000)),
		]);
		expect(store.branch).toBe("feat/switched");
		expect(store.changes).toEqual([]);
	});

	it("ignores stale workspaceTree responses whose workDir mismatches the currently bound folder", async () => {
		const store = new WorkspaceViewerStore();
		const fakeApi = {
			baseUrl: "http://example.test",
			workspaceTree: async () => ({
				workDir: "/old-worktree",
				dir: "",
				isRepo: true,
				branch: "old-branch",
				head: "0000000",
				entries: [{ name: "stale.txt", path: "stale.txt", dir: false }],
				truncated: false,
				changes: [],
			}),
		} as never;

		store.bind(fakeApi, "s1", "/new-worktree", undefined, { initialRepo: { branch: "feat/new" } });
		await store.refreshTree();
		expect(store.workDir).toBe("/new-worktree");
		expect(store.branch).toBe("feat/new");
		expect(store.rootEntries).toEqual([]);
	});
});
