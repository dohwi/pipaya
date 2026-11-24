import type { ChatState } from "./chat.svelte";

export interface WorkspaceEntry {
	name: string;
	path: string;
	dir: boolean;
}

export interface WorkspaceChange {
	path: string;
	oldPath?: string;
	status: "M" | "A" | "D" | "R" | "?" | "U";
	additions: number;
	deletions: number;
	/** True while the tool call is still in-flight (not yet finished writing to disk). */
	pending?: boolean;
}

export interface DiffLine {
	type: "context" | "add" | "del" | "meta";
	oldLine: number | null;
	newLine: number | null;
	text: string;
}

export interface DiffHunk {
	header: string;
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

export interface WorkspaceFileData {
	path: string;
	content: string;
	binary: boolean;
	truncated: boolean;
	size: number;
	lineCount: number;
}

export interface WorkspaceDiffData {
	path: string;
	isRepo: boolean;
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
	binary: boolean;
	truncated: boolean;
}

export function normalizeRelPath(raw: string, workDir: string): string {
	let clean = raw.trim().replace(/\\/g, "/");
	if (workDir) {
		const normDir = workDir.replace(/\\/g, "/").replace(/\/+$/, "");
		if (normDir && clean.startsWith(`${normDir}/`)) {
			clean = clean.slice(normDir.length + 1);
		}
	}
	return clean.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Find 1-based starting line of `needle` inside `haystack` so diff hunks show real file line numbers. */
function findStartLine(haystack: string | undefined, needle: string): number {
	if (!haystack || !needle) return 1;
	const idx = haystack.indexOf(needle);
	if (idx < 0) return 1;
	let line = 1;
	for (let i = 0; i < idx; i++) {
		if (haystack.charCodeAt(i) === 10) line++;
	}
	return line;
}

export function buildEditHunk(
	oldText: string,
	newText: string,
	fileContent?: string,
): { hunk: DiffHunk; additions: number; deletions: number } {
	const oldLines = oldText ? oldText.replace(/\r?\n$/, "").split(/\r?\n/) : [];
	const newLines = newText ? newText.replace(/\r?\n$/, "").split(/\r?\n/) : [];
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}
	const baseLine = findStartLine(fileContent, newText || oldText);
	const ctxStart = Math.max(0, prefix - 2);
	const oldEnd = oldLines.length - suffix;
	const newEnd = newLines.length - suffix;
	const ctxEnd = Math.min(oldLines.length, oldEnd + 2);
	const lines: DiffLine[] = [];
	let ol = baseLine + ctxStart;
	let nl = baseLine + ctxStart;
	const startLine = ol;
	for (let i = ctxStart; i < prefix; i++) lines.push({ type: "context", oldLine: ol++, newLine: nl++, text: oldLines[i]! });
	let deletions = 0;
	for (let i = prefix; i < oldEnd; i++) {
		deletions++;
		lines.push({ type: "del", oldLine: ol++, newLine: null, text: oldLines[i]! });
	}
	let additions = 0;
	for (let i = prefix; i < newEnd; i++) {
		additions++;
		lines.push({ type: "add", oldLine: null, newLine: nl++, text: newLines[i]! });
	}
	for (let i = oldEnd; i < ctxEnd; i++) lines.push({ type: "context", oldLine: ol++, newLine: nl++, text: oldLines[i]! });
	return {
		hunk: {
			header: `@@ -${startLine},${Math.max(1, ol - startLine)} +${startLine},${Math.max(1, nl - startLine)} @@`,
			oldStart: startLine,
			newStart: startLine,
			lines,
		},
		additions,
		deletions,
	};
}

/**
 * Extract ONLY the most recent editing turn's changes (including in-flight/pending edits) from the active session's chat.
 * Unrelated dirty files in the git repository are intentionally excluded so the "변경됨" tab only shows what was just edited.
 */
export function deriveLatestTurnEdits(
	chat: ChatState | null | undefined,
	workDir: string,
	contentFor?: (path: string) => string | undefined,
): {
	turnKey: string | null;
	changes: WorkspaceChange[];
	diffs: Map<string, WorkspaceDiffData>;
} {
	if (!chat || chat.items.length === 0) return { turnKey: null, changes: [], diffs: new Map() };

	// Group items into turns split on each user message.
	const turns: { key: string; items: typeof chat.items }[] = [];
	let cur: { key: string; items: typeof chat.items } = { key: "turn:0", items: [] };
	for (const item of chat.items) {
		if (item.kind === "user") {
			if (cur.items.length > 0) turns.push(cur);
			cur = { key: item.key, items: [item] };
		} else {
			cur.items.push(item);
		}
	}
	if (cur.items.length > 0) turns.push(cur);

	// Pick the latest turn that actually contains an active/completed `edit` or `write` tool call.
	for (let tIdx = turns.length - 1; tIdx >= 0; tIdx--) {
		const turn = turns[tIdx]!;
		const changesMap = new Map<string, WorkspaceChange>();
		const diffs = new Map<string, WorkspaceDiffData>();
		const sigParts: string[] = [turn.key];

		for (const item of turn.items) {
			if (item.kind !== "assistant") continue;
			for (const block of item.blocks) {
				if (block.type !== "tool" || (block.name !== "edit" && block.name !== "write")) continue;
				const run = block.id ? chat.tools[block.id] : undefined;
				if (run?.state === "error" || run?.state === "skipped") continue;
				const rawPath = typeof block.args.path === "string" ? block.args.path.trim() : "";
				if (!rawPath) continue;
				const path = normalizeRelPath(rawPath, workDir);
				if (!path) continue;

				const pending =
					run?.state === "running" ||
					run?.state === "pending" ||
					run?.state === "awaiting_input" ||
					(item.streaming && (!run || run.state !== "done"));
				sigParts.push(`${block.id || block.name}:${path}`);

				let change = changesMap.get(path);
				if (!change) {
					change = {
						path,
						status: block.name === "write" ? "A" : "M",
						additions: 0,
						deletions: 0,
						pending,
					};
					changesMap.set(path, change);
				} else if (pending) {
					change.pending = true;
				}

				let diff = diffs.get(path);
				if (!diff) {
					diff = { path, isRepo: false, hunks: [], additions: 0, deletions: 0, binary: false, truncated: false };
					diffs.set(path, diff);
				}

				if (block.name === "edit") {
					const oldText = typeof block.args.oldText === "string" ? block.args.oldText : "";
					const newText = typeof block.args.newText === "string" ? block.args.newText : "";
					if (oldText || newText) {
						const built = buildEditHunk(oldText, newText, contentFor?.(path));
						change.additions += built.additions;
						change.deletions += built.deletions;
						diff.additions += built.additions;
						diff.deletions += built.deletions;
						diff.hunks.push(built.hunk);
					}
				} else {
					const content = typeof block.args.content === "string" ? block.args.content : "";
					const rows = content ? content.replace(/\r?\n$/, "").split(/\r?\n/) : [];
					const clipped = rows.slice(0, 400);
					change.additions += rows.length;
					diff.additions += rows.length;
					diff.truncated = rows.length > 400;
					diff.hunks = clipped.length
						? [{
							header: `@@ -0,0 +1,${rows.length} @@`,
							oldStart: 0,
							newStart: 1,
							lines: clipped.map((text, idx) => ({ type: "add", oldLine: null, newLine: idx + 1, text })),
						}]
						: [];
				}
			}
		}

		if (changesMap.size > 0) {
			return {
				turnKey: sigParts.join("|"),
				changes: [...changesMap.values()],
				diffs,
			};
		}
	}

	return { turnKey: null, changes: [], diffs: new Map() };
}
