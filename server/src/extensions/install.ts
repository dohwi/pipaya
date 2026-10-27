import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_ID_PATTERN as ID } from "../extension-settings.ts";

export interface GitSource {
	/** `owner/name` on the git host. */
	repo: string;
	/** Which host serves it; omitted = `github.com`. Only hosts the operator listed (`PIPAYA_EXTENSION_HOSTS`) are accepted. */
	host?: string;
	dir?: string;
	ref: string;
	commit: string;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const DEFAULT_GIT_HOST = "github.com";

/** Hosts extensions may be fetched from: GitHub always, plus the comma-separated `PIPAYA_EXTENSION_HOSTS` of the operator (a self-hosted GitLab, Gitea...). */
export function allowedGitHosts(env: Record<string, string | undefined> = process.env): string[] {
	const extra = (env.PIPAYA_EXTENSION_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => HOST.test(h));
	return [...new Set([DEFAULT_GIT_HOST, ...extra])];
}
const REF = /^\w[\w./-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIR = /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*$/;

/**
 * Deletes what `installFromGit` (or a hand-copied file) put under `extensionsDir` for `id`. With `keepSettings` the
 * shared settings of the id stay behind (`settings.json`, see extension-settings.ts). Returns false when nothing was there.
 */
export function removeInstalled(id: string, extensionsDir: string, keepSettings: boolean): boolean {
	if (!/^[\w.-]+$/.test(id) || id.startsWith(".")) throw new Error("invalid extension name");
	const dir = join(extensionsDir, id);
	let found = false;
	if (existsSync(dir)) {
		found = true;
		const settings = join(dir, "settings.json");
		const kept = keepSettings && existsSync(settings) ? readFileSync(settings) : undefined;
		rmSync(dir, { recursive: true, force: true });
		if (kept) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(settings, kept, { mode: 0o600 }); }
	}
	for (const ext of [".ts", ".js", ".mjs"]) {
		const file = join(extensionsDir, id + ext);
		if (existsSync(file)) { found = true; rmSync(file, { force: true }); }
	}
	return found;
}

/** Fetch the tag and refuse it when it no longer points at the pinned commit. */
export async function installFromGit(id: string, src: GitSource, extensionsDir: string, hosts: readonly string[] = allowedGitHosts()): Promise<string> {
	const host = (src.host ?? DEFAULT_GIT_HOST).toLowerCase();
	if (!HOST.test(host) || !hosts.includes(host)) throw new Error(`invalid source: host ${host} is not allowed (PIPAYA_EXTENSION_HOSTS)`);
	if (!ID.test(id) || !REPO.test(src.repo) || !REF.test(src.ref) || !COMMIT.test(src.commit) || (src.dir !== undefined && !DIR.test(src.dir))) throw new Error("invalid source");
	const tmp = mkdtempSync(join(tmpdir(), "pipaya-ext-"));
	try {
		const git = async (...args: string[]) => {
			const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
			const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
			return { code: await p.exited, out: out.trim(), err: err.trim() };
		};
		const cloned = await git("clone", "--quiet", "--depth", "1", "--branch", src.ref, `https://${host}/${src.repo}.git`, tmp);
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
		// The shared settings of this id live in the same folder (extension-settings.ts): an update keeps them.
		const settings = join(to, "settings.json");
		if (existsSync(settings)) cpSync(settings, join(staging, "settings.json"));
		rmSync(to, { recursive: true, force: true });
		renameSync(staging, to);
		return to;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
