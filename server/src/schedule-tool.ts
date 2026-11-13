import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import Type, { type TSchema } from "typebox";
import { MAX_PROMPT, MAX_TITLE, MIN_EVERY_MS, type PatchScheduleInput, type ScheduleRecord } from "./scheduler.ts";
import type { ToolDef } from "./tools.ts";

/**
 * `schedule`: the agent sets up, changes and removes scheduled tasks itself (a prompt sent to a session once, or every so
 * often), the same tasks the user manages in the settings. Times go in and come out as the server's local time.
 */

export const SCHEDULE_TOOL = "schedule";
const ACTIONS = ["list", "create", "update", "delete", "run"] as const;
type Action = (typeof ACTIONS)[number];

/** What the tool may ask of the server; the session manager wires it to the scheduler. */
export interface ScheduleOps {
	/** This session's tasks, or every task. */
	list(all: boolean): ScheduleRecord[];
	/** `session`: a session name (@name) to send to instead of this one. */
	create(input: { session?: string; title?: string; prompt: string; runAt?: number; everyMs?: number }): ScheduleRecord;
	update(id: string, patch: PatchScheduleInput): ScheduleRecord;
	delete(id: string): ScheduleRecord;
	run(id: string): Promise<ScheduleRecord>;
	/** `@name` of a session for the result text ("this session" for the caller's own). */
	label(sessionId: string): string;
	now(): number;
}

const defineTool = <T extends TSchema>(tool: AgentTool<T>): AgentTool<any> => tool;
const text = (t: string, details: Record<string, unknown> = {}): AgentToolResult<any> => ({ content: [{ type: "text", text: t }], details });

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");

/** `2026-11-15 09:00 (UTC+09:00)`: the server's local time, which is also how `at` is read when it has no offset. */
export function localTime(ms: number): string {
	const d = new Date(ms);
	const off = -d.getTimezoneOffset();
	const local = new Date(ms + off * 60_000).toISOString().slice(0, 16).replace("T", " ");
	return `${local} (UTC${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)})`;
}

const minutes = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${ms / 60_000} min`);
const clip = (s: string, n: number) => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function describeTask(t: ScheduleRecord, label: (sessionId: string) => string): string {
	const when = t.kind === "once" ? `once at ${localTime(t.runAt!)}` : `every ${minutes(t.everyMs!)}`;
	const state = t.enabled ? `next ${localTime(t.nextRunAt!)}` : "off";
	const last = t.lastRunAt ? `; last ${t.lastStatus ?? "?"} at ${localTime(t.lastRunAt)}${t.lastError ? ` (${clip(t.lastError, 120)})` : ""}` : "";
	return `- ${t.id} · ${when} · ${state}${last} · to ${label(t.sessionId)}${t.title ? ` · "${t.title}"` : ""}\n  prompt: ${clip(t.prompt, 200)}`;
}

/** `at` (a date-time) or `inMinutes` (from now) → ms; undefined when neither is given. */
function timeOf(p: { at?: string; inMinutes?: number }, now: number): number | undefined {
	if (p.at !== undefined && p.inMinutes !== undefined) throw new Error("give either `at` or `inMinutes`, not both");
	if (p.inMinutes !== undefined) return now + Math.round(p.inMinutes * 60_000);
	if (p.at === undefined) return undefined;
	const at = p.at.trim().replace(" ", "T");
	// A date alone would be read as midnight UTC, not local: ask for the time.
	const ms = /T\d{1,2}:\d{2}/.test(at) ? Date.parse(at) : Number.NaN;
	if (Number.isNaN(ms)) throw new Error(`cannot read the time "${p.at}"; use e.g. 2026-11-15T09:00 (server local time) or 2026-11-15T09:00+09:00`);
	return ms;
}

const need = <T>(v: T | undefined, what: string, action: Action): T => {
	if (v === undefined || v === "") throw new Error(`schedule ${action} needs \`${what}\``);
	return v;
};

const DESCRIPTION = [
	"Scheduled tasks: a prompt sent automatically to a session once at a set time, or every so often (the user sees the same list in the settings). Pick `action`; each uses only the parameters named here.",
	"list (all?): this session's tasks with id, timing, next and last run, and the server's current time; all true lists every task on the server.",
	"create (prompt, at | inMinutes | everyMinutes, title?, session?): one-time with `at` or `inMinutes`, repeating with `everyMinutes` (first run one interval from now). Sent to this session unless `session` names another one (@name). Write the prompt as an instruction to your future self: that run sees the conversation but not this moment, and nobody is there to clarify.",
	"update (id, prompt?, title?, at? | inMinutes?, everyMinutes?, enabled?): change a task; a one-time task takes a new time, a repeating one a new interval; enabled false pauses it.",
	"delete (id): remove it. run (id): send it now; refused while its session is busy, so it cannot run a task of this session during your own run. A one-time task is used up by it.",
	"Times are the server's local time unless `at` carries an offset. A due task finding its session busy or closed is skipped, not queued. Set tasks up only when the user asked for something recurring or for later.",
].join("\n");

export const scheduleTool: ToolDef = {
	name: SCHEDULE_TOOL,
	description: "Set up, list, change, run and remove scheduled prompts (once at a time, or every so often).",
	create(_cwd, _roots, ctx) {
		return defineTool({
			name: SCHEDULE_TOOL,
			label: "Scheduled tasks",
			description: DESCRIPTION,
			parameters: Type.Object({
				action: Type.Unsafe<Action>({ type: "string", enum: [...ACTIONS] }),
				id: Type.Optional(Type.String({ maxLength: 60, description: "update, delete, run: the task id from list or create" })),
				prompt: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROMPT, description: "create, update: the message that will be sent" })),
				title: Type.Optional(Type.String({ maxLength: MAX_TITLE, description: "create, update: a short name the user sees in the list" })),
				at: Type.Optional(Type.String({ maxLength: 40, description: "create, update (one-time): when, ISO 8601, e.g. 2026-11-15T09:00 (server local) or 2026-11-15T09:00+09:00" })),
				inMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 60 * 24 * 366, description: "create, update (one-time): minutes from now, instead of `at`" })),
				everyMinutes: Type.Optional(Type.Integer({ minimum: MIN_EVERY_MS / 60_000, maximum: 30 * 24 * 60, description: "create, update (repeating): minutes between runs" })),
				enabled: Type.Optional(Type.Boolean({ description: "update: false pauses the task, true switches it on again" })),
				session: Type.Optional(Type.String({ maxLength: 60, description: "create: send to this other session (@name) instead of this one" })),
				all: Type.Optional(Type.Boolean({ description: "list: every task on the server, not only this session's" })),
			}),
			async execute(_id, p) {
				const ops = ctx?.schedules;
				if (!ops) throw new Error("scheduled tasks are not available in this session");
				const a: Action = p.action;
				const show = (t: ScheduleRecord) => describeTask(t, ops.label);
				switch (a) {
					case "list": {
						const all = ops.list(!!p.all);
						const head = `Server time now: ${localTime(ops.now())}.`;
						if (!all.length) return text(`${head} No scheduled tasks${p.all ? "" : " for this session"}.`, { action: a, count: 0 });
						return text(`${head} ${all.length} task(s):\n${all.map(show).join("\n")}`, { action: a, count: all.length });
					}
					case "create": {
						const prompt = need(p.prompt, "prompt", a);
						const runAt = timeOf(p, ops.now());
						if (runAt !== undefined && p.everyMinutes !== undefined) throw new Error("a task is either one-time (`at` / `inMinutes`) or repeating (`everyMinutes`), not both");
						if (runAt === undefined && p.everyMinutes === undefined) throw new Error("schedule create needs `at`, `inMinutes` or `everyMinutes`");
						const t = ops.create({ session: p.session, title: p.title, prompt, ...(runAt !== undefined ? { runAt } : { everyMs: p.everyMinutes! * 60_000 }) });
						return text(`Scheduled:\n${show(t)}`, { action: a, id: t.id });
					}
					case "update": {
						const id = need(p.id, "id", a);
						const runAt = timeOf(p, ops.now());
						const patch: PatchScheduleInput = {
							...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
							...(p.title !== undefined ? { title: p.title } : {}),
							...(runAt !== undefined ? { runAt } : {}),
							...(p.everyMinutes !== undefined ? { everyMs: p.everyMinutes * 60_000 } : {}),
							...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
						};
						if (!Object.keys(patch).length) throw new Error("schedule update needs something to change (prompt, title, at, inMinutes, everyMinutes or enabled)");
						return text(`Updated:\n${show(ops.update(id, patch))}`, { action: a, id });
					}
					case "delete": {
						const t = ops.delete(need(p.id, "id", a));
						return text(`Deleted:\n${show(t)}`, { action: a, id: t.id });
					}
					case "run": {
						const t = await ops.run(need(p.id, "id", a));
						return text(`Sent now:\n${show(t)}`, { action: a, id: t.id });
					}
				}
			},
		});
	},
};
