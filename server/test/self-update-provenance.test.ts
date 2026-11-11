import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfUpdater } from "../src/self-update.ts";

/**
 * The self-update against real git: a bare "remote", and a shallow checkout of it made the way install.sh makes one.
 * version.test.ts covers the decisions with a fake git; this file is here because the check rests on what git itself
 * answers from a shallow clone (`merge-base --is-ancestor` across a shallow boundary, `fetch --depth`, `--unshallow`).
 */
const hasGit = Bun.which("git") !== null;
const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_TERMINAL_PROMPT: "0" };

function git(cwd: string, ...args: string[]): string {
	const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...quiet }, stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

describe.skipIf(!hasGit)("self-update against a real shallow checkout", () => {
	let dir: string;
	let remote: string;
	let work: string;
	/** Commits on main, oldest first. */
	const main: string[] = [];
	let offBranch: string;
	let n = 0;

	/** One more commit in `work` on the branch that is checked out. */
	const commit = (version: string) => {
		writeFileSync(join(work, "server", "package.json"), JSON.stringify({ version }));
		writeFileSync(join(work, "server", "src", "index.ts"), `// ${++n}\n`);
		git(work, "add", "-A");
		git(work, "commit", "-q", "-m", `c${n}`);
		return git(work, "rev-parse", "HEAD");
	};
	/** Point the release tag on the remote at `sha`, as the release workflow (or anyone with push access) does. */
	const release = (sha: string) => git(remote, "update-ref", "refs/tags/latest", sha);

	/** A fresh install: one commit of `at`, on branch main, exactly what install.sh leaves behind. */
	const install = (at: string) => {
		const root = mkdtempSync(join(dir, "install-"));
		git(dir, "clone", "-q", "--depth", "1", "--branch", "main", `file://${remote}`, root);
		git(root, "fetch", "-q", "--depth", "1", "origin", at);
		git(root, "reset", "-q", "--hard", at);
		return root;
	};
	const updater = (root: string, env: Record<string, string> = {}) => {
		let restarted = false;
		const u = new SelfUpdater({ root, serverDir: join(root, "server"), cacheMs: 0, env: { ...process.env, ...quiet, PIPAYA_SELF_UPDATE: "1", ...env }, install: async () => true, restart: () => (restarted = true) });
		return { u, root, restarted: () => restarted, head: () => git(root, "rev-parse", "HEAD"), shallow: () => git(root, "rev-parse", "--is-shallow-repository") };
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-provenance-"));
		remote = join(dir, "remote.git");
		work = join(dir, "work");
		git(dir, "init", "-q", "--bare", "-b", "main", remote);
		// A commit named by its hash can be fetched, as GitHub allows.
		git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
		git(dir, "init", "-q", "-b", "main", work);
		mkdirSync(join(work, "server", "src"), { recursive: true });
		git(work, "remote", "add", "origin", remote);
		for (let i = 0; i < 700; i++) main.push(commit(`1.0.${i % 10}`));
		git(work, "push", "-q", "origin", "main");
		// Code that never went through main: pushed to another branch by someone with push access.
		git(work, "switch", "-q", "-c", "elsewhere", main[650]!);
		writeFileSync(join(work, "server", "src", "index.ts"), "// not reviewed\n");
		git(work, "add", "-A");
		git(work, "commit", "-q", "-m", "unreviewed");
		offBranch = git(work, "rev-parse", "HEAD");
		git(work, "push", "-q", "origin", "elsewhere");
		git(work, "switch", "-q", "main");
	}, 120_000);
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("a release a few commits behind the tip is installed, and the checkout stays shallow", async () => {
		release(main[690]!);
		const s = updater(install(main[600]!));
		expect(await s.u.apply()).toMatchObject({ from: main[600]!, to: main[690]! });
		expect(s.head()).toBe(main[690]!);
		expect(s.restarted()).toBe(true);
		expect(s.shallow()).toBe("true"); // a slice of history was enough
	}, 60_000);

	test("a release that is the tip of the branch is installed", async () => {
		release(main[699]!);
		const s = updater(install(main[600]!));
		expect(await s.u.apply()).toMatchObject({ to: main[699]! });
		expect(s.head()).toBe(main[699]!);
	}, 60_000);

	test("an old release, further back than the slices reach, is still found on the branch", async () => {
		release(main[40]!); // 659 commits behind the tip
		const s = updater(install(main[10]!));
		expect(await s.u.apply()).toMatchObject({ to: main[40]! });
		expect(s.head()).toBe(main[40]!);
	}, 60_000);

	test("a tag moved to a commit that is not on the branch is refused: the running code stays", async () => {
		release(offBranch);
		const s = updater(install(main[600]!));
		await expect(s.u.apply()).rejects.toMatchObject({ status: 409, code: "update_untrusted" });
		expect(s.head()).toBe(main[600]!);
		expect(s.restarted()).toBe(false);
		expect(readFileSync(join(s.root, "server", "src", "index.ts"), "utf8")).not.toContain("not reviewed"); // the files on disk are the old ones
		// The update is still offered afterwards (the tag did move), and refused again: nothing was cached as fine.
		expect((await s.u.status(true)).available).toBe(true);
		await expect(s.u.apply()).rejects.toMatchObject({ code: "update_untrusted" });
		expect(s.head()).toBe(main[600]!);
	}, 60_000);

	test("the same commit is accepted where that other branch is the release branch", async () => {
		release(offBranch);
		const s = updater(install(main[600]!), { PIPAYA_RELEASE_BRANCH: "elsewhere" });
		expect(await s.u.apply()).toMatchObject({ to: offBranch });
		expect(s.head()).toBe(offBranch);
	}, 60_000);

	test("a release branch that does not exist: nothing is changed", async () => {
		release(main[690]!);
		const s = updater(install(main[600]!), { PIPAYA_RELEASE_BRANCH: "no-such-branch" });
		await expect(s.u.apply()).rejects.toMatchObject({ status: 502, code: "update_unverified" });
		expect(s.head()).toBe(main[600]!);
		expect(s.restarted()).toBe(false);
	}, 60_000);
});
