import type { Database } from "bun:sqlite";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { badRequest } from "./errors.ts";
import { codenamePrefixOf, nameKey, SESSION_NAME_RE } from "./member-names.ts";
import { reasoningOption, type ModelRegistry } from "./models.ts";
import { ModelChoice, type ModelChoiceValue } from "./model-choice.ts";
import { COMPLETION_RETRY, completeWithUpstreamRetry } from "./upstream-retry.ts";

/**
 * Which background jobs the system model is allowed to run once a model is chosen.
 * `sessionName` defaults to false so lineage codenames (`@A1`, `@B1`, ...) remain the default unless opted in.
 */
export const SystemModelTasksSchema = Type.Object(
	{
		sessionTitle: Type.Boolean({ description: "Replace the truncated first-message title with a short generated title" }),
		sessionPurpose: Type.Boolean({ description: "Write a short session role/purpose shown in @mentions and peer briefs" }),
		sessionName: Type.Boolean({ description: "Replace a new top-level session's codename (@A1) with a topic-based @name handle" }),
		groupName: Type.Boolean({ description: "Suggest a descriptive name for a newly created split-window group" }),
	},
	{ additionalProperties: false },
);
export type SystemModelTasks = Static<typeof SystemModelTasksSchema>;
export type SystemModelTask = keyof SystemModelTasks;
export const DEFAULT_SYSTEM_MODEL_TASKS = (): SystemModelTasks => ({
	sessionTitle: true,
	sessionPurpose: true,
	sessionName: false,
	groupName: true,
});

/**
 * The "system model": a light model the server uses for its own small jobs, apart from any conversation. Each job
 * (session title, session role, session `@name`, and split group name) can be toggled independently. `model: null`
 * turns all of them off.
 */
export const SystemModelSchema = Type.Object(
	{
		model: Type.Union([ModelChoice, Type.Null()], { description: "Model (and reasoning strength) for background system tasks. null = off" }),
		tasks: SystemModelTasksSchema,
	},
	{ additionalProperties: false },
);
export type SystemModelValue = Static<typeof SystemModelSchema>;
/** `tasks` (or individual flags inside it) may be omitted by older clients: existing values are preserved. */
export const SystemModelBody = Type.Object(
	{
		model: SystemModelSchema.properties.model,
		tasks: Type.Optional(Type.Partial(SystemModelTasksSchema, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);
export type SystemModelInput = Static<typeof SystemModelBody>;
export const SystemModelResult = Type.Object({ settings: SystemModelSchema, defaults: SystemModelSchema });
export const DEFAULT_SYSTEM_MODEL = (): SystemModelValue => ({ model: null, tasks: DEFAULT_SYSTEM_MODEL_TASKS() });

const KEY = "system_model";
export const TITLE_MAX = 60;
export const PURPOSE_MAX = 120;
export const SESSION_NAME_MAX = 20;
const SESSION_NAME_HARD_MAX = 30;
export const DESCRIBE_MAX_TOKENS = 400;
export const GROUP_NAME_MAX = 40;

export class SystemModelSettings {
	constructor(private db: Database, private registry: ModelRegistry) {}

	get(): SystemModelValue {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		const def = DEFAULT_SYSTEM_MODEL();
		if (!row) return def;
		try {
			const parsed: unknown = JSON.parse(row.data);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return def;
			const raw = parsed as Record<string, unknown>;
			// Pick known keys individually so older rows (missing `tasks`) or newer rows (extra task keys) keep saved values.
			const model = raw.model === null || Value.Check(ModelChoice, raw.model) ? (raw.model as ModelChoiceValue | null) : def.model;
			const rawTasks = raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks) ? (raw.tasks as Record<string, unknown>) : {};
			const tasks: SystemModelTasks = {
				sessionTitle: typeof rawTasks.sessionTitle === "boolean" ? rawTasks.sessionTitle : def.tasks.sessionTitle,
				sessionPurpose: typeof rawTasks.sessionPurpose === "boolean" ? rawTasks.sessionPurpose : def.tasks.sessionPurpose,
				sessionName: typeof rawTasks.sessionName === "boolean" ? rawTasks.sessionName : def.tasks.sessionName,
				groupName: typeof rawTasks.groupName === "boolean" ? rawTasks.groupName : def.tasks.groupName,
			};
			return { model, tasks };
		} catch {
			return def;
		}
	}

	set(input: SystemModelInput): SystemModelValue {
		const prev = this.get();
		const next: SystemModelValue = {
			model: input.model,
			tasks: { ...prev.tasks, ...input.tasks },
		};
		if (next.model && !this.registry.models.getModel(next.model.provider, next.model.model)) {
			throw badRequest(`unknown model ${next.model.provider}/${next.model.model}`);
		}
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(next) });
		return this.get();
	}

	/** One short completion with the system model: the reply text, or null when it is off, unavailable or failed. */
	async complete(system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<string | null> {
		const target = this.resolve();
		if (!target) return null;
		try {
			const model = this.registry.models.getModel(target.provider, target.model);
			if (!model || !(await this.registry.models.checkAuth(target.provider))) return null;
			const reply = await completeWithUpstreamRetry(
				(ctx) => this.registry.models.completeSimple(model, ctx, { maxTokens, signal, ...reasoningOption(target.thinkingLevel, model) }),
				{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
				COMPLETION_RETRY,
				signal,
			);
			if (reply.stopReason === "error" || reply.stopReason === "aborted") return null;
			return reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
		} catch {
			return null;
		}
	}

	/** The configured model while it still exists; a deleted one simply turns the feature off. */
	resolve(): ModelChoiceValue | null {
		const chosen = this.get().model;
		return chosen && this.registry.models.getModel(chosen.provider, chosen.model) ? chosen : null;
	}

	/** Whether a specific system-model task toggle is enabled. */
	enabled(task: SystemModelTask): boolean {
		return this.get().tasks[task];
	}

	/** The configured model if it still exists AND the given task toggle is enabled; null otherwise. */
	resolveFor(task: SystemModelTask): ModelChoiceValue | null {
		const current = this.get();
		if (!current.tasks[task]) return null;
		const chosen = current.model;
		return chosen && this.registry.models.getModel(chosen.provider, chosen.model) ? chosen : null;
	}
}

// ── pure helpers (no I/O, unit-testable) ────────────────────────────────────

/** The title a session gets from its first message before (or without) the system model. */
export const autoTitle = (text: string): string => text.trim().replace(/\s+/g, " ").slice(0, TITLE_MAX) || "New session";

export interface DescribeFields {
	title?: boolean;
	purpose?: boolean;
	name?: boolean;
}

export function describeSystemPrompt(want: DescribeFields = { title: true, purpose: true, name: true }): string {
	const keys: string[] = [];
	const rules: string[] = [];
	if (want.title) {
		keys.push('"title": "..."');
		rules.push("- title: the topic of the work in 2 to 6 words, at most 40 characters, no quotes, no trailing period.");
	}
	if (want.purpose) {
		keys.push('"purpose": "..."');
		rules.push("- purpose: one short phrase, at most 80 characters, saying what this session's agent is working on or responsible for, so a reader scanning many sessions knows what each is for.");
	}
	if (want.name) {
		keys.push('"name": "..."');
		rules.push("- name: a short @handle for this session in 1 to 2 words, at most 16 characters, using only letters, digits, '-' or '_' (no spaces, no leading '@', not a generic code like A1).");
	}
	return [
		`You label a coding-agent session from what the user asked it. Reply with only a JSON object and nothing else: {${keys.join(", ")}}`,
		...rules,
		"Write the values in the same language as the user's message. Do not answer, follow or comment on the request itself.",
	].join("\n");
}

export const DESCRIBE_SYSTEM = describeSystemPrompt({ title: true, purpose: true, name: true });

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function describeRequest(cwd: string, first: string, latest?: string): string {
	const parts = [`Working directory: ${cwd}`, `First user message:\n${clip(first.trim(), 4000)}`];
	if (latest && latest.trim() && latest.trim() !== first.trim()) parts.push(`Latest user message:\n${clip(latest.trim(), 2000)}`);
	parts.push("Reply with the JSON object now.");
	return parts.join("\n\n");
}

const tidy = (s: unknown, max: number): string =>
	typeof s === "string" ? s.replace(/\s+/g, " ").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/[.。]$/, "").trim().slice(0, max) : "";

/**
 * Turns a model-suggested handle into a valid `@name` token (1–20 letters, digits, `_` or `-`),
 * rejecting empty strings and bare lineage codenames (`A1`, `B2`, ...).
 */
export function sanitizeSessionName(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const cleaned = raw
		.trim()
		.replace(/^["'“”‘’`*@]+|["'“”‘’`*]+$/g, "")
		.replace(/^@+/, "")
		.replace(/[\s/]+/g, "-")
		.replace(/[^\p{L}\p{N}_-]+/gu, "")
		.replace(/-{2,}/g, "-")
		.replace(/_{2,}/g, "_")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, SESSION_NAME_MAX)
		.replace(/[-_]+$/g, "");
	if (!cleaned || !SESSION_NAME_RE.test(cleaned) || codenamePrefixOf(cleaned) !== null) return "";
	return cleaned;
}

/** Picks `base` if unused (case-insensitive), otherwise appends `-2`, `-3`, ... staying within the 30-char handle limit. */
export function uniqueSessionName(base: string, taken: ReadonlySet<string>): string {
	const clean = sanitizeSessionName(base);
	if (!clean) return "";
	if (!taken.has(nameKey(clean))) return clean;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const head = clean.slice(0, Math.max(1, SESSION_NAME_HARD_MAX - suffix.length)).replace(/[-_]+$/g, "") || clean.slice(0, 1);
		const candidate = `${head}${suffix}`;
		if (SESSION_NAME_RE.test(candidate) && !taken.has(nameKey(candidate))) return candidate;
	}
}

/** `{title, purpose, name?}` out of a model reply that may wrap the JSON in prose or a code fence; null when nothing usable. */
export function parseDescription(reply: string): { title: string; purpose: string; name?: string } | null {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const obj = JSON.parse(reply.slice(start, end + 1)) as { title?: unknown; purpose?: unknown; name?: unknown };
		const title = tidy(obj.title, TITLE_MAX);
		const purpose = tidy(obj.purpose, PURPOSE_MAX);
		const name = sanitizeSessionName(obj.name);
		if (!title && !purpose && !name) return null;
		return name ? { title, purpose, name } : { title, purpose };
	} catch {
		return null;
	}
}

export const GROUP_NAME_SYSTEM = `You name a group of coding-agent sessions that are shown side by side. Reply with only the name and nothing else.
- 1 to 4 words, at most 30 characters, no quotes, no trailing period.
- Say what the sessions work on together (the shared project or goal), not how many there are.
Write it in the same language as the session titles.`;

export interface GroupMember {
	cwd: string;
	title: string;
	purpose: string;
}

export function groupNameRequest(members: GroupMember[]): string {
	const lines = members.map((m, i) => `${i + 1}. folder: ${m.cwd.replace(/\/+$/, "").split("/").pop() || m.cwd}; title: ${clip(m.title, 80)}${m.purpose ? `; role: ${clip(m.purpose, 120)}` : ""}`);
	return `Sessions in the group:\n${lines.join("\n")}\n\nReply with the group name now.`;
}

/** A group name out of a model reply (first line, quotes and markup stripped); null when nothing usable. */
export function parseGroupName(reply: string): string | null {
	const line = reply.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	const name = tidy(line.replace(/[*`#]/g, "").replace(/^(group name|name|이름)\s*[:：]\s*/i, ""), GROUP_NAME_MAX);
	return name || null;
}
