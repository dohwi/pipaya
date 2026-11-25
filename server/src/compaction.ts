import type { Database } from "bun:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { badRequest } from "./errors.ts";
import type { ModelRegistry } from "./models.ts";
import { ModelChoice, type ModelChoiceValue } from "./model-choice.ts";

/** Recent history kept verbatim by a compaction. */
export const KEEP_RECENT_TOKENS = 20_000;
export const SUMMARY_MAX_TOKENS = 4096;
/** Characters of a single tool result / argument blob shown to the summarizer. */
const CLIP = 2000;

export const MIN_THRESHOLD_PERCENT = 30;
export const MAX_THRESHOLD_PERCENT = 95;
export const DEFAULT_THRESHOLD_PERCENT = 90;

export const CompactionSettingsSchema = Type.Object(
	{
		auto: Type.Boolean({ description: "Compact automatically before a prompt when the context is nearly full" }),
		model: Type.Union([ModelChoice, Type.Null()], { description: "Model (and reasoning strength) that writes the summary. null = the session's own model, without extra reasoning" }),
		thresholdPercent: Type.Integer({ minimum: MIN_THRESHOLD_PERCENT, maximum: MAX_THRESHOLD_PERCENT, description: "Automatic compaction runs before a prompt once the context uses at least this percent of the model's context window" }),
	},
	{ additionalProperties: false },
);
export type CompactionSettingsValue = Static<typeof CompactionSettingsSchema>;
/** `thresholdPercent` may be left out (older clients): the current value is kept. */
export const CompactionSettingsBody = Type.Object(
	{ auto: CompactionSettingsSchema.properties.auto, model: CompactionSettingsSchema.properties.model, thresholdPercent: Type.Optional(CompactionSettingsSchema.properties.thresholdPercent) },
	{ additionalProperties: false },
);
export type CompactionSettingsInput = Static<typeof CompactionSettingsBody>;
export const CompactionSettingsResult = Type.Object({ settings: CompactionSettingsSchema, defaults: CompactionSettingsSchema });
export const DEFAULT_COMPACTION_SETTINGS = (): CompactionSettingsValue => ({ auto: true, model: null, thresholdPercent: DEFAULT_THRESHOLD_PERCENT });

const KEY = "compaction";

export class CompactionSettings {
	constructor(private db: Database, private registry: ModelRegistry) {}

	get(): CompactionSettingsValue {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		if (!row) return DEFAULT_COMPACTION_SETTINGS();
		try {
			// Merge over the defaults so settings saved before a field existed keep their other values.
			const merged = { ...DEFAULT_COMPACTION_SETTINGS(), ...JSON.parse(row.data) };
			return Value.Check(CompactionSettingsSchema, merged) ? merged : DEFAULT_COMPACTION_SETTINGS();
		} catch {
			return DEFAULT_COMPACTION_SETTINGS();
		}
	}

	set(input: CompactionSettingsInput): CompactionSettingsValue {
		const next: CompactionSettingsValue = { ...input, thresholdPercent: input.thresholdPercent ?? this.get().thresholdPercent };
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
 * What the next request will carry. Anchors on the last real provider usage (input + output + cache, which
 * covers the system prompt and tool declarations) and adds a chars/4 estimate only for what came after it.
 * `since` is the latest compaction time: usage reported before it described the pre-compaction context, so it is
 * ignored, and with no newer reply the size is unknown (null) rather than a misleading estimate.
 */
export function contextTokens(messages: AgentMessage[], systemChars: number, since?: number): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string; timestamp?: number; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } };
		if (m.role !== "assistant" || m.stopReason === "aborted" || m.stopReason === "error" || !m.usage) continue;
		if (since !== undefined && !((m.timestamp ?? 0) > since)) continue;
		const u = m.usage;
		const used = u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		if (used <= 0) continue;
		let trailing = 0;
		for (let j = i + 1; j < messages.length; j++) trailing += estimateTokens(messages[j]!);
		return used + trailing;
	}
	if (since !== undefined) return null;
	return Math.ceil(systemChars / 4 + messages.reduce((n, m) => n + estimateTokens(m), 0));
}

/**
 * Like `contextTokens()`, but falls back to a chars/4 estimate when `contextTokens()` returns `null`
 * (for example immediately after a compaction before any new provider usage has arrived).
 */
export function effectiveContextTokens(messages: AgentMessage[], systemChars: number, since?: number): number {
	const measured = contextTokens(messages, systemChars, since);
	if (measured !== null) return measured;
	return Math.ceil(systemChars / 4 + messages.reduce((n, m) => n + estimateTokens(m), 0));
}

/**
 * Where to cut `messages`: everything before the returned index is summarized, the rest is kept as is. The cut
 * normally lands on a user message, so a tool call is never separated from its result. Returns null when there is
 * no earlier user message to cut at (nothing worth summarizing).
 * When `midRun` is true, any non-error/non-aborted assistant message is also a candidate.
 * When `fallbackToAssistant` is true (e.g. manual `/compact` on a single-prompt long run) and no user cut point exists,
 * falls back to a non-error/non-aborted assistant boundary if the total tokens exceed `keepRecent`.
 */
export function pickCut(messages: AgentMessage[], keepRecent = KEEP_RECENT_TOKENS, midRun = false, fallbackToAssistant = false): number | null {
	const suffix = new Array<number>(messages.length + 1).fill(0);
	for (let i = messages.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + estimateTokens(messages[i]!);

	const candidates: number[] = [];
	const okAssistantAt = (m: AgentMessage) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted";
	// Mid-run (one long prompt with many tool turns) there may be no later user message; a turn's assistant message is
	// also a safe cut, because its tool results follow it and stay with it. Never cut at a failed/aborted tail reply.
	messages.forEach((m, i) => {
		if (i > 0 && (m.role === "user" || (midRun && okAssistantAt(m)))) candidates.push(i);
	});
	if (!candidates.length && !midRun && fallbackToAssistant && suffix[0]! > keepRecent) {
		messages.forEach((m, i) => {
			if (i > 0 && okAssistantAt(m)) candidates.push(i);
		});
	}
	if (!candidates.length) return null;
	return candidates.find((i) => suffix[i]! <= keepRecent) ?? candidates[candidates.length - 1]!;
}

const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}… [${s.length - CLIP} more characters]` : s);

/** Plain-text transcript for the summarizer. Tool output is clipped: the summary needs the gist, not the bytes. */
export function transcript(messages: AgentMessage[]): string {
	const out: string[] = [];
	for (const m of messages) {
		const c = contentOf(m);
		const parts = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? (c as { type?: string; text?: string; name?: string; arguments?: unknown }[]) : [];
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

/** The fixed wording of the request the summarizer gets (the conversation itself is filled in). */
export const SUMMARY_REQUEST_TEMPLATE = [
	"Conversation to summarize:  (or, after an earlier compaction: \"Summary so far (earlier compaction): …\" and \"New conversation since then:\")",
	"${the earlier part of the conversation, as a transcript}",
	"Extra instructions from the user: ${text of /compact, when given}",
	"Write the summary now.",
].join("\n");

export function summaryBudgetChars(contextWindow?: number): number {
	return contextWindow ? Math.min(400_000, Math.max(24_000, Math.floor(contextWindow * 0.65 * 4))) : 400_000;
}

export function summaryRequest(
	previous: string | null,
	messages: AgentMessage[],
	instructions?: string,
	maxChars?: number,
	contextWindow?: number,
): string {
	const limit = maxChars ?? summaryBudgetChars(contextWindow);
	let body = transcript(messages);
	if (body.length > limit) body = `[earlier part omitted]\n${body.slice(body.length - limit)}`;
	return [
		previous ? `Summary so far (earlier compaction):\n${previous}\n\nNew conversation since then:` : "Conversation to summarize:",
		body,
		instructions?.trim() ? `\nExtra instructions from the user: ${instructions.trim()}` : "",
		"\nWrite the summary now.",
	].join("\n");
}

export interface TouchedFiles {
	read: string[];
	modified: string[];
}

/** Deterministically extracts deduplicated `read` paths and `write`/`edit` modified paths from messages. */
export function aggregateTouchedFiles(messages: readonly AgentMessage[]): TouchedFiles {
	const failedIds = new Set<string>();
	const readSet = new Set<string>();
	const modifiedSet = new Set<string>();

	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		const tr = m as { toolName?: string; toolCallId?: string; isError?: boolean; details?: unknown };
		if (tr.isError) {
			if (typeof tr.toolCallId === "string") failedIds.add(tr.toolCallId);
			continue;
		}
		const path = tr.details && typeof tr.details === "object" && !Array.isArray(tr.details)
			? (tr.details as { path?: unknown }).path
			: undefined;
		if (typeof path !== "string" || !path.trim()) continue;
		if (tr.toolName === "read") readSet.add(path.trim());
		else if (tr.toolName === "write" || tr.toolName === "edit") modifiedSet.add(path.trim());
	}

	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const part of m.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
			if (part.type !== "toolCall") continue;
			if (typeof part.id === "string" && failedIds.has(part.id)) continue;
			const path = part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments)
				? (part.arguments as { path?: unknown }).path
				: undefined;
			if (typeof path !== "string" || !path.trim()) continue;
			if (part.name === "read") readSet.add(path.trim());
			else if (part.name === "write" || part.name === "edit") modifiedSet.add(path.trim());
		}
	}

	return {
		read: [...readSet].sort(),
		modified: [...modifiedSet].sort(),
	};
}

/** Formats touched files into a deterministic block suitable for appending to a compaction summary. */
export function formatTouchedFiles(messages: readonly AgentMessage[]): string {
	const { read, modified } = aggregateTouchedFiles(messages);
	if (!read.length && !modified.length) return "";
	const lines = ["Files touched before compaction:"];
	if (modified.length) lines.push(`- Modified: ${modified.join(", ")}`);
	if (read.length) lines.push(`- Read: ${read.join(", ")}`);
	return lines.join("\n");
}

export const SUMMARY_PREFIX = "The earlier part of this conversation was compacted. Summary of what happened so far:\n\n";

export function summaryMessage(summary: string, touchedFiles?: string): AgentMessage {
	const suffix = touchedFiles?.trim() ? `\n\n${touchedFiles.trim()}` : "";
	return { role: "user", content: [{ type: "text", text: SUMMARY_PREFIX + summary + suffix }], timestamp: Date.now() } as AgentMessage;
}

/** Token level at which an automatic compaction fires: `percent` of the context window. */
export const thresholdFor = (contextWindow: number, percent: number = DEFAULT_THRESHOLD_PERCENT): number => Math.floor((contextWindow * percent) / 100);
