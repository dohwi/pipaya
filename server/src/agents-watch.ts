import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EventBus } from "./events.ts";
import { findRepoRoot } from "./skills.ts";

/**
 * Watches the folders skills, prompt templates and AGENTS.md are read from (`~/.agents`, and `.agents` / `.pi`
 * from each known working directory up to its repository root) and publishes `skills_updated` when something
 * in them changes, so open clients re-read skills, templates and the footer counts without a reload.
 * The set of watched folders is re-evaluated periodically, so a folder created later is picked up too.
 */
export class AgentsWatcher {
	private watchers = new Map<string, FSWatcher>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private rescan: ReturnType<typeof setInterval> | null = null;
	private stopped = false;

	constructor(
		private bus: EventBus,
		private opts: { home?: string; workdirs: () => string[]; debounceMs?: number; rescanMs?: number },
	) {}

	start(): void {
		this.sync();
		this.rescan = setInterval(() => this.sync(), this.opts.rescanMs ?? 15_000);
		this.rescan.unref?.();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.rescan) clearInterval(this.rescan);
		for (const w of this.watchers.values()) w.close();
		this.watchers.clear();
	}

	private targets(): string[] {
		const out = new Set<string>([join(this.opts.home ?? homedir(), ".agents")]);
		for (const cwd of this.opts.workdirs()) {
			const repo = findRepoRoot(cwd);
			for (let dir = cwd; ; dir = dirname(dir)) {
				out.add(join(dir, ".agents"));
				out.add(join(dir, ".pi"));
				if (dir === repo || dirname(dir) === dir) break;
			}
		}
		return [...out].filter((d) => existsSync(d));
	}

	private sync(): void {
		if (this.stopped) return;
		let wanted: string[];
		try { wanted = this.targets(); } catch { return; }
		const set = new Set(wanted);
		for (const [dir, w] of this.watchers) {
			if (!set.has(dir)) { w.close(); this.watchers.delete(dir); }
		}
		let added = false;
		for (const dir of wanted) {
			if (this.watchers.has(dir)) continue;
			try {
				const w = watch(dir, { recursive: true }, () => this.changed());
				w.on("error", () => { w.close(); this.watchers.delete(dir); });
				this.watchers.set(dir, w);
				added = true;
			} catch { /* unreadable or limit reached: retried on the next rescan */ }
		}
		// A folder that appeared since the last scan may already hold files.
		if (added && this.timer !== null) this.changed();
	}

	private changed(): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.bus.publish(null, "skills_updated", { name: "", scope: "global", project: "", source: "files" });
		}, this.opts.debounceMs ?? 300);
		this.timer.unref?.();
	}
}
