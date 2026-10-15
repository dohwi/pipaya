import type { Database } from "bun:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { badRequest } from "./errors.ts";
import type { ModelRegistry } from "./models.ts";
import { ModelChoice, type ModelChoiceValue } from "./model-choice.ts";

/** Recent history kept verbatim, and room left for the next answer before an automatic compaction fires. */
export const KEEP_RECENT_TOKENS = 20_000;
export const RESERVE_TOKENS = 16_384;
export const SUMMARY_MAX_TOKENS = 4096;
/** Characters of a single tool result / argument blob shown to the summarizer. */
const CLIP = 2000;

export const CompactionSettingsSchema = Type.Object(
	{
		auto: Type.Boolean({ description: "Compact automatically before a prompt when the context is nearly full" }),
		model: Type.Union([ModelChoice, Type.Null()], { description: "Model (and reasoning strength) that writes the summary. null = the session's own model, without extra reasoning" }),
	},
	{ additionalProperties: false },
);
export type CompactionSettingsValue = Static<typeof CompactionSettingsSchema>;
export const CompactionSettingsBody = CompactionSettingsSchema;
export const CompactionSettingsResult = Type.Object({ settings: CompactionSettingsSchema, defaults: CompactionSettingsSchema });
export const DEFAULT_COMPACTION_SETTINGS = (): CompactionSettingsValue => ({ auto: true, model: null });

const KEY = "compaction";

export class CompactionSettings {
	constructor(private db: Database, private registry: ModelRegistry) {}

	get(): CompactionSettingsValue {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		if (!row) return DEFAULT_COMPACTION_SETTINGS();
		try {
			const parsed = JSON.parse(row.data);
			return Value.Check(CompactionSettingsSchema, parsed) ? parsed : DEFAULT_COMPACTION_SETTINGS();
		} catch {
			return DEFAULT_COMPACTION_SETTINGS();
		}
	}

	set(next: CompactionSettingsValue): CompactionSettingsValue {
		if (next.model && !this.registry.models.getModel(next.model.provider, next.model.model)) {
			throw badRequest(`unknown model ${next.model.provider}/${next.model.model}`);
		}
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(next) });
		return this.get();
	}

	/**
	 * The model that writes the summary: the configured one while it still exists, otherwise the session's own
	 * model ("use the session model"). A configured model that was deleted falls back instead of failing.
	 */
	resolveModel(session: { provider: string; model: string }): ModelChoiceValue & { custom: boolean } {
		const chosen = this.get().model;
		if (chosen && this.registry.models.getModel(chosen.provider, chosen.model)) return { ...chosen, custom: true };
		return { provider: session.provider, model: session.model, custom: false };
	}
}

// ── pure helpers (no I/O, unit-testable) ────────────────────────────────────

const contentOf = (m: AgentMessage): unknown => (m as { content?: unknown }).content;

/** Rough token count (4 chars per token; images are a flat guess). Only used to choose a cut and a threshold. */
export function estimateTokens(m: AgentMessage): number {
	const c = contentOf(m);
	if (typeof c === "string") return Math.ceil(c.length / 4);
	if (!Array.isArray(c)) return 0;
	let chars = 0;
	for (const part of c as { type?: string; text?: string; thinking?: string; arguments?: unknown }[]) {
		if (part.type === "image") chars += 4800;
		else if (part.type === "toolCall") chars += JSON.stringify(part.arguments ?? {}).length + 20;
		else chars += (part.text ?? part.thinking ?? "").length;
	}
	return Math.ceil(chars / 4);
}

/**
 * Where to cut `messages`: everything before the returned index is summarized, the rest is kept as is. The cut
 * always lands on a user message, so a tool call is never separated from its result. Returns null when there is
 * no earlier user message to cut at (nothing worth summarizing).
 */
export function pickCut(messages: AgentMessage[], keepRecent = KEEP_RECENT_TOKENS): number | null {
	const candidates: number[] = [];
	messages.forEach((m, i) => { if (i > 0 && m.role === "user") candidates.push(i); });
	if (!candidates.length) return null;
	const suffix = new Array<number>(messages.length + 1).fill(0);
	for (let i = messages.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + estimateTokens(messages[i]!);
	return candidates.find((i) => suffix[i]! <= keepRecent) ?? candidates[candidates.length - 1]!;
}

const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}… [${s.length - CLIP} more characters]` : s);

/** Plain-text transcript for the summarizer. Tool output is clipped: the summary needs the gist, not the bytes. */
export function transcript(messages: AgentMessage[]): string {
	const out: string[] = [];
	for (const m of messages) {
		const c = contentOf(m);
		const parts = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? (c as any[]) : [];
		const texts: string[] = [];
		for (const p of parts) {
			if (p.type === "text" && p.text) texts.push(clip(p.text));
			else if (p.type === "image") texts.push("[image]");
			else if (p.type === "toolCall") texts.push(`[called ${p.name} ${clip(JSON.stringify(p.arguments ?? {}))}]`);
		}
		if (!texts.length) continue;
		const who = m.role === "toolResult" ? `tool result (${(m as { toolName?: string }).toolName ?? "?"})` : m.role;
		out.push(`[${who}]\n${texts.join("\n")}`);
	}
	return out.join("\n\n");
}

export const SUMMARY_SYSTEM = `You compress the earlier part of a coding-agent conversation so the agent can continue from your summary alone. Write a structured, factual summary. Keep: the user's goals and constraints, decisions made and why, files read or changed (with paths), commands run and their outcomes, errors and their fixes, and what is still open or next. Drop pleasantries and repetition. Do not invent anything. Do not answer or continue the conversation.`;

export function summaryRequest(previous: string | null, messages: AgentMessage[], instructions?: string, maxChars = 400_000): string {
	let body = transcript(messages);
	if (body.length > maxChars) body = `[earlier part omitted]\n${body.slice(body.length - maxChars)}`;
	return [
		previous ? `Summary so far (earlier compaction):\n${previous}\n\nNew conversation since then:` : "Conversation to summarize:",
		body,
		instructions?.trim() ? `\nExtra instructions from the user: ${instructions.trim()}` : "",
		"\nWrite the summary now.",
	].join("\n");
}

export const SUMMARY_PREFIX = "The earlier part of this conversation was compacted. Summary of what happened so far:\n\n";

export function summaryMessage(summary: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text: SUMMARY_PREFIX + summary }], timestamp: Date.now() } as AgentMessage;
}

/** Token level at which an automatic compaction fires: the window minus a reserve, but never below half of it. */
export const thresholdFor = (contextWindow: number): number => Math.max(Math.floor(contextWindow * 0.5), contextWindow - RESERVE_TOKENS);
