import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitSource {
	repo: string;
	dir?: string;
	ref: string;
	commit: string;
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const REF = /^\w[\w./-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIR = /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*$/;

/** Same checks as `scripts/market.ts install`: fetch the tag, refuse it when it no longer points at the pinned commit. */
export async function installFromGit(id: string, src: GitSource, extensionsDir: string): Promise<string> {
	if (!ID.test(id) || !REPO.test(src.repo) || !REF.test(src.ref) || !COMMIT.test(src.commit) || (src.dir !== undefined && !DIR.test(src.dir))) throw new Error("invalid source");
	const tmp = mkdtempSync(join(tmpdir(), "pipaya-ext-"));
	try {
		const git = async (...args: string[]) => {
			const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
			const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
			return { code: await p.exited, out: out.trim(), err: err.trim() };
		};
		const cloned = await git("clone", "--quiet", "--depth", "1", "--branch", src.ref, `https://github.com/${src.repo}.git`, tmp);
		if (cloned.code !== 0) throw new Error(`clone failed: ${cloned.err}`);
		const head = (await git("-C", tmp, "rev-parse", "HEAD")).out;
		if (head !== src.commit) throw new Error(`${src.repo}@${src.ref} is at ${head}, the catalog lists ${src.commit}; refusing to install`);
		const from = src.dir ? join(tmp, src.dir) : tmp;
		if (!existsSync(join(from, "package.json"))) throw new Error(`${src.repo}@${src.ref} has no ${src.dir ?? "."}/package.json`);
		mkdirSync(extensionsDir, { recursive: true });
		const to = join(extensionsDir, id);
		const staging = `${to}.installing`;
		rmSync(staging, { recursive: true, force: true });
		cpSync(from, staging, { recursive: true, filter: (f) => !/(^|\/)(\.git|node_modules|tests)(\/|$)/.test(f.slice(from.length)) });
		rmSync(to, { recursive: true, force: true });
		renameSync(staging, to);
		return to;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
