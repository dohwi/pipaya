import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openDb } from "../src/db.ts";
import { SessionStore } from "../src/store.ts";
import { parseUnifiedDiff, registerWorkspaceViewerRoutes, safeInsideRoot } from "../src/routes/workspace-viewer-routes.ts";

const temps: string[] = [];

function mkTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

async function git(cwd: string, args: string[]) {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	await proc.exited;
}

async function initRepo() {
	const dir = mkTempDir("pipaya-wv-");
	await git(dir, ["init", "-b", "main"]);
	await git(dir, ["config", "user.email", "test@pipaya.dev"]);
	await git(dir, ["config", "user.name", "Pipaya"]);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "# Hello\nline2\n");
	writeFileSync(join(dir, "src", "app.ts"), "export const x = 1;\nexport const y = 2;\n");
	await git(dir, ["add", "-A"]);
	await git(dir, ["commit", "-m", "init"]);
	return dir;
}

async function setupServer(cwd: string) {
	const db = openDb(":memory:");
	const store = new SessionStore(db);
	const now = Date.now();
	store.create({
		id: "s1",
		title: "Viewer Test",
		name: "viewer",
		purpose: "",
		cwd,
		provider: "test",
		model: "m1",
		thinkingLevel: "off",
		serviceTier: null,
		systemPrompt: "",
		tools: ["read", "write", "edit", "bash"],
		parentId: null,
		closed: false,
		activeDir: null,
		createdAt: now,
		updatedAt: now,
	});
	const app = Fastify();
	registerWorkspaceViewerRoutes(app, { store });
	await app.ready();
	return { app, db };
}

afterEach(() => {
	while (temps.length) {
		const d = temps.pop()!;
		try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

describe("workspace viewer helpers", () => {
	test("blocks path traversal and parses +++ / --- code lines inside hunks", () => {
		const dir = mkTempDir("pipaya-wv-safe-");
		writeFileSync(join(dir, "a.txt"), "ok");
		expect(safeInsideRoot(dir, "a.txt")).toBe(join(dir, "a.txt"));
		expect(safeInsideRoot(dir, "../etc/passwd")).toBeNull();
		expect(safeInsideRoot(dir, "/etc/passwd")).toBeNull();
		expect(safeInsideRoot(dir, "a\0b")).toBeNull();

		const diff = parseUnifiedDiff([
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,2 +1,2 @@",
			"--- sql comment",
			"+++i;",
		].join("\n"));
		expect(diff.additions).toBe(1);
		expect(diff.deletions).toBe(1);
		expect(diff.hunks[0]!.lines[0]!.text).toBe("-- sql comment");
		expect(diff.hunks[0]!.lines[1]!.text).toBe("++i;");
	});
});

describe("workspace viewer routes", () => {
	test("lists tree, subdirectories, search, git changes, file contents, and diffs", async () => {
		const repo = await initRepo();
		writeFileSync(join(repo, "src", "app.ts"), "export const x = 10;\nexport const y = 2;\nexport const z = 3;\n");
		writeFileSync(join(repo, "src", "new.ts"), "export const fresh = true;\n");

		const { app, db } = await setupServer(repo);
		try {
			// Root tree
			const rootRes = await app.inject({ method: "GET", url: "/sessions/s1/workspace/tree" });
			expect(rootRes.statusCode).toBe(200);
			const root = rootRes.json();
			expect(root.isRepo).toBe(true);
			expect(root.branch).toBe("main");
			expect(root.entries.map((e: { name: string }) => e.name)).toEqual(["src", "README.md"]);
			expect(root.changes.map((c: { path: string }) => c.path).sort()).toEqual(["src/app.ts", "src/new.ts"]);

			// Subdir listing
			const subRes = await app.inject({ method: "GET", url: "/sessions/s1/workspace/tree?dir=src" });
			expect(subRes.statusCode).toBe(200);
			expect(subRes.json().entries.map((e: { path: string }) => e.path)).toEqual(["src/app.ts", "src/new.ts"]);

			// Search
			const qRes = await app.inject({ method: "GET", url: "/sessions/s1/workspace/tree?q=new.ts" });
			expect(qRes.statusCode).toBe(200);
			expect(qRes.json().entries.map((e: { path: string }) => e.path)).toEqual(["src/new.ts"]);

			// Read file
			const fRes = await app.inject({ method: "GET", url: "/sessions/s1/workspace/file?path=src/app.ts" });
			expect(fRes.statusCode).toBe(200);
			const file = fRes.json();
			expect(file.binary).toBe(false);
			expect(file.lineCount).toBe(4);
			expect(file.content).toContain("export const z = 3;");

			// Traversal refused
			const badRes = await app.inject({ method: "GET", url: "/sessions/s1/workspace/file?path=../secret" });
			expect(badRes.statusCode).toBe(400);

			// Tracked file diff
			const diffRes = await app.inject({ method: "GET", url: "/sessions/s1/workspace/diff?path=src/app.ts" });
			expect(diffRes.statusCode).toBe(200);
			const diff = diffRes.json();
			expect(diff.additions).toBe(2);
			expect(diff.deletions).toBe(1);
			expect(diff.hunks.length).toBe(1);

			// Untracked file diff
			const uDiffRes = await app.inject({ method: "GET", url: "/sessions/s1/workspace/diff?path=src/new.ts" });
			expect(uDiffRes.statusCode).toBe(200);
			expect(uDiffRes.json().additions).toBe(1);

			// Save edited file
			const putRes = await app.inject({
				method: "PUT",
				url: "/sessions/s1/workspace/file",
				payload: { path: "src/app.ts", content: "export const x = 42;\n" },
			});
			expect(putRes.statusCode).toBe(200);
			expect(putRes.json().lineCount).toBe(2);
			const verifyRes = await app.inject({ method: "GET", url: "/sessions/s1/workspace/file?path=src/app.ts" });
			expect(verifyRes.json().content).toBe("export const x = 42;\n");

			// Traversal refused on save
			const badPut = await app.inject({
				method: "PUT",
				url: "/sessions/s1/workspace/file",
				payload: { path: "../escape.ts", content: "nope" },
			});
			expect(badPut.statusCode).toBe(400);

			// Symlinked ancestor directory & dangling symlink refused on save
			const outside = mkTempDir("pipaya-wv-out-");
			symlinkSync(outside, join(repo, "ext-link"));
			symlinkSync(join(outside, "dangling.txt"), join(repo, "dangling-link.txt"));
			expect(safeInsideRoot(repo, "ext-link/new-file.txt")).toBeNull();
			expect(safeInsideRoot(repo, "dangling-link.txt")).toBeNull();
			const symDirPut = await app.inject({
				method: "PUT",
				url: "/sessions/s1/workspace/file",
				payload: { path: "ext-link/new-file.txt", content: "nope" },
			});
			expect(symDirPut.statusCode).toBe(400);
			const danglingPut = await app.inject({
				method: "PUT",
				url: "/sessions/s1/workspace/file",
				payload: { path: "dangling-link.txt", content: "nope" },
			});
			expect(danglingPut.statusCode).toBe(400);
		} finally {
			await app.close();
			db.close();
		}
	});

	test("handles non-git working directory gracefully", async () => {
		const dir = mkTempDir("pipaya-wv-nogit-");
		writeFileSync(join(dir, "note.txt"), "plain text\n");
		const { app, db } = await setupServer(dir);
		try {
			const res = await app.inject({ method: "GET", url: "/sessions/s1/workspace/tree" });
			expect(res.statusCode).toBe(200);
			const data = res.json();
			expect(data.isRepo).toBe(false);
			expect(data.changes).toEqual([]);
			expect(data.entries.map((e: { name: string }) => e.name)).toEqual(["note.txt"]);
		} finally {
			await app.close();
			db.close();
		}
	});
});
