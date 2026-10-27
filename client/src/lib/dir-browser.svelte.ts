import { isAbs, sepOf, splitTyped, tabComplete, typedMatches } from "./workdir-path";
import type { DirListing } from "./types";

/** What the browser needs from the outside: the server's listing and folder creation, and how a failure reads. */
export interface DirSource {
	list(path: string | undefined, hidden: boolean): Promise<DirListing>;
	mkdir(parent: string, name: string): Promise<{ path: string }>;
	errorText(cause: unknown): string;
}

const asDir = (p: string) => (/[\\/]$/.test(p) ? p : `${p}${sepOf(p)}`);

/**
 * Browsing a server's folders with a path box: the folder on screen, what is typed, which row the arrow keys are on,
 * the not-yet-existing-folder case, and making a new folder. A newer listing request supersedes an older one (only the
 * last answer lands), and typing an absolute path lists it live after a short pause. A `.svelte.ts` module: the fields
 * are runes. The caller starts it with `open(path)` and ends it with `dispose()` (a pending live listing is dropped).
 */
export class DirBrowser {
	listing = $state<DirListing | null>(null);
	error = $state("");
	loading = $state(false);
	hidden = $state(false);
	typed = $state("");
	/** The folder part of what is typed does not exist (yet) */
	missing = $state(false);
	/** Row highlighted with the arrow keys (-1: none) */
	active = $state(-1);
	creating = $state(false);
	newName = $state("");

	private seq = 0;
	private fallback = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private src: () => DirSource | null,
		private liveDelay = 140,
	) {}

	/** What is typed after the last slash: a filter on the folder's children */
	get part(): string {
		return splitTyped(this.typed.trim()).part;
	}

	/** The listing's folders that match what is typed */
	get shown() {
		return typedMatches(this.listing?.entries ?? [], this.typed, this.listing?.path);
	}

	/**
	 * List `path` (the server's home when undefined). `live`: the path is half-typed, so a failure is not an error: the
	 * last list stays and `missing` says so quietly. A starting folder that is gone falls back to the home once.
	 */
	async go(path?: string, live = false): Promise<void> {
		const src = this.src();
		if (!src) return;
		const mine = ++this.seq;
		this.loading = true;
		this.error = "";
		try {
			const res = await src.list(path, this.hidden);
			if (mine !== this.seq) return; // a newer request superseded this one
			this.listing = res;
			this.active = -1;
			// "/a/b/" rather than "/a/b": the text after the last slash is a filter, and a folder's own name must not be one
			if (!live) this.typed = asDir(res.path);
		} catch (e) {
			if (mine !== this.seq) return;
			if (live) {
				this.error = "";
				this.missing = true;
				return;
			}
			if (!this.fallback && path) {
				this.fallback = true;
				return this.go();
			}
			this.error = src.errorText(e);
		} finally {
			if (mine === this.seq) this.loading = false;
		}
	}

	/** The path box changed: an absolute path is listed live after a pause (a relative one is not listed). */
	typedChanged(): void {
		this.active = -1;
		clearTimeout(this.timer);
		const v = this.typed.trim();
		if (!isAbs(v)) return;
		const { dir } = splitTyped(v);
		this.timer = setTimeout(() => {
			this.missing = false;
			if (dir !== this.listing?.path) void this.go(dir, true);
		}, this.liveDelay);
	}

	/** Arrow keys move the highlight (wrapping); returns true when the key was used. */
	arrow(key: "ArrowDown" | "ArrowUp"): boolean {
		const n = this.shown.length;
		if (!n) return false;
		this.active = (this.active + (key === "ArrowDown" ? 1 : -1) + n) % n;
		return true;
	}

	/** Backspace over a trailing slash drops the highlight, so the next Enter does not open a row the user left. */
	backspaced(atEnd: boolean): void {
		if (/[\\/]$/.test(this.typed) && this.typed.length > 1 && atEnd) this.active = -1;
	}

	/**
	 * Tab: complete to the only (or the longest common) match, like a shell; the folder it lands on is listed at once so
	 * its sub-folders are there for the next Tab. Returns false when there was nothing to complete.
	 */
	tab(): boolean {
		const shown = this.shown;
		if (!this.listing || !shown.length) return false;
		const done = tabComplete(splitTyped(this.typed.trim()).dir, shown.map((d) => d.name), this.active >= 0 ? shown[this.active]?.name : undefined);
		this.typed = done.text;
		if (done.whole) {
			clearTimeout(this.timer);
			this.missing = false;
			void this.go(this.typed.trim(), true);
		} else this.typedChanged();
		return true;
	}

	/**
	 * Enter in the path box: open the highlighted folder, else the exact or only match; on an already-listed "/path/" it
	 * asks to confirm (`"confirm"`, with the path); else go to the typed path.
	 */
	submit(busy: boolean): { confirm: string } | void {
		const v = this.typed.trim();
		const shown = this.shown;
		if (this.active >= 0 && shown[this.active]) return void this.go(shown[this.active]!.path);
		const part = this.part;
		if (part) {
			const hit = shown.find((d) => d.name === part) ?? (shown.length === 1 ? shown[0] : undefined);
			if (hit) return void this.go(hit.path);
		}
		if (isAbs(v) && /[\\/]$/.test(v) && !this.missing && this.listing && splitTyped(v).dir === this.listing.path && !busy) return { confirm: this.listing.path };
		void this.go(v);
	}

	/** Make the folder named `newName` inside the one on screen and open it. */
	async mkdir(): Promise<void> {
		const src = this.src();
		const name = this.newName.trim();
		if (!src || !this.listing || !name) return;
		try {
			const made = await src.mkdir(this.listing.path, name);
			this.creating = false;
			this.newName = "";
			await this.go(made.path);
		} catch (e) {
			this.error = src.errorText(e);
		}
	}

	startCreating(): void {
		this.creating = true;
	}

	cancelCreating(): void {
		this.creating = false;
		this.newName = "";
	}

	/** Drop a pending live listing (the picker closed). */
	dispose(): void {
		clearTimeout(this.timer);
	}
}
