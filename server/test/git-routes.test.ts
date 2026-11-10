import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { parseStatus, parseWorktrees } from "../src/git-routes.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let base: string;
let dir: string;
let repo: string;
let plain: string;
let upstream: EchoUpstream;
const auth = { authorization: "Bearer t" };
const api = async (method: string, path: string) => {
	const res = await fetch(base + path, { method, headers: auth });
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
const sh = (cmd: string[], cwd: string) => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
};
const sessionIn = async (cwd: string) =>
	((await (await fetch(base + "/sessions", {
		method: "POST",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({ cwd }),
	})).json()) as { id: string }).id;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-git-"));
	repo = join(dir, "repo");
	plain = join(dir, "plain");
	sh(["git", "init", "-q", repo], dir);
	sh(["git", "config", "user.email", "t@t"], repo);
	sh(["git", "config", "user.name", "t"], repo);
	writeFileSync(join(repo, "a.txt"), "one\n");
	writeFileSync(join(repo, "gone.txt"), "bye\n");
	sh(["git", "add", "-A"], repo);
	sh(["git", "commit", "-qm", "init"], repo);
	// one of each kind: unstaged edit, staged add, untracked, staged rename
	writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
	writeFileSync(join(repo, "staged.txt"), "new\n");
	sh(["git", "add", "staged.txt"], repo);
	writeFileSync(join(repo, "untracked.txt"), "loose\n");
	sh(["git", "mv", "gone.txt", "moved.txt"], repo);
	sh(["git", "worktree", "add", "-q", "-b", "side", join(dir, "wt")], repo);
	sh(["mkdir", "-p", plain], dir);

	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "t.db"), token: "t", workspaceRoot: dir, logLevel: "silent" };
	upstream = startEchoUpstream();
	app = await buildApp(cfg, { strictResponses: true });
	await app.server.listen({ host: "0.0.0.0", port: 0 });
	base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
	// a session needs a model to exist at all
	await fetch(base + "/configuration/providers/echo", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(echoProviderBody(upstream.baseUrl)) });
	await fetch(base + "/configuration/defaults", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ provider: "echo", model: ECHO_MODEL.id }) });
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("parseStatus", () => {
	test("reads the branch header, ahead/behind and every entry kind", () => {
		const raw = [
			"# branch.oid 1234567",
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +2 -3",
			"1 .M N... 100644 100644 100644 abc abc a.txt",
			"1 M. N... 100644 100644 100644 abc abc staged.txt",
			"2 R. N... 100644 100644 100644 abc abc R100 moved.txt",
			"gone.txt",
			"? untracked.txt",
			"",
		].join("\0");
		const s = parseStatus(raw);
		expect(s.branch).toBe("main");
		expect(s.upstream).toBe("origin/main");
		expect(s.ahead).toBe(2);
		expect(s.behind).toBe(3);
		expect(s.detached).toBe(false);
		expect(s.files.map((f) => [f.path, f.state, f.from])).toEqual([
			["moved.txt", "staged", "gone.txt"],
			["staged.txt", "staged", undefined],
			["a.txt", "unstaged", undefined],
			["untracked.txt", "untracked", undefined],
		]);
	});
	test("a detached head has no branch", () => {
		const s = parseStatus("# branch.oid abc\0# branch.head (detached)\0");
		expect(s.branch).toBeNull();
		expect(s.detached).toBe(true);
	});
	test("caps the list and says it was cut", () => {
		const raw = Array.from({ length: 400 }, (_, i) => `? f${i}.txt`).join("\0");
		const s = parseStatus(raw);
		expect(s.files.length).toBe(300);
		expect(s.truncated).toBe(true);
	});
});

describe("parseWorktrees", () => {
	test("reads the main worktree and a linked one", () => {
		const raw = [
			"worktree /a",
			"HEAD 111",
			"branch refs/heads/main",
			"",
			"worktree /b",
			"HEAD 222",
			"branch refs/heads/side",
			"",
		].join("\n");
		expect(parseWorktrees(raw)).toEqual([
			{ path: "/a", branch: "main", head: "111", bare: false, main: true },
			{ path: "/b", branch: "side", head: "222", bare: false, main: false },
		]);
	});
});

describe("GET /sessions/:id/git", () => {
	test("reports the changes of the session's working directory", async () => {
		const id = await sessionIn(repo);
		const { status, json } = await api("GET", `/sessions/${id}/git`);
		expect(status).toBe(200);
		expect(json.repo).toBe(true);
		expect(json.root).toBe(repo);
		expect(json.branch).toBe("main");
		expect(json.reason).toBeNull();
		const files = json.files.map((f: { path: string; state: string }) => [f.path, f.state]);
		expect(files).toContainEqual(["moved.txt", "staged"]);
		expect(files).toContainEqual(["staged.txt", "staged"]);
		expect(files).toContainEqual(["a.txt", "unstaged"]);
		expect(files).toContainEqual(["untracked.txt", "untracked"]);
		expect(json.worktrees.length).toBe(2);
		expect(json.worktrees[0].main).toBe(true);
		expect(json.worktrees.map((w: { branch: string }) => w.branch)).toContain("side");
	});
	test("a directory that is not a repository answers with an empty state, not an error", async () => {
		const id = await sessionIn(plain);
		const { status, json } = await api("GET", `/sessions/${id}/git`);
		expect(status).toBe(200);
		expect(json.repo).toBe(false);
		expect(json.reason).toBe("not-a-repo");
		expect(json.files).toEqual([]);
	});
	test("an unknown session is 404", async () => {
		expect((await api("GET", "/sessions/nope/git")).status).toBe(404);
	});
});

describe("GET /sessions/:id/git/diff", () => {
	test("an unstaged edit comes back as a unified diff", async () => {
		const id = await sessionIn(repo);
		const { status, json } = await api("GET", `/sessions/${id}/git/diff?path=a.txt`);
		expect(status).toBe(200);
		expect(json.patch).toContain("+two");
		expect(json.binary).toBe(false);
		expect(json.truncated).toBe(false);
	});
	test("an untracked file reads as an addition", async () => {
		const id = await sessionIn(repo);
		const { json } = await api("GET", `/sessions/${id}/git/diff?path=untracked.txt`);
		expect(json.patch).toContain("+loose");
	});
	test("the staged side of a rename shows the move", async () => {
		const id = await sessionIn(repo);
		const { json } = await api("GET", `/sessions/${id}/git/diff?path=moved.txt&staged=true`);
		expect(json.patch).toContain("moved.txt");
	});
	test("a path that walks out of the directory is refused", async () => {
		const id = await sessionIn(repo);
		expect((await api("GET", `/sessions/${id}/git/diff?path=../../etc/passwd`)).status).toBe(400);
		expect((await api("GET", `/sessions/${id}/git/diff?path=/etc/passwd`)).status).toBe(400);
	});
});
