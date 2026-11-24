import type { Api } from "./api";
import { errorText, isUnsupportedRoute } from "./api";
import type { ChatState } from "./chat.svelte";
import type { PipayaEvent } from "./types";

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

const RECENT_HIGHLIGHT_MS = 10_000;
const FALLBACK_MAX_BYTES = 256 * 1024;

function buildFallbackHunk(oldText: string, newText: string): { hunk: DiffHunk; additions: number; deletions: number } {
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
	const ctxStart = Math.max(0, prefix - 2);
	const oldEnd = oldLines.length - suffix;
	const newEnd = newLines.length - suffix;
	const ctxEnd = Math.min(oldLines.length, oldEnd + 2);
	const lines: DiffLine[] = [];
	let ol = ctxStart + 1;
	let nl = ctxStart + 1;
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
		hunk: { header: `@@ -${ctxStart + 1} +${ctxStart + 1} @@`, oldStart: ctxStart + 1, newStart: ctxStart + 1, lines },
		additions,
		deletions,
	};
}

/** Extract modified files & hunks from chat transcript when connected to an older server without `/workspace/*` routes. */
function deriveChatEdits(chat: ChatState | null | undefined): {
	changes: WorkspaceChange[];
	diffs: Map<string, WorkspaceDiffData>;
} {
	const changesMap = new Map<string, WorkspaceChange>();
	const diffs = new Map<string, WorkspaceDiffData>();
	if (!chat) return { changes: [], diffs };

	for (const item of chat.items) {
		if (item.kind !== "assistant") continue;
		for (const block of item.blocks) {
			if (block.type !== "tool" || (block.name !== "edit" && block.name !== "write")) continue;
			const rawPath = typeof block.args.path === "string" ? block.args.path.trim() : "";
			if (!rawPath) continue;
			const path = rawPath.replace(/^\.\//, "");
			let change = changesMap.get(path);
			if (!change) {
				change = { path, status: block.name === "write" ? "A" : "M", additions: 0, deletions: 0 };
				changesMap.set(path, change);
			}
			let diff = diffs.get(path);
			if (!diff) {
				diff = { path, isRepo: false, hunks: [], additions: 0, deletions: 0, binary: false, truncated: false };
				diffs.set(path, diff);
			}
			if (block.name === "edit") {
				const oldText = typeof block.args.oldText === "string" ? block.args.oldText : "";
				const newText = typeof block.args.newText === "string" ? block.args.newText : "";
				const built = buildFallbackHunk(oldText, newText);
				change.additions += built.additions;
				change.deletions += built.deletions;
				diff.additions += built.additions;
				diff.deletions += built.deletions;
				diff.hunks.push(built.hunk);
			} else {
				const content = typeof block.args.content === "string" ? block.args.content : "";
				const rows = content ? content.replace(/\r?\n$/, "").split(/\r?\n/) : [];
				const clipped = rows.slice(0, 300);
				change.additions += rows.length;
				diff.additions += rows.length;
				diff.truncated = rows.length > 300;
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
	return { changes: [...changesMap.values()], diffs };
}

/**
 * Reactive store for the read-only workspace file viewer & live agent modification tracker.
 * Works natively with `/sessions/:id/workspace/*` and gracefully falls back to `/fs/files` + `/sessions/:id/files`
 * plus transcript edits when connected to an older server.
 */
export class WorkspaceViewerStore {
	supported = $state(true);
	sessionId = $state<string | null>(null);
	workDir = $state<string>("");
	isRepo = $state(false);
	branch = $state<string | null>(null);

	filter = $state<"all" | "changed">("all");
	viewMode = $state<"file" | "diff">("file");
	search = $state("");

	rootEntries = $state<WorkspaceEntry[]>([]);
	dirEntries = $state<Record<string, WorkspaceEntry[]>>({});
	expandedDirs = $state<Record<string, boolean>>({});
	searchEntries = $state<WorkspaceEntry[]>([]);
	changes = $state<WorkspaceChange[]>([]);

	/** Recently touched paths (path -> expiry timestamp) for subtle live highlight when the agent edits files. */
	recentTouched = $state<Record<string, number>>({});

	/** Open read-only file tabs belonging to the current `workDir`, shown inline in the TabBar. */
	openFiles = $state<string[]>([]);
	/** Currently focused file tab in the main stage (`null` = showing the active chat/terminal pane). */
	activeFile = $state<string | null>(null);

	selectedPath = $state<string | null>(null);
	fileData = $state<WorkspaceFileData | null>(null);
	diffData = $state<WorkspaceDiffData | null>(null);

	treeLoading = $state(false);
	treeError = $state<string | null>(null);
	fileLoading = $state(false);
	fileError = $state<string | null>(null);

	private api: Api | null = null;
	private getChat: ((id: string) => ChatState | null | undefined) | null = null;
	private fallbackDiffs = new Map<string, WorkspaceDiffData>();
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private clearRecentTimer: ReturnType<typeof setTimeout> | null = null;
	private seq = { tree: 0, search: 0, file: 0, diff: 0 };

	bind(api: Api | null, sessionId: string | null, workDir: string, getChat?: (id: string) => ChatState | null | undefined) {
		const serverChanged = this.api !== api;
		const dirChanged = this.workDir !== workDir;
		const sessionChanged = this.sessionId !== sessionId;
		this.api = api;
		this.getChat = getChat ?? this.getChat;
		if (serverChanged) this.supported = true;
		if (serverChanged || dirChanged) {
			this.sessionId = sessionId;
			this.workDir = workDir;
			this.isRepo = false;
			this.branch = null;
			this.rootEntries = [];
			this.dirEntries = {};
			this.expandedDirs = {};
			this.search = "";
			this.searchEntries = [];
			this.changes = [];
			this.recentTouched = {};
			this.openFiles = [];
			this.activeFile = null;
			this.selectedPath = null;
			this.fileData = null;
			this.diffData = null;
			this.treeError = null;
			this.fileError = null;
			this.fallbackDiffs.clear();
			this.seq.tree++;
			this.seq.search++;
			this.seq.file++;
			this.seq.diff++;
		} else if (sessionChanged) {
			// Same workDir, different session: keep open file tabs & expanded folders intact.
			this.sessionId = sessionId;
		}
	}

	/** Open a file in the TabBar for the current workDir and focus it. */
	async openFile(path: string, preferredMode?: "file" | "diff") {
		const clean = path.replace(/^\.\//, "");
		if (!clean) return;
		if (!this.openFiles.includes(clean)) {
			this.openFiles = [...this.openFiles, clean];
		}
		this.activeFile = clean;
		await this.selectFile(clean, preferredMode);
	}

	/** Switch focus to an already-open file tab. */
	async activateFile(path: string) {
		const clean = path.replace(/^\.\//, "");
		if (!this.openFiles.includes(clean)) return;
		this.activeFile = clean;
		if (this.selectedPath !== clean || !this.fileData) {
			await this.selectFile(clean);
		}
	}

	/** Return focus from any file tab back to the active chat/terminal pane. */
	deactivateFile() {
		this.activeFile = null;
	}

	/** Close an open file tab; if it was focused, switch to an adjacent file tab or back to the chat pane. */
	closeFile(path: string) {
		const idx = this.openFiles.indexOf(path);
		if (idx < 0) return;
		const next = this.openFiles.filter((p) => p !== path);
		this.openFiles = next;
		if (this.activeFile === path) {
			const fallback = next[Math.min(idx, next.length - 1)] ?? null;
			this.activeFile = fallback;
			if (fallback) {
				void this.selectFile(fallback);
			}
		}
		if (this.selectedPath === path && !this.activeFile) {
			this.selectedPath = null;
			this.fileData = null;
			this.diffData = null;
		}
	}

	changeFor(path: string): WorkspaceChange | undefined {
		return this.changes.find((c) => c.path === path);
	}

	/** True when any changed file lives under directory `dirPath`. */
	dirHasChanges(dirPath: string): boolean {
		const prefix = `${dirPath}/`;
		return this.changes.some((c) => c.path.startsWith(prefix));
	}

	isRecent(path: string): boolean {
		return (this.recentTouched[path] ?? 0) > Date.now();
	}

	markTouched(path: string) {
		const clean = path.replace(/^\.\//, "");
		if (!clean) return;
		this.recentTouched = { ...this.recentTouched, [clean]: Date.now() + RECENT_HIGHLIGHT_MS };
		if (this.clearRecentTimer) clearTimeout(this.clearRecentTimer);
		this.clearRecentTimer = setTimeout(() => {
			const now = Date.now();
			const next: Record<string, number> = {};
			for (const [k, exp] of Object.entries(this.recentTouched)) {
				if (exp > now) next[k] = exp;
			}
			this.recentTouched = next;
		}, RECENT_HIGHLIGHT_MS + 100);
	}

	async refreshTree(opts: { preserveOpenDirs?: boolean } = {}) {
		const api = this.api;
		const sid = this.sessionId;
		const dir = this.workDir;
		if (!api || !sid || !dir) return;
		const ticket = ++this.seq.tree;
		this.treeLoading = true;
		this.treeError = null;

		try {
			if (this.supported) {
				const res = await api.workspaceTree(sid);
				if (this.api !== api || this.sessionId !== sid || this.seq.tree !== ticket) return;
				this.isRepo = res.isRepo;
				this.branch = res.branch;
				this.rootEntries = res.entries;
				this.changes = res.changes;
				if (opts.preserveOpenDirs) {
					const openDirs = Object.keys(this.expandedDirs).filter((k) => this.expandedDirs[k]);
					await Promise.all(openDirs.map((d) => this.loadDir(d)));
				}
				return;
			}
		} catch (e) {
			if (this.seq.tree !== ticket) return;
			if (isUnsupportedRoute(e)) {
				this.supported = false;
			} else {
				this.treeError = errorText(e);
				this.treeLoading = false;
				return;
			}
		}

		// Graceful fallback for older servers without `/sessions/:id/workspace/tree`.
		try {
			const [filesRes, dirsRes] = await Promise.all([
				api.listFiles(dir, "").catch(() => ({ entries: [] })),
				api.listDirs(dir, false).catch(() => ({ entries: [] })),
			]);
			if (this.api !== api || this.sessionId !== sid || this.seq.tree !== ticket) return;
			const topMap = new Map<string, WorkspaceEntry>();
			for (const d of dirsRes.entries) {
				if (d.name === ".git") continue;
				topMap.set(d.name, { name: d.name, path: d.name, dir: true });
			}
			for (const f of filesRes.entries) {
				const clean = f.path.replace(/\/$/, "");
				const first = clean.split("/")[0];
				if (!first || first === ".git") continue;
				const isDir = f.dir || clean.includes("/");
				if (!topMap.has(first)) topMap.set(first, { name: first, path: first, dir: isDir });
			}
			const list = [...topMap.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
			this.rootEntries = list;
			const derived = deriveChatEdits(this.getChat?.(sid));
			this.changes = derived.changes;
			this.fallbackDiffs = derived.diffs;
		} catch (e) {
			if (this.seq.tree === ticket) this.treeError = errorText(e);
		} finally {
			if (this.seq.tree === ticket) this.treeLoading = false;
		}
	}

	async loadDir(relDir: string) {
		const api = this.api;
		const sid = this.sessionId;
		const root = this.workDir;
		if (!api || !sid || !root) return;
		try {
			if (this.supported) {
				const res = await api.workspaceTree(sid, { dir: relDir });
				if (this.api !== api || this.sessionId !== sid) return;
				this.dirEntries = { ...this.dirEntries, [relDir]: res.entries };
			} else {
				const res = await api.listFiles(root, `${relDir}/`);
				if (this.api !== api || this.sessionId !== sid) return;
				const prefix = `${relDir}/`;
				const childMap = new Map<string, WorkspaceEntry>();
				for (const e of res.entries) {
					const clean = e.path.replace(/\/$/, "");
					if (!clean.startsWith(prefix)) continue;
					const rest = clean.slice(prefix.length);
					const seg = rest.split("/")[0];
					if (!seg) continue;
					const childPath = `${relDir}/${seg}`;
					const isDir = e.dir || rest.includes("/");
					if (!childMap.has(childPath)) childMap.set(childPath, { name: seg, path: childPath, dir: isDir });
				}
				const list = [...childMap.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
				this.dirEntries = { ...this.dirEntries, [relDir]: list };
			}
		} catch { /* ignore unreadable subdirs */ }
	}

	async toggleDir(relDir: string) {
		const nextOpen = !this.expandedDirs[relDir];
		this.expandedDirs = { ...this.expandedDirs, [relDir]: nextOpen };
		if (nextOpen && !this.dirEntries[relDir]) {
			await this.loadDir(relDir);
		}
	}

	async runSearch(query: string) {
		this.search = query;
		const q = query.trim();
		if (!q) {
			this.searchEntries = [];
			return;
		}
		const api = this.api;
		const sid = this.sessionId;
		const root = this.workDir;
		if (!api || !sid || !root) return;
		const ticket = ++this.seq.search;
		try {
			if (this.supported) {
				const res = await api.workspaceTree(sid, { q });
				if (this.seq.search !== ticket || this.sessionId !== sid) return;
				this.searchEntries = res.entries;
			} else {
				const res = await api.listFiles(root, q);
				if (this.seq.search !== ticket || this.sessionId !== sid) return;
				this.searchEntries = res.entries.map((e) => {
					const clean = e.path.replace(/\/$/, "");
					return { name: clean.split("/").pop() ?? clean, path: clean, dir: e.dir };
				});
			}
		} catch { /* ignore */ }
	}

	async selectFile(path: string, preferredMode?: "file" | "diff") {
		const clean = path.replace(/^\.\//, "");
		this.selectedPath = clean;
		const hasChange = !!this.changeFor(clean);
		this.viewMode = preferredMode ?? (hasChange && this.filter === "changed" ? "diff" : "file");
		await Promise.all([
			this.loadFile(clean),
			hasChange || this.viewMode === "diff" ? this.loadDiff(clean) : Promise.resolve(),
		]);
	}

	async loadFile(path: string) {
		const api = this.api;
		const sid = this.sessionId;
		if (!api || !sid) return;
		const ticket = ++this.seq.file;
		this.fileLoading = true;
		this.fileError = null;
		try {
			if (this.supported) {
				const data = await api.workspaceFile(sid, path);
				if (this.seq.file !== ticket || this.selectedPath !== path) return;
				this.fileData = data;
			} else {
				const blob = await api.fetchFile(sid, path);
				if (this.seq.file !== ticket || this.selectedPath !== path) return;
				const truncated = blob.size > FALLBACK_MAX_BYTES;
				const slice = blob.slice(0, FALLBACK_MAX_BYTES);
				const buf = new Uint8Array(await slice.arrayBuffer());
				const binary = buf.includes(0);
				const content = binary ? "" : new TextDecoder().decode(buf);
				const lineCount = content ? content.split(/\r?\n/).length : 0;
				this.fileData = { path, content, binary, truncated, size: blob.size, lineCount };
			}
		} catch (e) {
			if (this.seq.file === ticket) {
				this.fileData = null;
				this.fileError = errorText(e);
			}
		} finally {
			if (this.seq.file === ticket) this.fileLoading = false;
		}
	}

	async loadDiff(path: string) {
		const api = this.api;
		const sid = this.sessionId;
		if (!api || !sid) return;
		const ticket = ++this.seq.diff;
		try {
			if (this.supported) {
				const data = await api.workspaceDiff(sid, path);
				if (this.seq.diff !== ticket || this.selectedPath !== path) return;
				this.diffData = data;
			} else {
				const derived = deriveChatEdits(this.getChat?.(sid));
				this.changes = derived.changes;
				this.fallbackDiffs = derived.diffs;
				this.diffData = this.fallbackDiffs.get(path) ?? {
					path,
					isRepo: false,
					hunks: [],
					additions: 0,
					deletions: 0,
					binary: false,
					truncated: false,
				};
			}
		} catch {
			if (this.seq.diff === ticket) this.diffData = null;
		}
	}

	/** Live updates whenever the agent writes/edits files or runs shell commands. */
	onEvent(e: PipayaEvent) {
		const sid = e.sessionId;
		if (!sid || sid !== this.sessionId) return;

		if (e.type === "workspace_changed") {
			const data = e.data as { path?: string | null; tool?: string } | null;
			if (data?.path) this.markTouched(data.path);
			this.scheduleLiveRefresh();
		} else if (e.type === "tool_execution_end") {
			const data = e.data as { toolName?: string } | null;
			if (data?.toolName === "write" || data?.toolName === "edit" || data?.toolName === "bash") {
				this.scheduleLiveRefresh();
			}
		} else if (e.type === "run_finished") {
			this.scheduleLiveRefresh();
		}
	}

	private scheduleLiveRefresh() {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshTree({ preserveOpenDirs: true }).then(() => {
				const cur = this.selectedPath;
				if (!cur) return;
				void this.loadFile(cur);
				if (this.changeFor(cur) || this.viewMode === "diff") void this.loadDiff(cur);
			});
		}, 250);
	}
}

export const workspaceViewer = new WorkspaceViewerStore();
