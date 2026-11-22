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
