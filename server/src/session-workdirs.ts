import { isAbsolute, resolve } from "node:path";
import { badRequest, conflict, notFound } from "./errors.ts";
import type { EventBus } from "./events.ts";
import { repoOf } from "./git-info.ts";
import type { SessionRecord, SessionStore } from "./store.ts";
import { isGone, movedNote, placeText, resolveMove, stayHint, touchedDir, workDirOf, workTargets } from "./work-tree.ts";

export interface SessionWorkdirsDeps {
	store: SessionStore;
	bus: EventBus;
	getSession: (id: string) => SessionRecord;
	isRunning: (id: string) => boolean;
	allowedDir: (dir: string) => boolean;
	home: string;
}

/**
 * Manages per-session git worktree switching (`activeDir`), move notifications (`pendingNotes`),
 * and post-tool stay hints when an agent works in another worktree of its repository.
 */
export class SessionWorkdirs {
	/**
	 * What the agent must hear before its next model call about a move it did not make itself (the user moved the
	 * session, or its worktree is gone): given with its next message or turn, then dropped. The latest move wins.
	 */
	private pendingNotes = new Map<string, string>();

	constructor(private deps: SessionWorkdirsDeps) {}

	/** Sets `activeDir` and tells the clients (the sidebar lists the session there). */
	setActiveDir(id: string, dir: string | null): SessionRecord {
		const updated = this.deps.store.setActiveDir(id, dir);
		if (!updated) throw notFound("session");
		this.deps.bus.publish(id, "session_updated", updated);
		return updated;
	}

	/**
	 * Moves the session to another working tree of its repository (`target`), or home (null). Shared by the agent's
	 * `workdir` tool and the user (PATCH workDir). The tools follow from the next turn of a run, or the next run. A user
	 * move leaves a note the agent sees with its next message; the agent's own move is reported in its tool result.
	 */
	move(id: string, target: string | null, by: "agent" | "user"): { record: SessionRecord; note: string } {
		const rec = this.deps.getSession(id);
		if (by === "user" && this.deps.isRunning(id)) throw conflict("the session is working; move it after it finishes");
		const from = workDirOf(rec);
		let next: string | null;
		try {
			next = target === null ? null : resolveMove(rec.cwd, isAbsolute(target) ? resolve(target) : resolve(from, target), this.deps.allowedDir);
		} catch (e) {
			throw badRequest((e as Error).message);
		}
		const note = movedNote(rec.cwd, from, next, by);
		if (next === (rec.activeDir ?? null)) return { record: rec, note: `[pipaya] This session already works in ${placeText(from)}.` };
		const record = this.setActiveDir(id, next);
		if (by === "user") this.pendingNotes.set(id, note);
		return { record, note };
	}

	/** Takes the pending move note for the session, if any. */
	takeNote(id: string): string | undefined {
		const note = this.pendingNotes.get(id);
		this.pendingNotes.delete(id);
		return note;
	}

	/** Drops any pending move note (called on session delete or idle eviction). */
	clearNote(id: string): void {
		this.pendingNotes.delete(id);
	}

	/** The working trees the session may move to, its own first, with the one it works in now marked. */
	list(id: string): { path: string; branch: string | null; home: boolean; current: boolean }[] {
		const rec = this.deps.getSession(id);
		const here = resolve(rec.activeDir ?? repoOf(rec.cwd)?.top ?? rec.cwd);
		return workTargets(rec.cwd, this.deps.allowedDir).map((t) => ({ ...t, current: resolve(t.path) === here }));
	}

	/** What the `workdir` tool shows: where the session works and where it can go. */
	show(id: string): string {
		const rec = this.deps.getSession(id);
		const here = workDirOf(rec);
		const targets = this.list(id);
		const lines = [`Works in ${placeText(here)}${rec.activeDir ? ` (its own folder is ${rec.cwd})` : " (its own folder)"}.`];
		if (targets.length > 1) lines.push("Working trees of its repository:", ...targets.map((t) => `- ${t.path}${t.branch ? ` (${t.branch})` : ""}${t.home ? " [own]" : ""}${t.current ? " [here]" : ""}`));
		else if (!targets.length) lines.push("Its folder is not in a git repository: there is nowhere to move.");
		else lines.push("Its repository has no other worktree yet (git worktree add ../<name> makes one).");
		return lines.join("\n");
	}

	/** A working tree the session was moved into and that is gone sends it home, and says so to the agent. */
	homeIfGone(id: string): void {
		const rec = this.deps.store.get(id);
		if (!rec || !isGone(rec.activeDir)) return;
		this.pendingNotes.set(id, movedNote(rec.cwd, rec.activeDir, null, "gone"));
		this.setActiveDir(id, null);
	}

	/** Returns a stay hint when a tool operated in another working tree of the repo, or null. */
	stayHintFor(rec: SessionRecord, toolName: string, args: unknown): string | null {
		try {
			return stayHint(rec.cwd, workDirOf(rec), touchedDir(toolName, args, workDirOf(rec), this.deps.home));
		} catch {
			return null; // odd .git layout: no hint
		}
	}
}
