import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { parseStatus, parseWorktrees, parseLog, parseBranches, parseNumstat, parseNameStatus, BRANCH_FORMAT, capBranches, GIT_LIMITS, once } from "../src/git-routes.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let base: string;
let dir: string;
let repo: string;
let plain: string;
let rich: string;
let mergeHash: string;
let rootHash: string;
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

	// a second repository with history: a merge, a remote, an upstream that is ahead/behind, a stash, a binary file
	rich = join(dir, "rich");
	const remote = join(dir, "remote.git");
	sh(["git", "init", "-q", "--bare", "-b", "main", remote], dir);
	sh(["git", "init", "-q", "-b", "main", rich], dir);
	sh(["git", "config", "user.email", "t@t"], rich);
	sh(["git", "config", "user.name", "t"], rich);
	writeFileSync(join(rich, "a.txt"), "1\n2\n3\n");
	sh(["git", "add", "-A"], rich);
	sh(["git", "commit", "-qm", "root"], rich);
	sh(["git", "remote", "add", "origin", remote], rich);
	sh(["git", "push", "-q", "-u", "origin", "main"], rich);
	sh(["git", "checkout", "-qb", "feature"], rich);
	writeFileSync(join(rich, "b.txt"), "side\n");
	sh(["git", "add", "-A"], rich);
	sh(["git", "commit", "-qm", "feature: add b"], rich);
	sh(["git", "checkout", "-q", "main"], rich);
	writeFileSync(join(rich, "a.txt"), "1\n2\n3\n4\n");
	sh(["git", "commit", "-qam", "main: extend a"], rich);
	sh(["git", "merge", "-q", "--no-ff", "feature", "-m", "merge feature"], rich);
	sh(["git", "mv", "a.txt", "renamed.txt"], rich);
	sh(["git", "commit", "-qm", "rename a"], rich);
	// main is now 3 ahead of origin/main; stash one change, then leave a binary and a text edit in the tree
	writeFileSync(join(rich, "renamed.txt"), "stashed\n");
	sh(["git", "stash", "-q"], rich);
	writeFileSync(join(rich, "renamed.txt"), "1\n2\n3\n4\nfive\n");
	writeFileSync(join(rich, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
	sh(["git", "add", "bin.dat"], rich);
	mergeHash = Bun.spawnSync(["git", "log", "--merges", "-1", "--format=%H"], { cwd: rich }).stdout.toString().trim();
	rootHash = Bun.spawnSync(["git", "rev-list", "--max-parents=0", "HEAD"], { cwd: rich }).stdout.toString().trim();

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
		const raw = Array.from({ length: GIT_LIMITS.files + 100 }, (_, i) => `? f${i}.txt`).join("\0");
		const s = parseStatus(raw);
		expect(s.files.length).toBe(GIT_LIMITS.files);
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

test("parseLog reads hash, parents, refs and a subject", () => {
	const raw = "aaa\x1fbbb ccc\x1fAnn\x1f100\x1fHEAD -> main, tag: v1\x1fmerge it\x1e\nbbb\x1f\x1fBob\x1f50\x1f\x1froot\x1e\n";
	const [a, b] = parseLog(raw);
	expect(a).toEqual({ hash: "aaa", parents: ["bbb", "ccc"], author: "Ann", at: 100, refs: ["HEAD -> main", "tag: v1"], subject: "merge it" });
	expect(b!.parents).toEqual([]);
	expect(b!.refs).toEqual([]);
});

describe("parseBranches", () => {
	const line = (...f: (string | number)[]) => f.join("\x1f");
	test("reads upstream tracking, remote branches and the current one", () => {
		const raw = [
			line("refs/heads/main", "main", "*", "origin/main", "ahead 2, behind 1", 300, "aaa", "/r"),
			line("refs/heads/old", "old", " ", "origin/old", "gone", 100, "bbb", ""),
			line("refs/heads/wt", "wt", " ", "", "", 200, "ccc", "/elsewhere"),
			line("refs/remotes/origin/HEAD", "origin", " ", "", "", 300, "aaa", ""),
			line("refs/remotes/origin/main", "origin/main", " ", "", "", 250, "ddd", ""),
		].join("\n");
		const b = parseBranches(raw);
		expect(b.map((x) => x.name)).toEqual(["main", "wt", "old", "origin/main"]);
		expect(b[0]).toMatchObject({ current: true, ahead: 2, behind: 1, upstream: "origin/main", gone: false });
		expect(b[1]).toMatchObject({ elsewhere: true, current: false });
		expect(b[2]).toMatchObject({ gone: true, ahead: 0, behind: 0 });
		expect(b[3]).toMatchObject({ remote: true, elsewhere: false });
	});
	test("a repository with no branch yet has none", () => {
		expect(parseBranches("")).toEqual([]);
	});
	test("the format asks for the fields it reads", () => {
		expect(BRANCH_FORMAT.split("\x1f").length).toBe(8);
	});
});

describe("parseNumstat / parseNameStatus", () => {
	test("numstat keeps counts, skips binary and follows a rename to the new path", () => {
		const raw = "3\t1\ta.txt\0-\t-\tbin.dat\0" + "0\t0\t\0old.txt\0new.txt\0" + "5\t0\tdir/with space.txt\0";
		const m = parseNumstat(raw);
		expect(m.get("a.txt")).toEqual({ add: 3, del: 1 });
		expect(m.has("bin.dat")).toBe(false);
		expect(m.get("new.txt")).toEqual({ add: 0, del: 0 });
		expect(m.get("dir/with space.txt")).toEqual({ add: 5, del: 0 });
	});
	test("name-status reads plain and renamed entries", () => {
		expect(parseNameStatus("M\0a.txt\0R100\0old\0new\0A\0b\0")).toEqual([
			{ path: "a.txt", code: "M" },
			{ path: "new", from: "old", code: "R" },
			{ path: "b", code: "A" },
		]);
	});
	test("empty input is an empty list", () => {
		expect(parseNameStatus("")).toEqual([]);
		expect(parseNumstat("").size).toBe(0);
	});
});

describe("git panel on a repository with history", () => {
	test("branches, upstream, stash and line counts", async () => {
		const id = await sessionIn(rich);
		const { status, json } = await api("GET", `/sessions/${id}/git`);
		expect(status).toBe(200);
		expect(json.branch).toBe("main");
		expect(json.ahead).toBe(4);
		expect(json.behind).toBe(0);
		expect(json.stashes).toBe(1);
		const names = json.branches.map((b: { name: string }) => b.name);
		expect(names[0]).toBe("main");
		expect(names).toContain("feature");
		expect(names).toContain("origin/main");
		expect(names).not.toContain("origin");
		expect(json.branches.find((b: { name: string }) => b.name === "main")).toMatchObject({ current: true, upstream: "origin/main", ahead: 4 });
		expect(json.branches.find((b: { name: string }) => b.name === "origin/main").remote).toBe(true);
		const edit = json.files.find((f: { path: string }) => f.path === "renamed.txt");
		expect(edit).toMatchObject({ state: "unstaged", add: 1, del: 0 });
		// a staged binary has no line counts
		const bin = json.files.find((f: { path: string }) => f.path === "bin.dat");
		expect(bin.state).toBe("staged");
		expect(bin.add).toBeUndefined();
	});
	test("the status no longer carries the history (it has its own route)", async () => {
		const id = await sessionIn(rich);
		const { json } = await api("GET", `/sessions/${id}/git`);
		expect(json.commits).toBeUndefined();
		expect(json.branchesCut).toBe(false);
	});
	test("a repository without a commit has an empty graph and no error", async () => {
		const fresh = join(dir, "fresh");
		sh(["git", "init", "-q", "-b", "main", fresh], dir);
		const id = await sessionIn(fresh);
		const { status, json } = await api("GET", `/sessions/${id}/git`);
		expect(status).toBe(200);
		expect(json.repo).toBe(true);
		expect(json.branches).toEqual([]);
		expect(json.stashes).toBe(0);
		const log = await api("GET", `/sessions/${id}/git/log`);
		expect(log.status).toBe(200);
		expect(log.json).toEqual({ commits: [], more: false });
	});
});

describe("GET /sessions/:id/git/commit", () => {
	test("a merge lists what it brought in against its first parent", async () => {
		const id = await sessionIn(rich);
		const { status, json } = await api("GET", `/sessions/${id}/git/commit?hash=${mergeHash}`);
		expect(status).toBe(200);
		expect(json.subject).toBe("merge feature");
		expect(json.parents.length).toBe(2);
		expect(json.files).toEqual([{ path: "b.txt", code: "A", add: 1, del: 0 }]);
		expect(json.truncated).toBe(false);
	});
	test("the root commit lists every file it added", async () => {
		const id = await sessionIn(rich);
		const { json } = await api("GET", `/sessions/${id}/git/commit?hash=${rootHash}`);
		expect(json.parents).toEqual([]);
		expect(json.files).toEqual([{ path: "a.txt", code: "A", add: 3, del: 0 }]);
	});
	test("a rename carries its old path", async () => {
		const id = await sessionIn(rich);
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: rich }).stdout.toString().trim();
		const { json } = await api("GET", `/sessions/${id}/git/commit?hash=${head}`);
		expect(json.files).toEqual([{ path: "renamed.txt", from: "a.txt", code: "R", add: 0, del: 0 }]);
	});
	test("a hash that is not a hash is 400, an unknown one is 404", async () => {
		const id = await sessionIn(rich);
		expect((await api("GET", `/sessions/${id}/git/commit?hash=--output=x`)).status).toBe(400);
		expect((await api("GET", `/sessions/${id}/git/commit?hash=deadbeef`)).status).toBe(404);
		expect((await api("GET", `/sessions/nope/git/commit?hash=deadbeef`)).status).toBe(404);
	});
	test("one file of a commit comes back as a diff", async () => {
		const id = await sessionIn(rich);
		const { status, json } = await api("GET", `/sessions/${id}/git/diff?path=b.txt&commit=${mergeHash}`);
		expect(status).toBe(200);
		expect(json.patch).toContain("+side");
		expect(json.staged).toBe(false);
	});
});

describe("GET /sessions/:id/git/log", () => {
	const log = async (q = "") => api("GET", `/sessions/${await sessionIn(rich)}/git/log${q}`);
	test("the merge has two parents and children come before parents", async () => {
		const { status, json } = await log();
		expect(status).toBe(200);
		const merge = json.commits.find((c: { hash: string }) => c.hash === mergeHash);
		expect(merge.parents.length).toBe(2);
		expect(merge.subject).toBe("merge feature");
		const at = (h: string) => json.commits.findIndex((c: { hash: string }) => c.hash === h);
		for (const c of json.commits as { hash: string; parents: string[] }[]) for (const p of c.parents) expect(at(p)).toBeGreaterThan(at(c.hash));
		expect(json.commits[0].refs.some((r: string) => r.startsWith("HEAD -> main"))).toBe(true);
		expect(json.more).toBe(false);
	});
	test("the stash's own commits are not history", async () => {
		const { json } = await log();
		expect(json.commits.some((c: { subject: string }) => /^(WIP|index) on /.test(c.subject))).toBe(false);
	});
	test("limit cuts the page and says there is more", async () => {
		const { json } = await log("?limit=2");
		expect(json.commits.length).toBe(2);
		expect(json.more).toBe(true);
		const all = (await log("?limit=500")).status;
		expect(all).toBe(400);
		expect((await log("?limit=0")).status).toBe(400);
	});
	test("a branch shows only its own history", async () => {
		const { json } = await log("?ref=refs/heads/feature");
		expect(json.commits.map((c: { subject: string }) => c.subject)).toEqual(["feature: add b", "root"]);
	});
	test("a remote-tracking branch works too", async () => {
		const { status, json } = await log("?ref=refs/remotes/origin/main");
		expect(status).toBe(200);
		expect(json.commits.map((c: { subject: string }) => c.subject)).toEqual(["root"]);
	});
	test("anything that is not a branch name is refused", async () => {
		for (const ref of ["--all", "HEAD", "main", "refs/heads/../x", "refs/heads/a..b", "refs/heads/x@{1}", "refs/heads/-x y", "refs/tags/v1", "--output=/tmp/x"]) {
			expect((await log(`?ref=${encodeURIComponent(ref)}`)).status).toBe(400);
		}
		expect((await log("?ref=refs/heads/nope")).status).toBe(404);
	});
	test("an unknown session is 404", async () => {
		expect((await api("GET", "/sessions/nope/git/log")).status).toBe(404);
	});
});

describe("limits", () => {
	test("capBranches keeps the order and reports a cut", () => {
		const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}` }) as never);
		expect(capBranches(mk(GIT_LIMITS.branches))).toMatchObject({ cut: false });
		const r = capBranches(mk(GIT_LIMITS.branches + 5));
		expect(r.cut).toBe(true);
		expect(r.branches.length).toBe(GIT_LIMITS.branches);
	});
	test("a status with more files than the cap is cut and says so", () => {
		const raw = Array.from({ length: GIT_LIMITS.files + 20 }, (_, i) => `? f${i}.txt`).join("\0");
		const s = parseStatus(raw);
		expect(s.files.length).toBe(GIT_LIMITS.files);
		expect(s.truncated).toBe(true);
	});
});

describe("a big working tree", () => {
	const untracked = (n: number, prefix = "f") => Array.from({ length: n }, (_, i) => `? ${prefix}${i}.txt`);
	test("counts every file by kind before the cap cuts the list", () => {
		const raw = [
			...untracked(250),
			"1 .M N... 100644 100644 100644 abc abc a.txt",
			"1 M. N... 100644 100644 100644 abc abc zzz-staged.txt",
			"u UU N... 100644 100644 100644 100644 a b c conflict.txt",
		].join("\0");
		const s = parseStatus(raw, 10);
		expect(s.counts).toEqual({ conflict: 1, staged: 1, unstaged: 1, untracked: 250, add: 0, del: 0 });
		expect(s.files.length).toBe(10);
		expect(s.truncated).toBe(true);
	});
	test("the cut keeps what matters: conflicts, then staged, then unstaged, then untracked", () => {
		// `zzz-staged` is read last and sorts last by name, and used to be the one thrown away
		const raw = [...untracked(250, "a"), "1 M. N... 100644 100644 100644 abc abc zzz-staged.txt", "1 .M N... 100644 100644 100644 abc abc zzz-edit.txt"].join("\0");
		const s = parseStatus(raw, 5);
		expect(s.files.map((f) => f.state)).toEqual(["staged", "unstaged", "untracked", "untracked", "untracked"]);
		expect(s.files[0]!.path).toBe("zzz-staged.txt");
	});
	test("paths sort by code unit, the same on every machine", () => {
		const s = parseStatus(["? b.txt", "? B.txt", "? a.txt", "? \u00e4.txt"].join("\0"));
		expect(s.files.map((f) => f.path)).toEqual(["B.txt", "a.txt", "b.txt", "\u00e4.txt"]);
	});
	test("a list under the cap is not truncated", () => {
		const s = parseStatus(untracked(GIT_LIMITS.files).join("\0"));
		expect(s.truncated).toBe(false);
		expect(s.files.length).toBe(GIT_LIMITS.files);
	});
	test("parsing thousands of entries stays fast", () => {
		const raw = untracked(20000).join("\0");
		const t0 = performance.now();
		const s = parseStatus(raw);
		expect(performance.now() - t0).toBeLessThan(500);
		expect(s.counts.untracked).toBe(20000);
	});
	test("an untracked folder is listed as its files and the totals cover every file", async () => {
		const big = join(dir, "big");
		sh(["git", "init", "-q", "-b", "main", big], dir);
		sh(["git", "config", "user.email", "t@t"], big);
		sh(["git", "config", "user.name", "t"], big);
		writeFileSync(join(big, "tracked.txt"), "a\nb\n");
		sh(["git", "add", "-A"], big);
		sh(["git", "commit", "-qm", "init"], big);
		sh(["mkdir", "-p", join(big, "deep/er")], big);
		for (let i = 0; i < 30; i++) writeFileSync(join(big, "deep/er", `n${i}.txt`), "x\n");
		writeFileSync(join(big, "tracked.txt"), "a\nb\nc\nd\n");
		const id = await sessionIn(big);
		const { json } = await api("GET", `/sessions/${id}/git`);
		expect(json.counts).toMatchObject({ untracked: 30, unstaged: 1, staged: 0, add: 2, del: 0 });
		const paths = json.files.map((f: { path: string }) => f.path);
		expect(paths).toContain("deep/er/n0.txt");
		expect(paths.some((p: string) => p.endsWith("/"))).toBe(false);
		// the folder's file opens as a diff (it used to be a bare `deep/` that answered with nothing)
		const d = await api("GET", `/sessions/${id}/git/diff?path=deep/er/n0.txt`);
		expect(d.json.patch).toContain("+x");
	});
});

describe("once", () => {
	test("overlapping identical calls share one run, and a finished one is never reused", async () => {
		let runs = 0;
		const work = async () => {
			const mine = ++runs;
			await new Promise((r) => setTimeout(r, 20));
			return mine;
		};
		const [a, b, c] = await Promise.all([once("k", work), once("k", work), once("other", work)]);
		expect(a).toBe(b);
		expect(c).not.toBe(a);
		expect(runs).toBe(2);
		expect(await once("k", work)).toBe(3);
	});
	test("a failure is shared by the callers that were waiting and does not stick", async () => {
		const boom = async () => {
			await new Promise((r) => setTimeout(r, 10));
			throw new Error("boom");
		};
		const results = await Promise.allSettled([once("f", boom), once("f", boom)]);
		expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		expect(await once("f", async () => "ok")).toBe("ok");
	});
});

describe("GET /sessions/:id/git/files", () => {
	test("searches the whole working tree by words in the path, past the status cap", async () => {
		const wide = join(dir, "wide");
		sh(["git", "init", "-q", "-b", "main", wide], dir);
		sh(["git", "config", "user.email", "t@t"], wide);
		sh(["git", "config", "user.name", "t"], wide);
		writeFileSync(join(wide, "base.txt"), "x\n");
		sh(["git", "add", "-A"], wide);
		sh(["git", "commit", "-qm", "init"], wide);
		sh(["mkdir", "-p", join(wide, "pkg/one"), join(wide, "pkg/two")], wide);
		for (let i = 0; i < GIT_LIMITS.files + 50; i++) writeFileSync(join(wide, i % 2 ? "pkg/one" : "pkg/two", `f${String(i).padStart(4, "0")}.txt`), "x\n");
		writeFileSync(join(wide, "zz-needle.txt"), "n\n");
		const id = await sessionIn(wide);
		const status = (await api("GET", `/sessions/${id}/git`)).json;
		expect(status.counts.untracked).toBe(GIT_LIMITS.files + 51);
		expect(status.truncated).toBe(true);
		expect(status.files.length).toBe(GIT_LIMITS.files);
		// the needle sorts last, so the status page does not hold it
		expect(status.files.some((f: { path: string }) => f.path === "zz-needle.txt")).toBe(false);
		const found = (await api("GET", `/sessions/${id}/git/files?q=NEEDLE`)).json;
		expect(found.files.map((f: { path: string }) => f.path)).toEqual(["zz-needle.txt"]);
		expect(found.matched).toBe(1);
		expect(found.truncated).toBe(false);
		const words = (await api("GET", `/sessions/${id}/git/files?q=${encodeURIComponent("one f01")}`)).json;
		expect(words.matched).toBeGreaterThan(0);
		expect(words.files.every((f: { path: string }) => f.path.includes("one") && f.path.includes("f01"))).toBe(true);
		const none = (await api("GET", `/sessions/${id}/git/files?q=nothing-like-this`)).json;
		expect(none).toEqual({ files: [], matched: 0, truncated: false });
		const kind = (await api("GET", `/sessions/${id}/git/files?kind=staged`)).json;
		expect(kind.matched).toBe(0);
	});
	test("a folder that is not a repository, and a bad kind", async () => {
		const id = await sessionIn(plain);
		expect((await api("GET", `/sessions/${id}/git/files?q=x`)).json).toEqual({ files: [], matched: 0, truncated: false });
		expect((await api("GET", `/sessions/${id}/git/files?kind=bogus`)).status).toBe(400);
		expect((await api("GET", "/sessions/nope/git/files")).status).toBe(404);
	});
	test("a query that is all spaces lists everything", async () => {
		const id = await sessionIn(rich);
		const all = (await api("GET", `/sessions/${id}/git/files?q=%20%20`)).json;
		expect(all.matched).toBeGreaterThan(0);
		expect(all.truncated).toBe(false);
	});
});
