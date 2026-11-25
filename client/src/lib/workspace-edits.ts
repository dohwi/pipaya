import type { ChatState } from "./chat.svelte";

/** Custom drag-and-drop MIME type for dragging workspace files/folders from the file tree or file tabs onto the chat composer. */
export const WORKSPACE_FILE_MIME = "application/x-pipaya-workspace-file";

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

export interface FullDiffRow {
	type: "context" | "add" | "del";
	oldLine: number | null;
	newLine: number | null;
	text: string;
	/** Marks the first line of each contiguous changed block for auto-scroll & prev/next jump. */
	changeStart?: boolean;
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
					const pairs: { oldText: string; newText: string }[] = Array.isArray(block.args.edits)
						? block.args.edits
								.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
								.map((e) => ({
									oldText: typeof e.oldText === "string" ? e.oldText : "",
									newText: typeof e.newText === "string" ? e.newText : "",
								}))
						: [
								{
									oldText: typeof block.args.oldText === "string" ? block.args.oldText : "",
									newText: typeof block.args.newText === "string" ? block.args.newText : "",
								},
							];
					const fileContent = contentFor?.(path);
					for (const pair of pairs) {
						if (!pair.oldText && !pair.newText) continue;
						const built = buildEditHunk(pair.oldText, pair.newText, fileContent);
						change.additions += built.additions;
						change.deletions += built.deletions;
						diff.additions += built.additions;
						diff.deletions += built.deletions;
						diff.hunks.push(built.hunk);
					}
				} else {
					const content = typeof block.args.content === "string" ? block.args.content : "";
					const { count, head } = countAndHeadLines(content, 400);
					change.additions += count;
					diff.additions += count;
					diff.truncated = count > 400;
					diff.hunks = head.length
						? [{
							header: `@@ -0,0 +1,${count} @@`,
							oldStart: 0,
							newStart: 1,
							lines: head.map((text, idx) => ({ type: "add", oldLine: null, newLine: idx + 1, text })),
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

/** Format sorted or unsorted 1-based line numbers into compact ranges (e.g. `[3,4,5,9,14,15]` -> `"3-5,9,14-15"`). */
export function formatLineSpec(lines: readonly number[]): string {
	const uniq = [...new Set(lines.filter((n) => Number.isFinite(n) && n >= 1))].sort((a, b) => a - b);
	if (uniq.length === 0) return "";
	const parts: string[] = [];
	let start = uniq[0]!;
	let prev = start;
	for (let i = 1; i < uniq.length; i++) {
		const cur = uniq[i]!;
		if (cur === prev + 1) {
			prev = cur;
		} else {
			parts.push(start === prev ? `${start}` : `${start}-${prev}`);
			start = cur;
			prev = cur;
		}
	}
	parts.push(start === prev ? `${start}` : `${start}-${prev}`);
	return parts.join(",");
}

/** Find the best 1-based starting line of a hunk's post-edit lines inside `fileLines`, searching from `minIdx` (0-based). */
function snapHunkStart(fileLines: readonly string[], hunk: DiffHunk, minIdx: number): number {
	const postLines = hunk.lines.filter((l) => l.type !== "del" && l.type !== "meta").map((l) => l.text);
	const hinted = Math.max(1, hunk.lines.find((l) => l.newLine !== null)?.newLine ?? hunk.newStart ?? 1);
	if (postLines.length === 0) return Math.max(minIdx + 1, hinted);

	// Fast check: does the hinted position already match the first post-edit line?
	const hintIdx = hinted - 1;
	if (hintIdx >= minIdx && hintIdx + postLines.length <= fileLines.length) {
		let ok = true;
		for (let k = 0; k < postLines.length; k++) {
			if (fileLines[hintIdx + k] !== postLines[k]) {
				ok = false;
				break;
			}
		}
		if (ok) return hinted;
	}

	// Fallback: scan forward from minIdx for an exact sequence match of postLines.
	for (let i = Math.max(0, minIdx); i + postLines.length <= fileLines.length; i++) {
		let ok = true;
		for (let k = 0; k < postLines.length; k++) {
			if (fileLines[i + k] !== postLines[k]) {
				ok = false;
				break;
			}
		}
		if (ok) return i + 1;
	}

	return Math.max(minIdx + 1, Math.min(fileLines.length + 1, hinted));
}

/**
 * Merge diff hunks into the complete current file contents so changed files are always shown in full context
 * with inline deleted (`del`) and added (`add`) lines highlighted right where they happened.
 */
export function buildFullFileDiff(fileContent: string | null | undefined, hunks: readonly DiffHunk[]): FullDiffRow[] {
	const markChangeStarts = (rows: FullDiffRow[]): FullDiffRow[] => {
		let prevChanged = false;
		for (const r of rows) {
			const changed = r.type !== "context";
			if (changed && !prevChanged) r.changeStart = true;
			prevChanged = changed;
		}
		return rows;
	};

	if (fileContent === null || fileContent === undefined) {
		const fallback: FullDiffRow[] = [];
		for (const h of hunks) {
			for (const l of h.lines) {
				if (l.type === "meta") continue;
				fallback.push({ type: l.type, oldLine: l.oldLine, newLine: l.newLine, text: l.text });
			}
		}
		return markChangeStarts(fallback);
	}

	const fileLines = fileContent.split(/\r?\n/);
	const validHunks = hunks
		.filter((h) => h.lines.some((l) => l.type !== "meta"))
		.map((h) => ({ hunk: h, startNew: snapHunkStart(fileLines, h, 0) }))
		.sort((a, b) => a.startNew - b.startNew);

	if (validHunks.length === 0) {
		return fileLines.map((text, i) => ({
			type: "context",
			oldLine: i + 1,
			newLine: i + 1,
			text,
		}));
	}

	const out: FullDiffRow[] = [];
	let newCur = 1;
	// oldLine = newLine - oldDelta (increases when lines are added, decreases when lines are deleted)
	let oldDelta = 0;

	for (const { hunk } of validHunks) {
		const snapped = snapHunkStart(fileLines, hunk, newCur - 1);
		const targetNew = Math.min(fileLines.length + 1, Math.max(newCur, snapped));
		while (newCur < targetNew && newCur <= fileLines.length) {
			out.push({
				type: "context",
				oldLine: Math.max(1, newCur - oldDelta),
				newLine: newCur,
				text: fileLines[newCur - 1]!,
			});
			newCur++;
		}

		for (const dl of hunk.lines) {
			if (dl.type === "meta") continue;
			if (dl.type === "del") {
				const ol = dl.oldLine ?? Math.max(1, newCur - oldDelta);
				out.push({ type: "del", oldLine: ol, newLine: null, text: dl.text });
				oldDelta--;
			} else if (dl.type === "add") {
				const lineNum = newCur;
				const text = lineNum <= fileLines.length ? fileLines[lineNum - 1]! : dl.text;
				out.push({ type: "add", oldLine: null, newLine: lineNum, text });
				oldDelta++;
				newCur++;
			} else {
				if (newCur > fileLines.length) continue;
				out.push({
					type: "context",
					oldLine: Math.max(1, newCur - oldDelta),
					newLine: newCur,
					text: fileLines[newCur - 1]!,
				});
				newCur++;
			}
		}
	}

	while (newCur <= fileLines.length) {
		out.push({
			type: "context",
			oldLine: Math.max(1, newCur - oldDelta),
			newLine: newCur,
			text: fileLines[newCur - 1]!,
		});
		newCur++;
	}

	return markChangeStarts(out);
}

/**
 * Format large file/diff counts compactly for narrow chrome (e.g. 56px rail, sidebar badges)
 * so values never exceed 4 characters (`999`, `1.2k`, `12k`, `999k`, `1.2M`, `999M+`).
 */
export function formatCompactCount(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	const v = Math.floor(n);
	if (v < 1_000) return String(v);
	if (v < 9_950) {
		const k = Math.round(v / 100) / 10;
		return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
	}
	if (v < 999_500) {
		return `${Math.round(v / 1_000)}k`;
	}
	if (v < 9_950_000) {
		const m = Math.round(v / 100_000) / 10;
		return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
	}
	if (v < 999_500_000) {
		return `${Math.round(v / 1_000_000)}M`;
	}
	return "999M+";
}

/**
 * Count lines in a string without allocating an array of every line, while capturing at most `maxHead` leading lines.
 * Keeps 1M+ line `write` tool payloads O(N) time and O(maxHead) memory.
 */
function countAndHeadLines(content: string, maxHead: number): { count: number; head: string[] } {
	if (!content) return { count: 0, head: [] };
	let end = content.length;
	if (end > 0 && content.charCodeAt(end - 1) === 10) {
		end--;
		if (end > 0 && content.charCodeAt(end - 1) === 13) end--;
	}
	if (end === 0) return { count: 0, head: [] };

	const head: string[] = [];
	let count = 0;
	let pos = 0;
	while (pos <= end) {
		const nl = content.indexOf("\n", pos);
		const lineEnd = nl === -1 || nl > end ? end : nl;
		if (head.length < maxHead) {
			const trimEnd = lineEnd > pos && content.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
			head.push(content.slice(pos, trimEnd));
		}
		count++;
		if (nl === -1 || nl >= end) break;
		pos = nl + 1;
	}
	return { count, head };
}

/**
 * Split sanitized highlight.js HTML (`<span class="...">...</span>`) on newlines while preserving balanced
 * open/close `<span>` tags across multi-line tokens (block comments, template literals).
 */
export function splitHighlightedHtml(html: string): string[] {
	if (!html) return [];
	const rawLines = html.split("\n");
	const out: string[] = new Array(rawLines.length);
	const stack: string[] = [];
	const tagRe = /<\/?span\b[^>]*>/gi;

	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i]!;
		const prefix = stack.length > 0 ? stack.join("") : "";
		tagRe.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = tagRe.exec(line)) !== null) {
			const tag = match[0];
			if (tag.charCodeAt(1) === 47) {
				// </span>
				if (stack.length > 0) stack.pop();
			} else {
				stack.push(tag);
			}
		}
		const suffix = stack.length > 0 ? "</span>".repeat(stack.length) : "";
		out[i] = prefix + line + suffix;
	}
	return out;
}


