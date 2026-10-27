/**
 * Detects an agent run that has gone round in circles: too many model calls in one run, or the same tool call repeated turn after
 * turn. Pure (the limits are arguments), so the rule can be tested and tuned without a live session.
 */

export interface RunGuardState {
	/** Model calls so far in this run. */
	turns: number;
	/** The tool calls of the latest turns that ended in tool calls, newest last (a plain answer clears it). */
	recentCalls: string[];
}

export interface RunGuardLimits {
	maxTurns: number;
	maxRepeated: number;
}

/** A turn's tool calls as one comparable string (order does not matter); empty when it made none. */
export function callSignature(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "toolCall")
		.map((b) => `${b.name}:${JSON.stringify(b.arguments)}`)
		.sort()
		.join("|");
}

/** The state after one more turn whose message content was `content`. */
export function afterTurn(state: RunGuardState, content: unknown, limits: RunGuardLimits): RunGuardState {
	const calls = callSignature(content);
	// Only turns that ended in tool calls can be a loop; a plain answer ends the run on its own.
	return { turns: state.turns + 1, recentCalls: calls ? [...state.recentCalls, calls].slice(-limits.maxRepeated) : [] };
}

/** Why the run should stop now, or null to let it go on. */
export function runawayReason(state: RunGuardState, limits: RunGuardLimits): string | null {
	if (state.turns >= limits.maxTurns) return `Stopped after ${limits.maxTurns} model calls in one run. Send a message to continue.`;
	const { recentCalls } = state;
	if (recentCalls.length === limits.maxRepeated && recentCalls.every((c) => c === recentCalls[0])) {
		return `Stopped: the same tool call was repeated ${limits.maxRepeated} times in a row.`;
	}
	return null;
}
