import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import { branchOf, repoOf } from "../src/git-info.ts";

const TOKEN = "git-info-test-token-0123456789abcd";
let dir: string;
let main: string;
let wt: string;
let plain: string;
let sub: string;
let app: App;

/** A main checkout on `main` and a worktree of it on `feat/x`, laid out the way git writes them. */
beforeAll(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-git-")));
	main = join(dir, "app");
	wt = join(dir, "app-x");
	plain = join(dir, "notes");
	sub = join(main, "vendor/lib");
	mkdirSync(join(main, ".git/worktrees/app-x"), { recursive: true });
	mkdirSync(join(main, "client/src"), { recursive: true });
	writeFileSync(join(main, ".git/HEAD"), "ref: refs/heads/main\n");
	mkdirSync(wt);
	writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git/worktrees/app-x")}\n`);
	writeFileSync(join(main, ".git/worktrees/app-x/HEAD"), "ref: refs/heads/feat/x\n");
	writeFileSync(join(main, ".git/worktrees/app-x/commondir"), "../..\n");
	// a submodule: its `.git` points into the parent's modules, with no commondir
	mkdirSync(join(main, ".git/modules/lib"), { recursive: true });
	writeFileSync(join(main, ".git/modules/lib/HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
	mkdirSync(sub, { recursive: true });
	writeFileSync(join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
	mkdirSync(plain);
	app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: TOKEN, workspaceRoot: dir, logLevel: "silent" }, { strictResponses: true });
});
afterAll(async () => {
	await app.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("repoOf", () => {
	test("the main checkout and its worktree name the same root, each with its own branch", () => {
		expect(repoOf(main, "/nowhere")).toEqual({ root: main, top: main, branch: "main" });
		expect(repoOf(wt, "/nowhere")).toEqual({ root: main, top: wt, branch: "feat/x" });
		expect(branchOf(wt)).toBe("feat/x");
	});
	test("a folder inside the repository belongs to it", () => {
		expect(repoOf(join(main, "client/src"), "/nowhere")).toEqual({ root: main, top: main, branch: "main" });
	});
	test("a submodule is its own repository; a detached HEAD has no branch", () => {
		expect(repoOf(sub, "/nowhere")).toEqual({ root: sub, top: sub, branch: null });
	});
	test("outside a repository, and a repository at home, are not repositories", () => {
		expect(repoOf(plain, "/nowhere")).toBeNull();
		expect(repoOf(main, main)).toBeNull();
		expect(repoOf(join(dir, "missing"), "/nowhere")).toBeNull();
	});
});

describe("POST /fs/repos", () => {
	const post = async (body: unknown) => {
		const r = await app.server.inject({ method: "POST", url: "/fs/repos", headers: { authorization: `Bearer ${TOKEN}` }, payload: body as object });
		return { status: r.statusCode, json: r.json() };
	};
	test("answers per folder", async () => {
		const r = await post({ paths: [main, wt, plain, "relative/path", "/"] });
		expect(r.status).toBe(200);
		expect(r.json.repos[main]).toEqual({ root: main, top: main, branch: "main" });
		expect(r.json.repos[wt]).toEqual({ root: main, top: wt, branch: "feat/x" });
		expect(r.json.repos[plain]).toBeNull();
		expect(r.json.repos["relative/path"]).toBeNull();
		expect(r.json.repos["/"]).toBeNull();
	});
	test("needs the token", async () => {
		const r = await app.server.inject({ method: "POST", url: "/fs/repos", payload: { paths: [main] } });
		expect(r.statusCode).toBe(401);
	});
});
