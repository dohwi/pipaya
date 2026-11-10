import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { parseStatus, parseWorktrees, parseLog, parseBranches, sumNumstat, BRANCH_FORMAT, capBranches, GIT_LIMITS, once } from "../src/git-routes.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let base: string;
let dir: string;
let repo: string;
let plain: string;
let rich: string;
let mergeHash: string;
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
/** A repository with one commit, ready for the test to dirty. */
const initRepo = (name: string) => {
	const r = join(dir, name);
	sh(["git", "init", "-q", "-b", "main", r], dir);
	sh(["git", "config", "user.email", "t@t"], r);
	sh(["git", "config", "user.name", "t"], r);
	writeFileSync(join(r, "tracked.txt"), "a\nb\n");
	sh(["git", "add", "-A"], r);
	sh(["git", "commit", "-qm", "init"], r);
	return r;
};

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
	test("reads the branch header, ahead/behind and counts every entry kind", () => {
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
			"? other.txt",
			"u UU N... 100644 100644 100644 100644 a b c conflict.txt",
			"",
		].join("\0");
		const s = parseStatus(raw);
		expect(s.branch).toBe("main");
		expect(s.upstream).toBe("origin/main");
		expect(s.ahead).toBe(2);
		expect(s.behind).toBe(3);
		expect(s.detached).toBe(false);
		// the rename's second record ("gone.txt") is its old path, not a file of its own
		expect(s.counts).toEqual({ conflict: 1, staged: 2, unstaged: 1, untracked: 2 });
	});
	test("a file staged and edited again counts once, as staged", () => {
		expect(parseStatus("1 MM N... 100644 100644 100644 abc abc a.txt\0").counts).toEqual({ conflict: 0, staged: 1, unstaged: 0, untracked: 0 });
	});
	test("conflicts of every shape are conflicts", () => {
		const raw = ["1 UU N... 1 1 1 a b x", "1 AA N... 1 1 1 a b y", "1 DD N... 1 1 1 a b z", "1 .U N... 1 1 1 a b w"].join("\0");
		expect(parseStatus(raw).counts.conflict).toBe(4);
	});
	test("a path with spaces or a newline is one entry", () => {
		const raw = ["? a file with spaces.txt", "? two\nlines.txt", "1 .M N... 100644 100644 100644 abc abc dir/with space.txt"].join("\0");
		expect(parseStatus(raw).counts).toEqual({ conflict: 0, staged: 0, unstaged: 1, untracked: 2 });
	});
	test("a detached head has no branch", () => {
		const s = parseStatus("# branch.oid abc\0# branch.head (detached)\0");
		expect(s.branch).toBeNull();
		expect(s.detached).toBe(true);
	});
	test("nothing changed counts nothing", () => {
		expect(parseStatus("# branch.oid abc\0# branch.head main\0").counts).toEqual({ conflict: 0, staged: 0, unstaged: 0, untracked: 0 });
		expect(parseStatus("").counts).toEqual({ conflict: 0, staged: 0, unstaged: 0, untracked: 0 });
	});
	test("a hundred thousand entries are a loop, not a problem", () => {
		const raw = Array.from({ length: 100_000 }, (_, i) => (i % 2 ? `? f${i}.txt` : `1 .M N... 100644 100644 100644 abc abc f${i}.txt`)).join("\0");
		const t0 = performance.now();
		const s = parseStatus(raw);
		expect(performance.now() - t0).toBeLessThan(500);
		expect(s.counts).toEqual({ conflict: 0, staged: 0, unstaged: 50_000, untracked: 50_000 });
	});
});

describe("sumNumstat", () => {
	test("adds the counts, skips binary files and reads a rename's three records", () => {
		const raw = "3\t1\ta.txt\0-\t-\tbin.dat\0" + "2\t0\t\0old.txt\0new.txt\0" + "5\t0\tdir/with space.txt\0";
		expect(sumNumstat(raw)).toEqual({ add: 10, del: 1 });
	});
	test("empty input is zero", () => {
		expect(sumNumstat("")).toEqual({ add: 0, del: 0 });
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
	test("summarises the changes of the session's working directory", async () => {
		const id = await sessionIn(repo);
		const { status, json } = await api("GET", `/sessions/${id}/git`);
		expect(status).toBe(200);
		expect(json.repo).toBe(true);
		expect(json.root).toBe(repo);
		expect(json.branch).toBe("main");
		expect(json.reason).toBeNull();
		// staged: staged.txt and the rename; unstaged: a.txt; untracked: untracked.txt
		expect(json.counts).toEqual({ conflict: 0, staged: 2, unstaged: 1, untracked: 1 });
		expect(json.lines).toEqual({ add: 2, del: 0 });
		expect(json.worktrees.length).toBe(2);
		expect(json.worktrees[0].main).toBe(true);
		expect(json.worktrees.map((w: { branch: string }) => w.branch)).toContain("side");
	});
	test("the answer carries no file list and no history, whatever the size of the change", async () => {
		const id = await sessionIn(repo);
		const { json } = await api("GET", `/sessions/${id}/git`);
		expect(json.files).toBeUndefined();
		expect(json.commits).toBeUndefined();
	});
	test("a directory that is not a repository answers with an empty state, not an error", async () => {
		const id = await sessionIn(plain);
		const { status, json } = await api("GET", `/sessions/${id}/git`);
		expect(status).toBe(200);
		expect(json.repo).toBe(false);
		expect(json.reason).toBe("not-a-repo");
		expect(json.counts).toEqual({ conflict: 0, staged: 0, unstaged: 0, untracked: 0 });
		expect(json.lines).toBeNull();
	});
	test("an unknown session is 404", async () => {
		expect((await api("GET", "/sessions/nope/git")).status).toBe(404);
	});
	test("the removed routes are gone", async () => {
		const id = await sessionIn(repo);
		for (const p of ["git/diff?path=a.txt", "git/files", "git/commit?hash=deadbeef"]) expect((await api("GET", `/sessions/${id}/${p}`)).status).toBe(404);
	});
});

describe("parseLog", () => {
	test("reads hash, parents, refs and a subject", () => {
		const raw = "aaa\x1fbbb ccc\x1fAnn\x1f100\x1fHEAD -> main, tag: v1\x1fmerge it\x1e\nbbb\x1f\x1fBob\x1f50\x1f\x1froot\x1e\n";
		const [a, b] = parseLog(raw);
		expect(a).toEqual({ hash: "aaa", parents: ["bbb", "ccc"], author: "Ann", at: 100, refs: ["HEAD -> main", "tag: v1"], subject: "merge it" });
		expect(b!.parents).toEqual([]);
		expect(b!.refs).toEqual([]);
	});
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
	test("capBranches keeps the order and reports a cut", () => {
		const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}` }) as never);
		expect(capBranches(mk(GIT_LIMITS.branches))).toMatchObject({ cut: false });
		const r = capBranches(mk(GIT_LIMITS.branches + 5));
		expect(r.cut).toBe(true);
		expect(r.branches.length).toBe(GIT_LIMITS.branches);
	});
});

describe("git panel on a repository with history", () => {
	test("branches, upstream, stash and the counts", async () => {
		const id = await sessionIn(rich);
		const { status, json } = await api("GET", `/sessions/${id}/git`);
		expect(status).toBe(200);
		expect(json.branch).toBe("main");
		expect(json.ahead).toBe(4);
		expect(json.behind).toBe(0);
		expect(json.stashes).toBe(1);
		// bin.dat staged; renamed.txt edited
		expect(json.counts).toEqual({ conflict: 0, staged: 1, unstaged: 1, untracked: 0 });
		// the binary file has no line counts; the text edit adds one line
		expect(json.lines).toEqual({ add: 1, del: 0 });
		const names = json.branches.map((b: { name: string }) => b.name);
		expect(names[0]).toBe("main");
		expect(names).toContain("feature");
		expect(names).toContain("origin/main");
		expect(names).not.toContain("origin");
		expect(json.branches.find((b: { name: string }) => b.name === "main")).toMatchObject({ current: true, upstream: "origin/main", ahead: 4 });
		expect(json.branches.find((b: { name: string }) => b.name === "origin/main").remote).toBe(true);
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
		expect(json.counts).toEqual({ conflict: 0, staged: 0, unstaged: 0, untracked: 0 });
		const log = await api("GET", `/sessions/${id}/git/log`);
		expect(log.status).toBe(200);
		expect(log.json).toEqual({ commits: [], more: false });
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
		expect((await log("?limit=500")).status).toBe(400);
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

describe("a big working tree", () => {
	test("an untracked folder is counted by its files", async () => {
		const big = initRepo("big");
		sh(["mkdir", "-p", join(big, "deep/er")], big);
		for (let i = 0; i < 30; i++) writeFileSync(join(big, "deep/er", `n${i}.txt`), "x\n");
		writeFileSync(join(big, "tracked.txt"), "a\nb\nc\nd\n");
		const id = await sessionIn(big);
		const { json } = await api("GET", `/sessions/${id}/git`);
		expect(json.counts).toEqual({ conflict: 0, staged: 0, unstaged: 1, untracked: 30 });
		expect(json.lines).toEqual({ add: 2, del: 0 });
	});
	test("thousands of untracked files stay a few numbers, and the reply stays small", async () => {
		const big = initRepo("many");
		sh(["mkdir", "-p", join(big, "vendor")], big);
		for (let i = 0; i < 3000; i++) writeFileSync(join(big, "vendor", `v${i}.js`), "x\n");
		const id = await sessionIn(big);
		const res = await fetch(base + `/sessions/${id}/git`, { headers: auth });
		const text = await res.text();
		expect(JSON.parse(text).counts.untracked).toBe(3000);
		expect(text.length).toBeLessThan(2000);
	});
	test("past the limit the changed lines are skipped, not guessed", async () => {
		const many = initRepo("lines");
		const n = GIT_LIMITS.linesMaxFiles + 20;
		// the tracked files are made in one commit, then all edited: more tracked changes than the limit
		for (let i = 0; i < n; i++) writeFileSync(join(many, `t${i}.txt`), "a\n");
		sh(["git", "add", "-A"], many);
		sh(["git", "commit", "-qm", "many"], many);
		for (let i = 0; i < n; i++) writeFileSync(join(many, `t${i}.txt`), "a\nb\n");
		const id = await sessionIn(many);
		const { json } = await api("GET", `/sessions/${id}/git`);
		expect(json.counts.unstaged).toBe(n);
		expect(json.lines).toBeNull();
	}, 30_000);
	test("a repository that is all binary has zero lines, not an error", async () => {
		const r = initRepo("binary");
		writeFileSync(join(r, "b.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
		sh(["git", "add", "b.bin"], r);
		const id = await sessionIn(r);
		const { json } = await api("GET", `/sessions/${id}/git`);
		expect(json.counts.staged).toBe(1);
		expect(json.lines).toEqual({ add: 0, del: 0 });
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
