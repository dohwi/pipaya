/**
 * What git says about a folder, read from the files under `.git` without starting git (it may not be installed, and a
 * sidebar asking about every folder must not spawn a process per folder). Anything unreadable is simply "not a repository".
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** How far up from a folder `.git` is looked for. */
const MAX_DEPTH = 12;

export interface RepoInfo {
	/** The repository's main working tree: the same for the main checkout and every worktree of it */
	root: string;
	/** The working tree holding the folder: the main checkout, or the worktree it is in */
	top: string;
	/** The checked-out branch, null when HEAD is detached */
	branch: string | null;
}

/** The `.git` of the nearest repository holding `cwd`: the folder it sits in, and the git directory it points at. */
function findGit(cwd: string): { dir: string; gitDir: string; linked: boolean } | null {
	for (let dir = resolve(cwd), i = 0; i < MAX_DEPTH; i++, dir = dirname(dir)) {
		const dot = join(dir, ".git");
		if (existsSync(dot)) {
			if (!statSync(dot).isFile()) return { dir, gitDir: dot, linked: false };
			// a worktree or a submodule: `.git` is a file naming the real git directory
			const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
			if (!target) return null;
			return { dir, gitDir: isAbsolute(target) ? target : resolve(dir, target), linked: true };
		}
		if (dirname(dir) === dir) break;
	}
	return null;
}

const headBranch = (gitDir: string) => /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, "HEAD"), "utf8"))?.[1]?.trim() ?? null;

/** The checked-out branch of the repository holding `cwd` (a worktree too), read from HEAD without starting git. */
export function branchOf(cwd: string): string | null {
	try {
		const g = findGit(cwd);
		return g ? headBranch(g.gitDir) : null;
	} catch {
		return null;
	}
}

/**
 * The repository holding `cwd`: its main working tree (so a worktree and its main checkout name the same root) and the
 * branch checked out here. Null outside a repository, and for a repository at the home folder itself (dotfiles kept in
 * git would otherwise pull every folder under home into one project).
 */
export function repoOf(cwd: string, home = homedir()): RepoInfo | null {
	try {
		const g = findGit(cwd);
		if (!g) return null;
		let root = g.dir;
		if (g.linked) {
			// a worktree's git directory says where the shared one is (`commondir`); a submodule's has none and stands alone
			const common = join(g.gitDir, "commondir");
			if (existsSync(common)) {
				const shared = resolve(g.gitDir, readFileSync(common, "utf8").trim());
				root = basename(shared) === ".git" ? dirname(shared) : shared; // a bare repository has no working tree: its own path
			}
		}
		if (resolve(root) === resolve(home)) return null;
		return { root, top: g.dir, branch: headBranch(g.gitDir) };
	} catch {
		return null;
	}
}
