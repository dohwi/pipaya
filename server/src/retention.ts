import type { Database } from "bun:sqlite";
import Type, { type Static } from "typebox";
import type { SessionManager } from "./sessions.ts";
import type { SessionStore } from "./store.ts";
import type { ApprovalManager } from "./approvals.ts";
import type { QuestionManager } from "./questions.ts";
import { badRequest } from "./errors.ts";

const DAY = 24 * 3600_000;

/** What the automatic clean-up deletes. Saved on the server, so every device sees and changes the same one. */
export const RetentionPolicy = Type.Object(
	{
		enabled: Type.Boolean({ description: "Delete sessions automatically" }),
		days: Type.Integer({ minimum: 1, maximum: 3650, description: "Delete a session that has not been used for this many days" }),
		onlyClosed: Type.Boolean({ description: "Only sessions that are closed; active ones are kept however old" }),
	},
	{ additionalProperties: false },
);
export type RetentionPolicy = Static<typeof RetentionPolicy>;

export const DEFAULT_POLICY: RetentionPolicy = { enabled: false, days: 30, onlyClosed: false };

export const RetentionInfo = Type.Object({
	policy: RetentionPolicy,
	lastRun: Type.Union([Type.Integer(), Type.Null()], { description: "Unix ms of the last automatic clean-up" }),
	lastDeleted: Type.Integer({ description: "Sessions the last clean-up deleted" }),
	due: Type.Integer({ description: "Sessions the policy would delete right now" }),
});

const KEY = "session_retention";
const STATE_KEY = "session_retention_state";

/**
 * Automatic and manual deletion of old sessions. A session that is running, or waiting for an approval or an answer,
 * is never deleted, whatever its age: someone is still using it.
 */
export class Retention {
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private db: Database,
		private store: SessionStore,
		private sessions: SessionManager,
		private approvals: ApprovalManager,
		private questions: QuestionManager,
	) {}

	/** In use: running, or waiting for the user. */
	private busy(id: string): boolean {
		return this.sessions.isRunning(id) || this.approvals.list(id).length > 0 || this.questions.list(id).length > 0;
	}

	policy(): RetentionPolicy {
		const row = this.db.query("SELECT data FROM settings WHERE key = $k").get({ k: KEY }) as { data: string } | null;
		return row ? { ...DEFAULT_POLICY, ...JSON.parse(row.data) } : { ...DEFAULT_POLICY };
	}

	setPolicy(next: RetentionPolicy): RetentionPolicy {
		if (!Number.isInteger(next.days) || next.days < 1) throw badRequest("days must be at least 1");
		this.db.query("INSERT INTO settings (key, data) VALUES ($k, $d) ON CONFLICT(key) DO UPDATE SET data = $d").run({ k: KEY, d: JSON.stringify(next) });
		return this.policy();
	}

	private state(): { lastRun: number | null; lastDeleted: number } {
		const row = this.db.query("SELECT data FROM settings WHERE key = $k").get({ k: STATE_KEY }) as { data: string } | null;
		return row ? JSON.parse(row.data) : { lastRun: null, lastDeleted: 0 };
	}

	/** Sessions the policy matches now, oldest first. */
	candidates(policy = this.policy(), now = Date.now()): string[] {
		const cutoff = now - policy.days * DAY;
		const rows = this.db
			.query("SELECT id FROM sessions WHERE updated_at < $cutoff AND ($onlyClosed = 0 OR closed = 1) ORDER BY updated_at")
			.all({ cutoff, onlyClosed: policy.onlyClosed ? 1 : 0 }) as { id: string }[];
		return rows.map((r) => r.id).filter((id) => !this.busy(id));
	}

	info() {
		const policy = this.policy();
		return { policy, ...this.state(), due: policy.enabled ? this.candidates(policy).length : 0 };
	}

	/** Delete these sessions, skipping any that are in use. Returns what was deleted and what was skipped. */
	remove(ids: string[]): { deleted: string[]; skipped: string[] } {
		const deleted: string[] = [], skipped: string[] = [];
		for (const id of new Set(ids)) {
			if (!this.store.get(id) || this.busy(id)) {
				skipped.push(id);
				continue;
			}
			this.sessions.delete(id);
			deleted.push(id);
		}
		return { deleted, skipped };
	}

	/** One automatic pass. Does nothing while the policy is off. */
	run(now = Date.now()): number {
		const policy = this.policy();
		if (!policy.enabled) return 0;
		const { deleted } = this.remove(this.candidates(policy, now));
		this.db
			.query("INSERT INTO settings (key, data) VALUES ($k, $d) ON CONFLICT(key) DO UPDATE SET data = $d")
			.run({ k: STATE_KEY, d: JSON.stringify({ lastRun: now, lastDeleted: deleted.length }) });
		return deleted.length;
	}

	start(everyMs = 3600_000) {
		this.timer = setInterval(() => this.run(), everyMs);
		this.timer.unref?.();
		// shortly after start, so a server that was off for a while does not wait a full hour
		const first = setTimeout(() => this.run(), 30_000);
		first.unref?.();
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
	}
}
