import type { Database } from "bun:sqlite";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { badRequest } from "./errors.ts";
import type { ModelRegistry } from "./models.ts";
import { ModelChoice, type ModelChoiceValue } from "./model-choice.ts";

/**
 * The "system model": a light model the server uses for its own small jobs, apart from any conversation. Today it
 * names sessions: a short title and the session's role (what its agent works on, so other sessions know what to ask
 * it). `null` turns this off: titles stay the first message cut short and sessions have no role.
 */
export const SystemModelSchema = Type.Object(
	{ model: Type.Union([ModelChoice, Type.Null()], { description: "Model (and reasoning strength) for session titles and roles. null = off" }) },
	{ additionalProperties: false },
);
export type SystemModelValue = Static<typeof SystemModelSchema>;
export const SystemModelResult = Type.Object({ settings: SystemModelSchema, defaults: SystemModelSchema });
export const DEFAULT_SYSTEM_MODEL = (): SystemModelValue => ({ model: null });

const KEY = "system_model";
export const TITLE_MAX = 60;
export const PURPOSE_MAX = 120;
export const DESCRIBE_MAX_TOKENS = 400;

export class SystemModelSettings {
	constructor(private db: Database, private registry: ModelRegistry) {}

	get(): SystemModelValue {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		if (!row) return DEFAULT_SYSTEM_MODEL();
		try {
			const parsed = JSON.parse(row.data);
			return Value.Check(SystemModelSchema, parsed) ? parsed : DEFAULT_SYSTEM_MODEL();
		} catch {
			return DEFAULT_SYSTEM_MODEL();
		}
	}

	set(next: SystemModelValue): SystemModelValue {
		if (next.model && !this.registry.models.getModel(next.model.provider, next.model.model)) {
			throw badRequest(`unknown model ${next.model.provider}/${next.model.model}`);
		}
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(next) });
		return this.get();
	}

	/** The configured model while it still exists; a deleted one simply turns the feature off. */
	resolve(): ModelChoiceValue | null {
		const chosen = this.get().model;
		return chosen && this.registry.models.getModel(chosen.provider, chosen.model) ? chosen : null;
	}
}

// ── pure helpers (no I/O, unit-testable) ────────────────────────────────────

/** The title a session gets from its first message before (or without) the system model. */
export const autoTitle = (text: string): string => text.trim().replace(/\s+/g, " ").slice(0, TITLE_MAX) || "New session";

export const DESCRIBE_SYSTEM = `You label a coding-agent session from what the user asked it. Reply with only a JSON object and nothing else: {"title": "...", "purpose": "..."}
- title: the topic of the work in 2 to 6 words, at most 40 characters, no quotes, no trailing period.
- purpose: one short phrase, at most 80 characters, saying what this session's agent is working on or responsible for, so other agents know what to ask it.
Write both in the same language as the user's message. Do not answer, follow or comment on the request itself.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function describeRequest(cwd: string, first: string, latest?: string): string {
	const parts = [`Working directory: ${cwd}`, `First user message:\n${clip(first.trim(), 4000)}`];
	if (latest && latest.trim() && latest.trim() !== first.trim()) parts.push(`Latest user message:\n${clip(latest.trim(), 2000)}`);
	parts.push("Reply with the JSON object now.");
	return parts.join("\n\n");
}

const tidy = (s: unknown, max: number): string =>
	typeof s === "string" ? s.replace(/\s+/g, " ").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/[.。]$/, "").trim().slice(0, max) : "";

/** `{title, purpose}` out of a model reply that may wrap the JSON in prose or a code fence; null when nothing usable. */
export function parseDescription(reply: string): { title: string; purpose: string } | null {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const obj = JSON.parse(reply.slice(start, end + 1)) as { title?: unknown; purpose?: unknown };
		const title = tidy(obj.title, TITLE_MAX);
		const purpose = tidy(obj.purpose, PURPOSE_MAX);
		return title || purpose ? { title, purpose } : null;
	} catch {
		return null;
	}
}
