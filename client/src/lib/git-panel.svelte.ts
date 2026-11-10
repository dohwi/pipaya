/**
 * The right sidebar's git panel data: the working directory of the session on screen, read from the server.
 *
 * No polling. It is read when the panel opens, when the session (or its folder) changes, and when the agent's turn ends
 * (`run_finished` in the chat store), which is when files are most likely to have changed. What it reads is small whatever
 * the repository: numbers for the changes, one capped page for the graph.
 */
import { viewport } from "./viewport.svelte";
import { app } from "./store.svelte";
import { gitFailure, type GitFailure } from "./git-error";
import { GIT_LIMITS } from "./git-limits";
import type { GitCommit, GitStatus } from "./types";

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

	/** The graph: its commits, whether older ones exist, which branch it follows ("" = all) and how many it asked for. */
	commits = $state<GitCommit[]>([]);
	more = $state(false);
	logRef = $state("");
	logLimit = $state<number>(GIT_LIMITS.commitsPage);
	logLoading = $state(false);
	logError = $state<string | null>(null);

	/** The session the current reading belongs to: a late answer for a session the user left is dropped. */
	#session: string | null = null;
	#seq = 0;
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
			this.#forgetLog();
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
			if (this.logRef && !next.branches.some((b) => refOf(b) === this.logRef)) {
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
		void this.loadLog();
	}

	/** One more page, up to the cap. */
	showMore() {
		if (!this.more || this.logLimit >= GIT_LIMITS.commitsMax) return;
		this.logLimit = Math.min(this.logLimit + GIT_LIMITS.commitsPage, GIT_LIMITS.commitsMax);
		void this.loadLog();
	}

	#forgetLog() {
		this.#logSeq++;
		this.commits = [];
		this.more = false;
		this.logRef = "";
		this.logLimit = GIT_LIMITS.commitsPage;
		this.logLoading = false;
		this.logError = null;
	}

	/** Forget everything (another server, or the panel closed). */
	reset() {
		this.#seq++;
		this.#session = null;
		this.status = null;
		this.loading = false;
		this.error = null;
		this.#forgetLog();
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
