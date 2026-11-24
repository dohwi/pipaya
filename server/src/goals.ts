import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import Type, { type Static } from "typebox";
import { badRequest, notFound } from "./errors.ts";
import { Nullable } from "./schemas.ts";
import { GOAL_STATUSES, MAX_GOAL_OBJECTIVE, type GoalStatus } from "./shared/goals.ts";
import type { RunStopCause } from "./run-guard.ts";
import type { RunOrigin } from "./session-types.ts";

/**
 * Per-session long-running goals (`session_goals`), ported from Codex `ThreadGoal`.
 *
 * One goal per session. While its status is `active`, finishing a turn schedules an automatic continuation turn
 * (`origin: "goal"`) until the agent marks it `complete` or `blocked` via the `goal` tool, the user stops or pauses
 * it, a provider usage limit hits (`usage_limited`), or the optional per-goal token budget runs out (`budget_limited`).
 *
 * `goalId` is a fresh UUID on every new/replaced goal and acts as the CAS token for run accounting and run-end
 * transitions, so stale completions from a previous goal can never overwrite a replacement.
 */

export const GoalStatusSchema = Type.Union([
	Type.Literal("active"),
	Type.Literal("paused"),
	Type.Literal("blocked"),
	Type.Literal("usage_limited"),
	Type.Literal("budget_limited"),
	Type.Literal("complete"),
]);

export const GoalSchema = Type.Object({
	sessionId: Type.String(),
	goalId: Type.String(),
	objective: Type.String(),
	status: GoalStatusSchema,
	tokenBudget: Nullable(Type.Integer()),
	tokensUsed: Type.Integer(),
	timeUsedSeconds: Type.Integer(),
	createdAt: Type.Integer(),
	updatedAt: Type.Integer(),
});
export type GoalRecord = Static<typeof GoalSchema>;

export const GoalList = Type.Object({ goals: Type.Array(GoalSchema) });
export const GoalQuery = Type.Object({ sessionId: Type.Optional(Type.String({ minLength: 1 })) });

export const PutGoalBody = Type.Object({
	objective: Type.String({ minLength: 1, maxLength: MAX_GOAL_OBJECTIVE }),
	tokenBudget: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
	/** When true, always start a fresh goal (resetting tokensUsed and timeUsedSeconds to 0). */
	replace: Type.Optional(Type.Boolean()),
});
export type PutGoalInput = Static<typeof PutGoalBody>;

export const PatchGoalBody = Type.Object({
	objective: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_GOAL_OBJECTIVE })),
	status: Type.Optional(GoalStatusSchema),
	tokenBudget: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
});
export type PatchGoalInput = Static<typeof PatchGoalBody>;

export type GoalChange = { sessionId: string; action: "set" | "updated" | "cleared" };

interface Row {
	session_id: string;
	goal_id: string;
	objective: string;
	status: string;
	token_budget: number | null;
	tokens_used: number;
	time_used_seconds: number;
	created_at: number;
	updated_at: number;
}

const toRecord = (r: Row): GoalRecord => ({
	sessionId: r.session_id,
	goalId: r.goal_id,
	objective: r.objective,
	status: GOAL_STATUSES.includes(r.status as GoalStatus) ? (r.status as GoalStatus) : "paused",
	tokenBudget: r.token_budget,
	tokensUsed: r.tokens_used,
	timeUsedSeconds: r.time_used_seconds,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

export interface GoalHost {
	session(id: string): { id: string; closed: boolean } | undefined;
	isRunning(id: string): boolean;
	/** Non-cached billable token total (`input + output`, falling back to `totalTokens`) for the session so far. */
	tokens(id: string): number;
	send(id: string, input: { text: string; mode: "prompt"; origin: "goal" }): Promise<unknown>;
	/** Inject a steering message into a running turn (e.g. mid-turn budget wrap-up). Returns true if injected. */
	steer?(id: string, text: string): boolean;
}

export interface GoalTimers {
	set(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
	clear(id: ReturnType<typeof setTimeout>): void;
}

export interface GoalManagerOptions {
	now?: () => number;
	timers?: GoalTimers;
	continueDelayMs?: number;
	/** While true (e.g. a server update is queued waiting for idle), automatic goal continuations are deferred instead of starting a new turn. */
	deferContinue?: () => boolean;
	onChange?: (change: GoalChange) => void;
	log?: (message: string) => void;
}

const DEFAULT_TIMERS: GoalTimers = {
	set: (fn, ms) => {
		const t = setTimeout(fn, ms);
		t.unref?.();
		return t;
	},
	clear: (id) => clearTimeout(id),
};

const DEFAULT_CONTINUE_DELAY_MS = 250;
const MAX_EMPTY_CONTINUATIONS = 3;

const USAGE_LIMIT_RE = /rate[\s_-]?limit|usage[\s_-]?limit|insufficient[\s_-]?quota|quota[\s_-]?exceeded|too many requests|\b429\b/i;

export const CONTINUATION_PROMPT = "Continue working toward the active session goal.";

const BUDGET_WRAPUP_STEER =
	"The active session goal has reached its token budget and has been marked `budget_limited`. Do not start new substantive work. Summarize what was completed and what remains, then wrap up this turn cleanly.";

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cleanObjective(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) throw badRequest("objective must not be empty");
	if ([...trimmed].length > MAX_GOAL_OBJECTIVE) throw badRequest(`objective must be at most ${MAX_GOAL_OBJECTIVE} characters`);
	return trimmed;
}

function cleanBudget(raw: number | null | undefined): number | null | undefined {
	if (raw === undefined || raw === null) return raw;
	if (!Number.isInteger(raw) || raw < 1) throw badRequest("tokenBudget must be a positive integer or null");
	return raw;
}

interface RunTracker {
	goalId: string;
	lastTokens: number;
	lastAtMs: number;
	hadActivity: boolean;
}

export class GoalManager {
	private readonly now: () => number;
	private readonly timers: GoalTimers;
	private readonly continueDelayMs: number;
	private readonly deferContinue?: () => boolean;
	private readonly onChange?: (c: GoalChange) => void;
	private readonly log?: (m: string) => void;
	private readonly activeRuns = new Map<string, RunTracker>();
	private readonly pendingContinue = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly emptyContinuations = new Map<string, number>();
	private readonly budgetReported = new Map<string, string>(); // sessionId -> goalId already warned mid-run
	private stopped = false;

	constructor(
		private readonly db: Database,
		private readonly host: GoalHost,
		opts: GoalManagerOptions = {},
	) {
		this.now = opts.now ?? (() => Date.now());
		this.timers = opts.timers ?? DEFAULT_TIMERS;
		this.continueDelayMs = opts.continueDelayMs ?? DEFAULT_CONTINUE_DELAY_MS;
		this.deferContinue = opts.deferContinue;
		this.onChange = opts.onChange;
		this.log = opts.log;
	}

	stop(): void {
		this.stopped = true;
		for (const t of this.pendingContinue.values()) this.timers.clear(t);
		this.pendingContinue.clear();
		this.activeRuns.clear();
	}

	list(sessionId?: string): GoalRecord[] {
		const rows = sessionId
			? (this.db.query("SELECT * FROM session_goals WHERE session_id = $sid").all({ sid: sessionId }) as Row[])
			: (this.db.query("SELECT * FROM session_goals ORDER BY updated_at DESC").all() as Row[]);
		return rows.map(toRecord);
	}

	get(sessionId: string): GoalRecord | null {
		const row = this.db.query("SELECT * FROM session_goals WHERE session_id = $sid").get({ sid: sessionId }) as Row | null;
		return row ? toRecord(row) : null;
	}

	isActive(sessionId: string): boolean {
		const g = this.get(sessionId);
		return g?.status === "active";
	}

	/** User/API `PUT /sessions/:id/goal`: create a new goal, edit an unfinished one in place, or replace unconditionally. */
	put(sessionId: string, input: PutGoalInput): GoalRecord {
		const session = this.host.session(sessionId);
		if (!session) throw notFound(`session "${sessionId}" not found`);
		const objective = cleanObjective(input.objective);
		const tokenBudget = cleanBudget(input.tokenBudget);
		this.flushRunning(sessionId);

		const existing = this.get(sessionId);
		const now = this.now();
		if (!existing || existing.status === "complete" || input.replace) {
			const goalId = randomUUID();
			const budget = tokenBudget ?? null;
			this.db.query(
				`INSERT INTO session_goals (session_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at, updated_at)
				 VALUES ($sid, $gid, $obj, 'active', $budget, 0, 0, $now, $now)
				 ON CONFLICT(session_id) DO UPDATE SET
				   goal_id = excluded.goal_id,
				   objective = excluded.objective,
				   status = 'active',
				   token_budget = excluded.token_budget,
				   tokens_used = 0,
				   time_used_seconds = 0,
				   created_at = excluded.created_at,
				   updated_at = excluded.updated_at`,
			).run({ sid: sessionId, gid: goalId, obj: objective, budget, now });
			this.emptyContinuations.delete(sessionId);
			this.budgetReported.delete(sessionId);
			if (this.host.isRunning(sessionId)) this.attachRun(sessionId, goalId);
			const saved = this.get(sessionId)!;
			this.changed(sessionId, "set");
			if (!session.closed && !this.host.isRunning(sessionId)) this.scheduleContinue(sessionId);
			return saved;
		}

		// Edit existing unfinished goal in place, preserving tokens_used and time_used_seconds.
		const nextBudget = tokenBudget === undefined ? existing.tokenBudget : tokenBudget;
		let nextStatus: GoalStatus = existing.status;
		if (nextBudget !== null && existing.tokensUsed >= nextBudget && nextStatus === "active") {
			nextStatus = "budget_limited";
		} else if (existing.status === "budget_limited" && (nextBudget === null || existing.tokensUsed < nextBudget)) {
			nextStatus = "active";
			this.budgetReported.delete(sessionId);
		}
		this.db.query(
			`UPDATE session_goals SET objective = $obj, token_budget = $budget, status = $status, updated_at = $now WHERE session_id = $sid`,
		).run({ sid: sessionId, obj: objective, budget: nextBudget, status: nextStatus, now });
		const saved = this.get(sessionId)!;
		this.changed(sessionId, "updated");
		if (saved.status === "active" && !session.closed && !this.host.isRunning(sessionId)) {
			this.emptyContinuations.delete(sessionId);
			this.scheduleContinue(sessionId);
		} else if (saved.status !== "active") {
			this.cancelPending(sessionId);
		}
		return saved;
	}

	/** User/API `PATCH /sessions/:id/goal`: edit objective, budget, or status (pause / resume). */
	patch(sessionId: string, input: PatchGoalInput): GoalRecord {
		const session = this.host.session(sessionId);
		if (!session) throw notFound(`session "${sessionId}" not found`);
		this.flushRunning(sessionId);

		const existing = this.get(sessionId);
		if (!existing) throw notFound(`session "${sessionId}" has no goal`);

		const objective = input.objective !== undefined ? cleanObjective(input.objective) : existing.objective;
		const nextBudget = input.tokenBudget === undefined ? existing.tokenBudget : cleanBudget(input.tokenBudget) ?? null;
		let nextStatus: GoalStatus = input.status ?? existing.status;

		// Budget precedence (matches Codex):
		// - Raising or clearing budget on a budget_limited goal revives it unless caller explicitly chose another stop status.
		if (existing.status === "budget_limited" && input.status === undefined && (nextBudget === null || existing.tokensUsed < nextBudget)) {
			nextStatus = "active";
		}
		// - Cannot stay/become active when tokens already reached budget.
		if (nextStatus === "active" && nextBudget !== null && existing.tokensUsed >= nextBudget) {
			nextStatus = "budget_limited";
		}
		// - A budget_limited goal stays budget_limited if someone tries to pause/block it without raising budget.
		if (existing.status === "budget_limited" && (nextStatus === "paused" || nextStatus === "blocked") && nextBudget !== null && existing.tokensUsed >= nextBudget) {
			nextStatus = "budget_limited";
		}

		const now = this.now();
		this.db.query(
			`UPDATE session_goals SET objective = $obj, token_budget = $budget, status = $status, updated_at = $now WHERE session_id = $sid`,
		).run({ sid: sessionId, obj: objective, budget: nextBudget, status: nextStatus, now });

		if (nextStatus === "active") {
			this.emptyContinuations.delete(sessionId);
			if (nextBudget === null || existing.tokensUsed < nextBudget) this.budgetReported.delete(sessionId);
			if (this.host.isRunning(sessionId) && !this.activeRuns.has(sessionId)) this.attachRun(sessionId, existing.goalId);
		} else {
			this.cancelPending(sessionId);
		}

		const saved = this.get(sessionId)!;
		this.changed(sessionId, "updated");
		if (saved.status === "active" && !session.closed && !this.host.isRunning(sessionId)) {
			this.scheduleContinue(sessionId);
		}
		return saved;
	}

	clear(sessionId: string): boolean {
		this.cancelPending(sessionId);
		this.activeRuns.delete(sessionId);
		this.emptyContinuations.delete(sessionId);
		this.budgetReported.delete(sessionId);
		const had = this.get(sessionId) !== null;
		if (!had) return false;
		this.db.query("DELETE FROM session_goals WHERE session_id = $sid").run({ sid: sessionId });
		this.changed(sessionId, "cleared");
		return true;
	}

	/** Agent tool: create a goal only when there is no unfinished goal. */
	agentCreate(sessionId: string, objective: string, tokenBudget?: number | null): GoalRecord {
		const existing = this.get(sessionId);
		if (existing && existing.status !== "complete") {
			throw new Error(`An unfinished goal already exists (status: ${existing.status}). Finish, update, or have the user clear it first.`);
		}
		return this.put(sessionId, { objective, tokenBudget: tokenBudget ?? null, replace: true });
	}

	/** Agent tool: mark goal `complete`, `blocked`, or `paused`. */
	agentUpdate(sessionId: string, status: "complete" | "blocked" | "paused"): GoalRecord {
		this.flushRunning(sessionId);
		const existing = this.get(sessionId);
		if (!existing) throw new Error("No goal is currently set for this session.");
		// Budget-limited takes precedence over paused/blocked (Codex rule), though complete is still allowed if truly achieved.
		const nextStatus: GoalStatus = existing.status === "budget_limited" && status !== "complete" ? "budget_limited" : status;
		const now = this.now();
		this.db.query("UPDATE session_goals SET status = $status, updated_at = $now WHERE session_id = $sid").run({
			sid: sessionId,
			status: nextStatus,
			now,
		});
		this.cancelPending(sessionId);
		this.activeRuns.delete(sessionId);
		this.emptyContinuations.delete(sessionId);
		const saved = this.get(sessionId)!;
		this.changed(sessionId, "updated");
		return saved;
	}

	onSessionDeleted(sessionId: string): void {
		this.cancelPending(sessionId);
		this.activeRuns.delete(sessionId);
		this.emptyContinuations.delete(sessionId);
		this.budgetReported.delete(sessionId);
		this.changed(sessionId, "cleared");
	}

	onSessionClosed(sessionId: string): void {
		this.cancelPending(sessionId);
		const existing = this.get(sessionId);
		if (existing?.status === "active") {
			this.db.query("UPDATE session_goals SET status = 'paused', updated_at = $now WHERE session_id = $sid AND goal_id = $gid AND status = 'active'").run({
				sid: sessionId,
				gid: existing.goalId,
				now: this.now(),
			});
			this.changed(sessionId, "updated");
		}
	}

	cancelPending(sessionId: string): void {
		const t = this.pendingContinue.get(sessionId);
		if (t !== undefined) {
			this.timers.clear(t);
			this.pendingContinue.delete(sessionId);
		}
	}

	/** Called when a run begins on `sessionId`. */
	onRunStarted(sessionId: string): void {
		this.cancelPending(sessionId);
		const g = this.get(sessionId);
		if (!g || g.status !== "active") {
			this.activeRuns.delete(sessionId);
			return;
		}
		this.attachRun(sessionId, g.goalId);
	}

	/** Called on every stored `message_end` during a run to mark activity and flush token/time usage incrementally. */
	onMessageEnd(sessionId: string, info: { role: string; hasToolCalls?: boolean; textLength?: number }): void {
		const tracker = this.activeRuns.get(sessionId);
		if (!tracker) return;
		if (info.role === "assistant") {
			if (info.hasToolCalls || (info.textLength ?? 0) > 0) tracker.hadActivity = true;
			const updated = this.flushTracker(sessionId, tracker);
			if (updated?.status === "budget_limited") this.notifyBudgetMidRun(sessionId, updated);
		} else if (info.role === "toolResult") {
			tracker.hadActivity = true;
		}
	}

	/** Called when `run_finished` fires for `sessionId`. */
	onRunFinished(
		sessionId: string,
		info: { status: "ok" | "error" | "aborted"; error?: string | null; cause?: RunStopCause; origin: RunOrigin },
	): void {
		const tracker = this.activeRuns.get(sessionId);
		this.activeRuns.delete(sessionId);
		if (tracker) this.flushTracker(sessionId, tracker);

		const g = this.get(sessionId);
		if (!g || g.status !== "active") return;
		// CAS: if the goal was replaced during this run and never attached, ignore stale run_finished.
		if (tracker && g.goalId !== tracker.goalId) return;

		if (info.cause === "shutdown" || info.cause === "restart" || this.stopped) return;

		// Manual stop / close / force-stop automatically pauses an active goal (matches Codex Esc/Ctrl+C UX).
		if (info.status === "aborted" && (info.cause === "user" || info.cause === "close" || info.cause === "force")) {
			this.transitionStatus(sessionId, g.goalId, "paused");
			return;
		}

		// Runaway guard: repeated identical tool calls -> blocked; hitting per-run turn cap can continue on a fresh turn.
		if (info.cause === "limit") {
			if (info.error && /repeated|identical/i.test(info.error)) {
				this.transitionStatus(sessionId, g.goalId, "blocked");
				return;
			}
		}

		// Unrecovered error -> usage_limited or blocked (prevents infinite error loops).
		if (info.status === "error") {
			const next: GoalStatus = info.error && USAGE_LIMIT_RE.test(info.error) ? "usage_limited" : "blocked";
			this.transitionStatus(sessionId, g.goalId, next);
			return;
		}

		// Empty automatic continuation guard: 3 consecutive goal turns with no activity -> blocked.
		if (info.origin === "goal" && tracker && !tracker.hadActivity) {
			const n = (this.emptyContinuations.get(sessionId) ?? 0) + 1;
			this.emptyContinuations.set(sessionId, n);
			if (n >= MAX_EMPTY_CONTINUATIONS) {
				this.emptyContinuations.delete(sessionId);
				this.transitionStatus(sessionId, g.goalId, "blocked");
				return;
			}
		} else if (tracker?.hadActivity) {
			this.emptyContinuations.delete(sessionId);
		}

		const session = this.host.session(sessionId);
		if (session && !session.closed) this.scheduleContinue(sessionId);
	}

	/**
	 * System instructions injected transiently via `transformContext` (never persisted to messages, survives compaction).
	 * Returns null when the session has no active goal (and no in-turn budget wrap-up).
	 */
	systemNote(sessionId: string): string | null {
		const g = this.get(sessionId);
		if (!g) return null;
		if (g.status === "budget_limited" && this.budgetReported.get(sessionId) === g.goalId && this.host.isRunning(sessionId)) {
			return [
				"[Session Goal — Budget Reached]",
				`<goal_objective>${xmlEscape(g.objective)}</goal_objective>`,
				`Usage: ${g.tokensUsed.toLocaleString("en-US")} / ${(g.tokenBudget ?? 0).toLocaleString("en-US")} tokens · ${g.timeUsedSeconds}s.`,
				"The goal has reached its token budget and is now `budget_limited`. Do not start new substantive work. Summarize completed work and remaining items, then wrap up this turn.",
				"Only call `goal` with `status: \"complete\"` if the entire objective is already verified complete.",
			].join("\n");
		}
		if (g.status !== "active") return null;
		const budgetLine =
			g.tokenBudget !== null
				? `Tokens used: ${g.tokensUsed.toLocaleString("en-US")} / ${g.tokenBudget.toLocaleString("en-US")} (remaining: ${Math.max(0, g.tokenBudget - g.tokensUsed).toLocaleString("en-US")}) · Time used: ${g.timeUsedSeconds}s`
				: `Tokens used: ${g.tokensUsed.toLocaleString("en-US")} (budget: unbounded) · Time used: ${g.timeUsedSeconds}s`;
		return [
			"[Active Session Goal]",
			"You are pursuing a persistent session goal. After each turn finishes, the server will automatically continue this session until you mark the goal `complete` or `blocked`, or the user pauses/clears it. Context compaction runs automatically if needed; use `goal` (`action: \"get\"`) if the objective is ever truncated.",
			`<goal_objective>${xmlEscape(g.objective)}</goal_objective>`,
			budgetLine,
			"Rules:",
			"- Work from direct evidence in the repository/environment; do not substitute an easier or narrower task.",
			"- Before calling `goal(action: \"update\", status: \"complete\")`, audit every requirement of the objective against direct evidence (tests, command outputs, files). Never mark `complete` merely because the budget is running low.",
			"- Call `goal(action: \"update\", status: \"blocked\")` only when the exact same blocking condition has repeated for at least 3 consecutive goal turns without meaningful progress and cannot be resolved without user input or an external change.",
			"- Call `goal(action: \"update\", status: \"paused\")` only when the user explicitly asks to pause the goal.",
		].join("\n");
	}

	private attachRun(sessionId: string, goalId: string): void {
		this.activeRuns.set(sessionId, {
			goalId,
			lastTokens: this.host.tokens(sessionId),
			lastAtMs: this.now(),
			hadActivity: false,
		});
	}

	private flushRunning(sessionId: string): void {
		const tracker = this.activeRuns.get(sessionId);
		if (tracker) this.flushTracker(sessionId, tracker);
	}

	private flushTracker(sessionId: string, tracker: RunTracker): GoalRecord | null {
		const now = this.now();
		const currentTokens = this.host.tokens(sessionId);
		const deltaTokens = Math.max(0, currentTokens - tracker.lastTokens);
		const deltaSec = Math.max(0, Math.floor((now - tracker.lastAtMs) / 1000));
		if (deltaTokens === 0 && deltaSec === 0) return this.get(sessionId);

		tracker.lastTokens = Math.max(tracker.lastTokens, currentTokens);
		if (deltaSec > 0) tracker.lastAtMs += deltaSec * 1000;

		// CAS on goal_id; automatically flips `active` -> `budget_limited` when budget is reached.
		const res = this.db.query(
			`UPDATE session_goals
			 SET tokens_used = tokens_used + $dt,
			     time_used_seconds = time_used_seconds + $ds,
			     status = CASE
			       WHEN status = 'active' AND token_budget IS NOT NULL AND (tokens_used + $dt) >= token_budget
			       THEN 'budget_limited'
			       ELSE status
			     END,
			     updated_at = $now
			 WHERE session_id = $sid AND goal_id = $gid AND status IN ('active', 'budget_limited')`,
		).run({ sid: sessionId, gid: tracker.goalId, dt: deltaTokens, ds: deltaSec, now });

		if (res.changes > 0) {
			this.changed(sessionId, "updated");
			return this.get(sessionId);
		}
		return null;
	}

	private notifyBudgetMidRun(sessionId: string, goal: GoalRecord): void {
		if (this.budgetReported.get(sessionId) === goal.goalId) return;
		this.budgetReported.set(sessionId, goal.goalId);
		try {
			this.host.steer?.(sessionId, BUDGET_WRAPUP_STEER);
		} catch {
			/* run may have ended concurrently */
		}
	}

	private transitionStatus(sessionId: string, expectedGoalId: string, status: GoalStatus): void {
		const res = this.db.query(
			`UPDATE session_goals SET status = $status, updated_at = $now WHERE session_id = $sid AND goal_id = $gid AND status = 'active'`,
		).run({ sid: sessionId, gid: expectedGoalId, status, now: this.now() });
		if (res.changes > 0) {
			this.cancelPending(sessionId);
			this.changed(sessionId, "updated");
		}
	}

	private scheduleContinue(sessionId: string, delayMs = this.continueDelayMs): void {
		if (this.stopped) return;
		this.cancelPending(sessionId);
		const timer = this.timers.set(() => {
			this.pendingContinue.delete(sessionId);
			if (this.stopped) return;
			if (this.deferContinue?.()) {
				this.scheduleContinue(sessionId, Math.max(this.continueDelayMs, 1000));
				return;
			}
			const session = this.host.session(sessionId);
			if (!session || session.closed || this.host.isRunning(sessionId)) return;
			const g = this.get(sessionId);
			if (!g || g.status !== "active") return;
			void this.host.send(sessionId, { text: CONTINUATION_PROMPT, mode: "prompt", origin: "goal" }).catch((e) => {
				this.log?.(`goal continuation failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
				const cur = this.get(sessionId);
				if (cur && cur.goalId === g.goalId && cur.status === "active") {
					const msg = e instanceof Error ? e.message : String(e);
					this.transitionStatus(sessionId, g.goalId, USAGE_LIMIT_RE.test(msg) ? "usage_limited" : "blocked");
				}
			});
		}, delayMs);
		this.pendingContinue.set(sessionId, timer);
	}

	private changed(sessionId: string, action: GoalChange["action"]): void {
		try {
			this.onChange?.({ sessionId, action });
		} catch {
			/* listener errors never break goal state updates */
		}
	}
}
