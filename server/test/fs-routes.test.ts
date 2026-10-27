import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import { isPathQuery, splitPathQuery } from "../src/fs-routes.ts";

const TOKEN = "fs-routes-test-token-0123456789abc";
let dir: string;
let root: string;
let outside: string;
let app: App;

const get = async (url: string) => {
	const r = await app.server.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};
const files = (q: string, extra = "") => get(`/fs/files?cwd=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}${extra}`);
const paths = (r: { json: { entries: { path: string }[] } }) => r.json.entries.map((e) => e.path);

beforeAll(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-fs-")));
	root = join(dir, "project");
	outside = join(dir, "outside");
	for (const d of ["src/components", "node_modules/dep", ".git", "docs"]) mkdirSync(join(root, d), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(root, "src/components/Composer.svelte"), "");
	writeFileSync(join(root, "src/app.ts"), "");
	writeFileSync(join(root, "node_modules/dep/index.js"), "");
	writeFileSync(join(root, ".git/HEAD"), "");
	writeFileSync(join(root, "README.md"), "");
	writeFileSync(join(outside, "secret.txt"), "");
	symlinkSync(outside, join(root, "link-out"));
	app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: TOKEN, workspaceRoot: root, logLevel: "silent" }, { strictResponses: true });
});
afterAll(async () => {
	await app.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("/fs/files", () => {
	test("lists shallow entries first, folders before files, and skips dependency and VCS folders", async () => {
		const list = paths(await files(""));
		expect(list).toContain("src/");
		expect(list).toContain("README.md");
		expect(list.some((p) => p.startsWith("node_modules") || p.startsWith(".git"))).toBe(false);
		expect(list.indexOf("src/")).toBeLessThan(list.indexOf("src/app.ts"));
	});

	test("never follows a symlink out of the project", async () => {
		const everything = [...paths(await files("", "&limit=100")), ...paths(await files("secret.txt")), ...paths(await files("link"))];
		expect(everything.some((p) => p.includes("secret.txt"))).toBe(false);
		expect(everything.some((p) => p.startsWith("link-out/"))).toBe(false);
	});

	test("ranks a name prefix above a loose match, and accepts a subsequence like 'cmps'", async () => {
		const byName = paths(await files("app"));
		expect(byName[0]).toBe("src/app.ts");
		expect(paths(await files("cmps"))).toContain("src/components/Composer.svelte");
	});

	test("honours the limit", async () => {
		expect((await files("", "&limit=2")).json.entries.length).toBeLessThanOrEqual(2);
	});

	test("a relative or missing cwd is a 400, not a crash", async () => {
		expect((await get("/fs/files?cwd=relative/dir")).status).toBe(400);
		expect((await get(`/fs/files?cwd=${encodeURIComponent(join(root, "nope"))}`)).status).toBe(400);
	});

	test("a path query lists one folder at a time and keeps what the user typed", async () => {
		const r = await files("src/comp");
		expect(paths(r)).toContain("src/components/");
		const up = await files("../");
		expect(paths(up).every((p) => p.startsWith("../"))).toBe(true);
	});

	test("an unfinished path query returns nothing instead of an error", async () => {
		const r = await files("/definitely/not/a/folder/x");
		expect(r.status).toBe(200);
		expect(paths(r)).toEqual([]);
	});
});

describe("path query helpers", () => {
	test("only ~, .., ~/x, /x and ../x leave the working directory", () => {
		for (const q of ["~", "..", "~/work", "/etc", "../x"]) expect(isPathQuery(q)).toBe(true);
		for (const q of ["src", "a/../b", "", "..x", "~x"]) expect(isPathQuery(q)).toBe(false);
	});

	test("splitPathQuery separates the folder, the kept prefix and the filter", () => {
		expect(splitPathQuery("../sr", "/a/b")).toEqual({ dir: "/a", prefix: "../", filter: "sr" });
		expect(splitPathQuery("..", "/a/b")).toEqual({ dir: "/a", prefix: "../", filter: "" });
	});
});
