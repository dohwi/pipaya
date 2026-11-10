/**
 * The right sidebar's git panel data: the working directory of the session on screen, read from the server.
 *
 * No polling. It is read when the panel opens, when the session (or its folder) changes, and when the agent's turn ends
 * (`run_finished` in the chat store), which is when files are most likely to have changed. File diffs are read on click.
 */
import { viewport } from "./viewport.svelte";
import { app } from "./store.svelte";
import { gitFailure, type GitFailure } from "./git-error";
import { GIT_LIMITS } from "./git-limits";
import type { GitCommit, GitCommitDetail, GitDiff, GitStatus } from "./types";

/** The session whose folder the panel shows: the one on screen, and only when it is a chat (a terminal has no session). */
const target = () => app.readableId;

/** The full ref name of a branch of the picker, as the server's `ref` parameter wants it. */
export const refOf = (b: { name: string; remote: boolean }) => (b.remote ? `refs/remotes/${b.name}` : `refs/heads/${b.name}`);

class GitPanel {
	/** The reading on screen; `null` until the first answer for the current session. */
	status = $state<GitStatus | null>(null);
	loading = $state(false);
	/** Why the status could not be read: told apart so an old server gets a hint, not its raw "route not found". */
	error = $state<GitFailure | null>(null);
	/** The file whose diff is open, and the diff itself. */
	picked = $state<{ path: string; staged: boolean; commit?: string } | null>(null);
	/** The commit opened in the graph, once its files are read; `openCommit` is its hash straight away. */
	openCommit = $state<string | null>(null);
	commit = $state<GitCommitDetail | null>(null);
	commitLoading = $state(false);
	commitError = $state<string | null>(null);
	#commitSeq = 0;
	diff = $state<GitDiff | null>(null);
	diffLoading = $state(false);
	diffError = $state<string | null>(null);

	/** The session the current reading belongs to: a late answer for a session the user left is dropped. */
	#session: string | null = null;
	#seq = 0;
	/** Its own counter: a status refresh (which bumps `#seq`) must not orphan a diff that is still on its way. */
	#diffSeq = 0;

	/** The graph: its commits, whether older ones exist, which branch it follows ("" = all) and how many it asked for. */
	commits = $state<GitCommit[]>([]);
	more = $state(false);
	logRef = $state("");
	logLimit = $state<number>(GIT_LIMITS.commitsPage);
	logLoading = $state(false);
	logError = $state<string | null>(null);
	#logSeq = 0;

	/** Read the status of `id`'s working directory. `id` defaults to the session on screen. */
	async load(id: string | null = target(), signal?: AbortSignal) {
		if (!id) {
			this.#session = null;
			this.status = null;
			this.error = null;
			return;
		}
		const api = app.api;
		if (!api) return;
		const seq = ++this.#seq;
		// another session (or server): the old reading is not about this folder, so it goes at once instead of lingering
		if (this.#session !== id) {
			this.status = null;
			this.commits = [];
			this.more = false;
			this.logRef = "";
			this.logLimit = GIT_LIMITS.commitsPage;
			this.logError = null;
			this.close();
			this.closeCommit();
		}
		this.#session = id;
		this.loading = true;
		this.error = null;
		try {
			// the graph is read beside the status, not after it: two requests, one wait
			const log = this.loadLog(id, signal);
			const next = await api.gitStatus(id, signal);
			if (seq !== this.#seq) return;
			this.status = next;
			// a branch that has since been deleted: back to every branch
			if (this.logRef && !next.branches?.some((b) => refOf(b) === this.logRef)) {
				this.logRef = "";
				void this.loadLog(id, signal);
			}
			await log;
		} catch (e) {
			if (seq !== this.#seq || (e as Error).name === "AbortError") return;
			this.error = gitFailure(e);
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	/** Read the graph for the current branch filter and size. */
	async loadLog(id: string | null = this.#session, signal?: AbortSignal) {
		const api = app.api;
		if (!id || !api) return;
		const seq = ++this.#logSeq;
		this.logLoading = true;
		try {
			const next = await api.gitLog(id, { ...(this.logRef ? { ref: this.logRef } : {}), limit: this.logLimit }, signal);
			if (seq !== this.#logSeq) return;
			this.commits = next.commits;
			this.more = next.more;
			this.logError = null;
		} catch (e) {
			if (seq !== this.#logSeq || (e as Error).name === "AbortError") return;
			this.logError = (e as Error).message;
		} finally {
			if (seq === this.#logSeq) this.logLoading = false;
		}
	}

	/** Follow one branch ("" = all of them); the page size starts over. */
	selectRef(ref: string) {
		if (ref === this.logRef) return;
		this.logRef = ref;
		this.logLimit = GIT_LIMITS.commitsPage;
		this.closeCommit();
		void this.loadLog();
	}

	/** One more page, up to the cap. */
	showMore() {
		if (!this.more || this.logLimit >= GIT_LIMITS.commitsMax) return;
		this.logLimit = Math.min(this.logLimit + GIT_LIMITS.commitsPage, GIT_LIMITS.commitsMax);
		void this.loadLog();
	}

	/** Open one file's diff; clicking the open one again closes it. */
	async pick(file: { path: string; staged: boolean; commit?: string }) {
		if (this.picked?.path === file.path && this.picked.staged === file.staged && this.picked.commit === file.commit) {
			this.close();
			return;
		}
		this.picked = { path: file.path, staged: file.staged, ...(file.commit ? { commit: file.commit } : {}) };
		this.diff = null;
		this.diffError = null;
		const id = this.#session;
		const api = app.api;
		if (!id || !api) return;
		const seq = ++this.#diffSeq;
		this.diffLoading = true;
		try {
			const next = await api.gitDiff(id, file.path, file.staged, undefined, file.commit);
			if (seq !== this.#diffSeq) return;
			this.diff = next;
		} catch (e) {
			if (seq !== this.#diffSeq) return;
			this.diffError = (e as Error).message;
		} finally {
			if (seq === this.#diffSeq) this.diffLoading = false;
		}
	}

	/** Open one commit of the graph (clicking the open one closes it). */
	async toggleCommit(hash: string) {
		if (this.openCommit === hash) {
			this.closeCommit();
			return;
		}
		this.closeCommit();
		this.openCommit = hash;
		const id = this.#session;
		const api = app.api;
		if (!id || !api) return;
		const seq = ++this.#commitSeq;
		this.commitLoading = true;
		try {
			const next = await api.gitCommit(id, hash);
			if (seq !== this.#commitSeq) return;
			this.commit = next;
		} catch (e) {
			if (seq !== this.#commitSeq) return;
			this.commitError = (e as Error).message;
		} finally {
			if (seq === this.#commitSeq) this.commitLoading = false;
		}
	}

	closeCommit() {
		this.#commitSeq++;
		this.openCommit = null;
		this.commit = null;
		this.commitError = null;
		this.commitLoading = false;
		if (this.picked?.commit) this.close();
	}

	close() {
		this.#diffSeq++;
		this.picked = null;
		this.diff = null;
		this.diffError = null;
		this.diffLoading = false;
	}

	/** Forget everything (another server, or the panel closed). */
	reset() {
		this.#seq++;
		this.#logSeq++;
		this.#session = null;
		this.commits = [];
		this.more = false;
		this.logRef = "";
		this.logLimit = GIT_LIMITS.commitsPage;
		this.logLoading = false;
		this.logError = null;
		this.status = null;
		this.loading = false;
		this.error = null;
		this.close();
		this.closeCommit();
	}
}

export const gitPanel = new GitPanel();

/**
 * Keep the panel current without polling: read it when it opens, when the session on screen changes, and when the agent's
 * turn ends. The effect returns a teardown, so a session switch aborts the request it started.
 */
export function followGitPanel() {
	$effect(() => {
		if (!app.right.open || !app.api) return;
		// a sheet on a phone can be opened and closed without the stage behind it changing
		void viewport.narrow;
		const id = target();
		const chat = app.chatOf(id);
		// the run counter: a turn that ends bumps it, which re-reads the status
		void chat?.turns;
		if (!id) {
			gitPanel.reset();
			return;
		}
		const ctrl = new AbortController();
		void gitPanel.load(id, ctrl.signal);
		return () => ctrl.abort();
	});
}
