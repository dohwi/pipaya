import type { StoredMessage } from "./api";
import { textOf } from "./chat.svelte";
import { queuedShown } from "./queue";

/**
 * The graph view's side panel reads a chat on any server from its stored messages alone (no ChatState: that lives only
 * for the open server). This folds them into what the panel draws, in the chat's own order: what the user said, the
 * agent's text, and the tool calls between two texts as one work box, each call with its result once it came.
 */
export type QuickStep = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	/** pending: no result among the messages read (still running, or its result fell off the front of the window) */
	state: "pending" | "done" | "error";
	output: string;
	durationMs?: number;
	exitCode?: number;
};
export type QuickItem =
	| { kind: "user"; key: string; text: string }
	| { kind: "agent"; key: string; text: string }
	| { kind: "work"; key: string; steps: QuickStep[] };

type Block = { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };

export function quickItems(ms: readonly StoredMessage[]): QuickItem[] {
	const out: QuickItem[] = [];
	const byId = new Map<string, QuickStep>();
	for (const m of ms) {
		const msg = m.message as { role: string; content?: unknown; toolCallId?: string; isError?: boolean; details?: Record<string, unknown>; durationMs?: number };
		if (msg.role === "user") {
			const text = queuedShown(textOf(msg.content)).trim();
			if (text) out.push({ kind: "user", key: `u${m.seq}`, text });
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			(msg.content as Block[]).forEach((b, i) => {
				const last = out.at(-1);
				if (b?.type === "text" && b.text?.trim()) {
					// consecutive text blocks of one reply read as one
					if (last?.kind === "agent" && last.key.startsWith(`a${m.seq}.`)) last.text += `\n\n${b.text.trim()}`;
					else out.push({ kind: "agent", key: `a${m.seq}.${i}`, text: b.text.trim() });
				} else if (b?.type === "toolCall" && b.id) {
					const step: QuickStep = { id: b.id, name: String(b.name ?? ""), args: b.arguments ?? {}, state: "pending", output: "" };
					byId.set(b.id, step);
					// the calls between two texts are one box, across the model calls of one turn
					if (last?.kind === "work") last.steps.push(step);
					else out.push({ kind: "work", key: `w${m.seq}.${i}`, steps: [step] });
				}
			});
		} else if (msg.role === "toolResult" && msg.toolCallId) {
			const step = byId.get(msg.toolCallId);
			if (!step) continue;
			step.state = msg.isError ? "error" : "done";
			step.output = textOf(msg.content);
			step.durationMs = msg.durationMs;
			if (typeof msg.details?.exitCode === "number") step.exitCode = msg.details.exitCode;
		}
	}
	return out;
}
