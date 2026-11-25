/**
 * Cache-safe rare batched pruning of old, oversized `toolResult` text blocks.
 *
 * Prompt caches break whenever any earlier byte in the message prefix changes. Pruning every turn would bust the
 * cache on every turn; instead, `ContextPruneState` records the `toolCallId`s already cleared and only runs a new
 * pruning pass when:
 *   (a) newly prunable bytes outside the recent turn window reach `max(80 KiB, floor(contextWindow * 0.20 * 4))`, OR
 *   (b) the session has been idle for >= 5 minutes (prompt cache likely already cold) AND newly prunable bytes >= 24 KiB.
 * Between passes, only previously recorded `clearedToolCallIds` are replaced, keeping the prefix byte-identical.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const DEFAULT_KEEP_RECENT_TURNS = 6;
export const DEFAULT_PRUNE_MIN_CHARS = 2_000;
export const DEFAULT_PRUNE_BATCH_MIN_BYTES = 80_000;
export const DEFAULT_PRUNE_WINDOW_FRACTION = 0.20;
export const DEFAULT_PRUNE_IDLE_MS = 5 * 60_000;
export const DEFAULT_PRUNE_IDLE_MIN_BYTES = 24_000;

export interface ContextPruneState {
	clearedToolCallIds: Set<string>;
	lastModelCallAt: number;
}

export function createContextPruneState(): ContextPruneState {
	return { clearedToolCallIds: new Set(), lastModelCallAt: 0 };
}

export function resetContextPruneState(state: ContextPruneState): void {
	state.clearedToolCallIds.clear();
	state.lastModelCallAt = 0;
}

export interface PruneOptions {
	keepRecentTurns?: number;
	minChars?: number;
	contextWindow?: number;
	state?: ContextPruneState;
	now?: number;
}

export interface PruneResult {
	messages: AgentMessage[];
	/** `toolCallId`s cleared by this call (newly added when `state` is used, or all cleared when stateless). */
	prunedIds: string[];
	/** Total UTF-8 bytes saved across replaced text blocks in the returned messages. */
	clearedBytes: number;
	/** Whether a new batch pass triggered on this call (always true when stateless and anything was pruned). */
	triggered: boolean;
}

const SPILL_PATH_RE = /full output saved to ([^\n\]—]+?)(?:\s*—|\])/;

function extractSpillPath(message: AgentMessage, text: string): string | null {
	const details = (message as { details?: unknown }).details;
	if (details && typeof details === "object" && !Array.isArray(details)) {
		const p = (details as { spillPath?: unknown }).spillPath;
		if (typeof p === "string" && p.trim()) return p.trim();
	}
	const m = SPILL_PATH_RE.exec(text);
	return m?.[1]?.trim() || null;
}

function placeholderFor(message: AgentMessage, text: string): string {
	const spillPath = extractSpillPath(message, text);
	if (spillPath) {
		return `[earlier tool result cleared (${text.length} chars); full output saved to ${spillPath}; re-read/re-run if needed]`;
	}
	return `[earlier tool result cleared (${text.length} chars); re-read/re-run if needed]`;
}

/**
 * Returns the index in `messages` before which messages are older than the last `keepRecentTurns` assistant turns.
 * If fewer than or equal to `keepRecentTurns` assistant turns exist, returns `0` (nothing is old enough to prune).
 */
function recentTurnCutoff(messages: readonly AgentMessage[], keepRecentTurns: number): number {
	if (keepRecentTurns <= 0) return messages.length;
	let turns = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			turns++;
			if (turns >= keepRecentTurns) return i;
		}
	}
	return 0;
}

function prunableTextBytes(message: AgentMessage, minChars: number): number {
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return 0;
	let bytes = 0;
	for (const block of message.content) {
		if (block && block.type === "text" && typeof block.text === "string" && block.text.length >= minChars) {
			bytes += Buffer.byteLength(block.text, "utf8");
		}
	}
	return bytes;
}

function replaceLargeTextBlocks(message: AgentMessage, minChars: number): { message: AgentMessage; savedBytes: number } {
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return { message, savedBytes: 0 };
	let changed = false;
	let savedBytes = 0;
	const content = message.content.map((block) => {
		if (block && block.type === "text" && typeof block.text === "string" && block.text.length >= minChars) {
			changed = true;
			const replacement = placeholderFor(message, block.text);
			savedBytes += Math.max(0, Buffer.byteLength(block.text, "utf8") - Buffer.byteLength(replacement, "utf8"));
			return { ...block, text: replacement };
		}
		return block;
	});
	return changed ? { message: { ...message, content } as AgentMessage, savedBytes } : { message, savedBytes: 0 };
}

/**
 * Returns a stable per-message identity for a `toolResult` so duplicate `toolCallId`s reused across turns
 * (e.g. `call_0` from Google/OpenAI-compat gateways) or shifted array indices (e.g. when `syncSkills` inserts a
 * leading system message) never collide.
 */
function messagePruneKey(message: AgentMessage): string {
	const id = (message as { toolCallId?: unknown }).toolCallId;
	const ts = (message as { timestamp?: unknown }).timestamp;
	const tsPart = typeof ts === "number" && Number.isFinite(ts) ? String(ts) : "";
	if (typeof id === "string" && id) {
		return `${id}@${tsPart}`;
	}
	const name = (message as { toolName?: unknown }).toolName;
	const content = (message as { content?: unknown }).content;
	const textLen = Array.isArray(content)
		? content.reduce((sum, b) => sum + (b && b.type === "text" && typeof b.text === "string" ? b.text.length : 0), 0)
		: 0;
	return `anon:${typeof name === "string" ? name : ""}@${tsPart}:${textLen}`;
}

/**
 * Replaces large (`>= minChars`) `toolResult` text blocks older than the last `keepRecentTurns` assistant turns.
 * When `opts.state` is provided, enforces rare batched triggering so the prompt prefix stays cache-stable between passes.
 */
export function pruneOldToolResults(messages: AgentMessage[], opts: PruneOptions = {}): PruneResult {
	const keepRecentTurns = opts.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
	const minChars = opts.minChars ?? DEFAULT_PRUNE_MIN_CHARS;
	const now = opts.now ?? Date.now();
	const cutoff = recentTurnCutoff(messages, keepRecentTurns);
	const state = opts.state;

	let triggered = false;
	const newlyPruned: string[] = [];

	if (state) {
		let newlyPrunableBytes = 0;
		const candidateKeys: string[] = [];
		for (let i = 0; i < cutoff; i++) {
			const m = messages[i];
			if (!m || m.role !== "toolResult") continue;
			const key = messagePruneKey(m);
			if (state.clearedToolCallIds.has(key)) continue;
			const bytes = prunableTextBytes(m, minChars);
			if (bytes > 0) {
				newlyPrunableBytes += bytes;
				candidateKeys.push(key);
			}
		}

		const batchThreshold = Math.max(
			DEFAULT_PRUNE_BATCH_MIN_BYTES,
			Math.floor((opts.contextWindow ?? 0) * DEFAULT_PRUNE_WINDOW_FRACTION * 4),
		);
		// Treat cold-start / post-eviction (`lastModelCallAt === 0`) as idle since prompt cache is cold.
		const isIdle = state.lastModelCallAt === 0 || now - state.lastModelCallAt >= DEFAULT_PRUNE_IDLE_MS;
		const shouldTrigger =
			candidateKeys.length > 0 &&
			(newlyPrunableBytes >= batchThreshold || (isIdle && newlyPrunableBytes >= DEFAULT_PRUNE_IDLE_MIN_BYTES));

		if (shouldTrigger) {
			triggered = true;
			for (const key of candidateKeys) {
				state.clearedToolCallIds.add(key);
				newlyPruned.push(key);
			}
		}
		state.lastModelCallAt = now;

		if (state.clearedToolCallIds.size === 0 || cutoff <= 0) {
			return { messages, prunedIds: [], clearedBytes: 0, triggered: false };
		}

		let anyChanged = false;
		let clearedBytes = 0;
		const out = messages.map((m, i) => {
			// Never prune messages inside the protected recent-turn window (`i >= cutoff`).
			if (i >= cutoff || !m || m.role !== "toolResult") return m;
			const key = messagePruneKey(m);
			if (!state.clearedToolCallIds.has(key)) return m;
			const res = replaceLargeTextBlocks(m, minChars);
			if (res.message !== m) {
				anyChanged = true;
				clearedBytes += res.savedBytes;
			}
			return res.message;
		});
		return { messages: anyChanged ? out : messages, prunedIds: newlyPruned, clearedBytes, triggered };
	}

	// Stateless mode: prune all eligible old tool results immediately.
	if (cutoff <= 0) return { messages, prunedIds: [], clearedBytes: 0, triggered: false };
	let anyChanged = false;
	let clearedBytes = 0;
	const out = messages.map((m, i) => {
		if (i >= cutoff || !m || m.role !== "toolResult") return m;
		const res = replaceLargeTextBlocks(m, minChars);
		if (res.message !== m) {
			anyChanged = true;
			clearedBytes += res.savedBytes;
			newlyPruned.push(messagePruneKey(m));
		}
		return res.message;
	});
	return { messages: anyChanged ? out : messages, prunedIds: newlyPruned, clearedBytes, triggered: anyChanged };
}
