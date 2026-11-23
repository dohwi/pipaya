import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageNote } from "./extensions/types.ts";
import type { Live } from "./session-types.ts";

/**
 * Stored after the text of a message a scheduled task sent. The client hides the block and labels the message "예약";
 * the model reads the sentence, so it knows nobody is typing and a question may wait a long time for an answer.
 */
export const SCHEDULE_OPEN = "<pipaya-schedule>";
export const SCHEDULE_NOTE = `${SCHEDULE_OPEN}This message was sent automatically by a scheduled task, not typed by the user right now.</pipaya-schedule>`;

/**
 * Stored after the text of an automatic goal continuation turn. The client hides the block and renders the turn as a
 * quiet divider line rather than a user bubble, and skips it in ↑ prompt recall.
 */
export const GOAL_OPEN = "<pipaya-goal>";
export const GOAL_NOTE = `${GOAL_OPEN}This turn was started automatically to continue the active session goal, not typed by the user.</pipaya-goal>`;

/**
 * The text a queued message was sent with (what `message_queued` announced), before the server added its hint, file
 * and schedule notes. Lets the queue be listed, cancelled and dropped under the same text a client saw queued.
 */
export const sentText = new WeakMap<AgentMessage, string>();

/** A queued message's text: as sent, or (queued by an older path) every text part joined. */
export function queuedText(m: AgentMessage): string {
	const known = sentText.get(m);
	if (known !== undefined) return known;
	const c = (m as { content?: unknown }).content;
	return typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b?.type === "text" ? b.text : "")).join("") : "";
}

/** pi-agent-core has no read or per-item API for its queues; they are plain arrays. */
export function agentQueue(live: Live, mode: "steer" | "follow_up"): AgentMessage[] | undefined {
	const queue = (live.agent as unknown as Record<string, { messages?: AgentMessage[] } | undefined>)[mode === "steer" ? "steeringQueue" : "followUpQueue"];
	return Array.isArray(queue?.messages) ? queue.messages : undefined;
}

export type Waiting = { mode: "steer" | "follow_up"; text: string; deferred?: boolean };

/** What waits for a live run, in delivery order: steers, follow-ups, then what the server holds (see Deferred). */
export function queuedIn(live: Live): Waiting[] {
	const out: Waiting[] = [];
	for (const mode of ["steer", "follow_up"] as const) for (const m of agentQueue(live, mode) ?? []) out.push({ mode, text: queuedText(m) });
	for (const d of live.deferred ?? []) out.push({ mode: "follow_up", text: d.text, deferred: true });
	return out;
}

export const NOTE_OPEN = "<pipaya-note>";
const NOTE_CLOSE = "</pipaya-note>";

/** A note for the client, stored with the user message: `{ text, collapse?, data?, call }` (`call` = what the user typed). */
export function noteBlock(note: MessageNote, call: string): string {
	const body = { text: String(note.text).slice(0, 200), ...(note.collapse ? { collapse: true } : {}), ...(note.data !== undefined ? { data: note.data } : {}), call: call.slice(0, 2000) };
	return `${NOTE_OPEN}${JSON.stringify(body).slice(0, 16_000)}${NOTE_CLOSE}`;
}

/** The model never sees notes: they are for the people reading the transcript. */
export function withoutNotes(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((m) => {
		if (m.role !== "user" || !Array.isArray(m.content)) return m;
		const kept = m.content.filter((c) => !(c.type === "text" && c.text.startsWith(NOTE_OPEN)));
		return kept.length === m.content.length ? m : { ...m, content: kept };
	});
}

/** Strip the heavy `partial` snapshot from stream deltas; clients rebuild from deltas. */
export function slimAssistantEvent(e: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"]): unknown {
	const { partial: _partial, ...rest } = e as typeof e & { partial?: unknown };
	return rest;
}

export interface UnresolvedToolCall {
	id: string;
	name: string;
}

/**
 * Tool calls in the latest non-failed assistant message that do not yet have a matching `toolResult` after it.
 * Used when finalizing a run interrupted mid-tool by a server shutdown or crash, so UI tool cards close cleanly
 * and `retry` can continue from a valid `toolResult` tail.
 */
export function unresolvedToolCalls(messages: readonly AgentMessage[]): UnresolvedToolCall[] {
	let assistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const r = messages[i]!.role;
		if (r === "assistant") { assistantIdx = i; break; }
		if (r === "user") return [];
	}
	if (assistantIdx < 0) return [];
	const assistant = messages[assistantIdx] as { stopReason?: string; content?: unknown };
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted" || !Array.isArray(assistant.content)) return [];
	const calls = assistant.content.filter((b): b is { type: "toolCall"; id: string; name: string } => b?.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string");
	if (!calls.length) return [];
	const resolved = new Set<string>();
	for (let i = assistantIdx + 1; i < messages.length; i++) {
		const m = messages[i] as { role?: string; toolCallId?: string };
		if (m.role === "toolResult" && typeof m.toolCallId === "string") resolved.add(m.toolCallId);
	}
	return calls.filter((c) => !resolved.has(c.id)).map((c) => ({ id: c.id, name: c.name }));
}

export function interruptedToolResult(call: UnresolvedToolCall, reason: string, now = Date.now()): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: reason }],
		isError: true,
		timestamp: now,
	} as AgentMessage;
}

const GENERIC_TOOL_ABORTS = new Set([
	"Operation aborted",
	"Run aborted while waiting for the user",
	"delegate aborted",
	"aborted",
]);

/** Replaces generic abort wording in a tool error result with the server-shutdown reason while keeping any partial command output. */
export function rewriteShutdownToolText(text: string, reason: string): string {
	const trimmed = text.trim();
	if (!trimmed || GENERIC_TOOL_ABORTS.has(trimmed) || trimmed === "Command aborted") return reason;
	if (text.startsWith("Command aborted\n")) {
		const rest = text.slice("Command aborted\n".length);
		return rest.trim() ? `${reason}\n${rest}` : reason;
	}
	return text;
}

export function interruptedAssistantMessage(meta: { provider: string; model: string; api?: string }, reason: string, now = Date.now()): AgentMessage {
	return {
		role: "assistant",
		content: [],
		api: meta.api ?? "openai-completions",
		provider: meta.provider,
		model: meta.model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: reason,
		timestamp: now,
	} as unknown as AgentMessage;
}
