import type { AssistantItem, ToolRun, UserItem } from "./types";

export type TranscriptUnit =
	| { kind: "user"; item: Pick<UserItem, "ts" | "goal"> }
	| { kind: "turn"; items: Pick<AssistantItem, "ts" | "durationMs" | "streaming" | "blocks">[] }
	| { kind: "notice" | "entry" };

export interface PromptDuration {
	/** Wall-clock milliseconds from the prompt's timestamp to the end of its completed work. */
	elapsedMs: number;
	/** Epoch milliseconds when the work for this prompt finished. */
	endedAt: number;
}

/**
 * Computes total wall-clock elapsed time for each completed user prompt unit.
 *
 * A prompt's work spans every following turn (including automatic goal continuations, `user.goal`)
 * until the next non-goal user prompt or the end of the transcript. While the trailing work is
 * still running or any assistant message in the span is streaming, no duration is returned so the
 * elapsed label only appears after the task finishes.
 */
export function promptDurations(
	units: readonly TranscriptUnit[],
	tools: Readonly<Record<string, Pick<ToolRun, "endedAt">>>,
	running: boolean,
): (PromptDuration | undefined)[] {
	const out: (PromptDuration | undefined)[] = new Array(units.length);
	for (let i = 0; i < units.length; i++) {
		const u = units[i]!;
		if (u.kind !== "user" || u.item.goal) continue;
		const startTs = u.item.ts;
		if (!startTs || startTs <= 0) continue;

		let j = i + 1;
		let hasTurn = false;
		let hasStreaming = false;
		let endTs = 0;

		for (; j < units.length; j++) {
			const next = units[j]!;
			if (next.kind === "user" && !next.item.goal) break;
			if (next.kind !== "turn") continue;
			hasTurn = true;
			for (const part of next.items) {
				if (part.streaming) hasStreaming = true;
				const partEnd = (part.ts || 0) + (part.durationMs ?? 0);
				if (partEnd > endTs) endTs = partEnd;
				for (const b of part.blocks) {
					if (b.type === "tool") {
						const ended = tools[b.id]?.endedAt;
						if (ended && ended > endTs) endTs = ended;
					}
				}
			}
		}

		const reachesTail = j === units.length;
		if ((running && reachesTail) || hasStreaming || !hasTurn || endTs <= startTs) continue;
		out[i] = { elapsedMs: endTs - startTs, endedAt: endTs };
	}
	return out;
}
