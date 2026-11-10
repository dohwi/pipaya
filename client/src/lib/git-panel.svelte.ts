/**
 * The right sidebar's git panel data: the working directory of the session on screen, read from the server.
 *
 * No polling. It is read when the panel opens, when the session (or its folder) changes, and when the agent's turn ends
 * (`run_finished` in the chat store), which is when files are most likely to have changed. File diffs are read on click.
 */
import { viewport } from "./viewport.svelte";
import { app } from "./store.svelte";
import { gitFailure, type GitFailure } from "./git-error";
import type { GitDiff, GitStatus } from "./types";

/** The session whose folder the panel shows: the one on screen, and only when it is a chat (a terminal has no session). */
const target = () => app.readableId;

class GitPanel {
	/** The reading on screen; `null` until the first answer for the current session. */
	status = $state<GitStatus | null>(null);
	loading = $state(false);
	/** Why the status could not be read: told apart so an old server gets a hint, not its raw "route not found". */
	error = $state<GitFailure | null>(null);
	/** The file whose diff is open, and the diff itself. */
	picked = $state<{ path: string; staged: boolean } | null>(null);
	diff = $state<GitDiff | null>(null);
	diffLoading = $state(false);
	diffError = $state<string | null>(null);

	/** The session the current reading belongs to: a late answer for a session the user left is dropped. */
	#session: string | null = null;
	#seq = 0;

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
			this.close();
		}
		this.#session = id;
		this.loading = true;
		this.error = null;
		try {
			const next = await api.gitStatus(id, signal);
			if (seq !== this.#seq) return;
			this.status = next;
		} catch (e) {
			if (seq !== this.#seq || (e as Error).name === "AbortError") return;
			this.error = gitFailure(e);
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	/** Open one file's diff; clicking the open one again closes it. */
	async pick(file: { path: string; staged: boolean }) {
		if (this.picked?.path === file.path && this.picked.staged === file.staged) {
			this.close();
			return;
		}
		this.picked = { path: file.path, staged: file.staged };
		this.diff = null;
		this.diffError = null;
		const id = this.#session;
		const api = app.api;
		if (!id || !api) return;
		const seq = ++this.#seq;
		this.diffLoading = true;
		try {
			const next = await api.gitDiff(id, file.path, file.staged);
			if (seq !== this.#seq) return;
			this.diff = next;
		} catch (e) {
			if (seq !== this.#seq) return;
			this.diffError = (e as Error).message;
		} finally {
			if (seq === this.#seq) this.diffLoading = false;
		}
	}

	close() {
		this.picked = null;
		this.diff = null;
		this.diffError = null;
		this.diffLoading = false;
	}

	/** Forget everything (another server, or the panel closed). */
	reset() {
		this.#seq++;
		this.#session = null;
		this.status = null;
		this.loading = false;
		this.error = null;
		this.close();
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
