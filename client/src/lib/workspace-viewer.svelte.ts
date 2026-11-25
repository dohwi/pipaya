import type { Api } from "./api";
import { errorText, isUnsupportedRoute } from "./api";
import type { ChatState } from "./chat.svelte";
import type { PipayaEvent } from "./types";
import {
	buildEditHunk,
	deriveLatestTurnEdits,
	normalizeRelPath,
	type DiffHunk,
	type DiffLine,
	type WorkspaceChange,
	type WorkspaceDiffData,
	type WorkspaceEntry,
	type WorkspaceFileData,
} from "./workspace-edits";

export {
	buildEditHunk,
	deriveLatestTurnEdits,
	normalizeRelPath,
	type DiffHunk,
	type DiffLine,
	type WorkspaceChange,
	type WorkspaceDiffData,
	type WorkspaceEntry,
	type WorkspaceFileData,
};

export interface WorkspacePaneControl {
	path: string;
	size?: number;
	imgDims: { w: number; h: number } | null;
	editing: boolean;
	editDirty: boolean;
	editSaving: boolean;
	canEdit: boolean;
	canCopy: boolean;
	copied: boolean;
	saving: boolean;
	fileCommentOpen: boolean;
	modeOptions: { id: string; label: string }[];
	activeModeId: string;
	showChangeNav: boolean;
	changeCount: number;
	activeChangeIdx: number;
	onModeChange: (id: string) => void;
	onStartEdit: () => void;
	onCommitEdit: () => void;
	onCancelEdit: () => void;
	onToggleFileComment: (e: MouseEvent) => void;
	onCopy: () => void;
	onDownload: () => void;
	onJumpChange: (idx: number) => void;
}

const RECENT_HIGHLIGHT_MS = 10_000;
const FALLBACK_MAX_BYTES = 256 * 1024;

/**
 * Reactive store for the read-only workspace file viewer & live agent modification tracker.
 * Tracks only recent / in-flight edits from the active session's latest editing turn (not unrelated dirty git files).
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
	/** Live header metadata & action callbacks registered by the mounted `WorkspaceFilePane` so `Header.svelte` renders them natively. */
	paneControl = $state<WorkspacePaneControl | null>(null);

	selectedPath = $state<string | null>(null);
	fileData = $state<WorkspaceFileData | null>(null);
	diffData = $state<WorkspaceDiffData | null>(null);

	treeLoading = $state(false);
	treeError = $state<string | null>(null);
	fileLoading = $state(false);
	fileError = $state<string | null>(null);

	private api: Api | null = null;
	private getChat: ((id: string) => ChatState | null | undefined) | null = null;
	private recentDiffs = new Map<string, WorkspaceDiffData>();
	private liveTurnPaths = new Set<string>();
	private latestTurnKey: string | null = null;
	private dismissedTurnKey: string | null = null;
	private dirStates = new Map<string, { openFiles: string[]; expandedDirs: Record<string, boolean> }>();
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private clearRecentTimer: ReturnType<typeof setTimeout> | null = null;
	private seq = { tree: 0, search: 0, file: 0, diff: 0 };

	private dirKey(api: Api | null, dir: string): string {
		if (!dir) return "";
		return `${api?.baseUrl ?? ""}\0${dir}`;
	}

	private readStoredTabs(key: string): string[] {
		if (!key || typeof localStorage === "undefined") return [];
		try {
			const raw = localStorage.getItem("pipaya.workspace.tabs");
			if (!raw) return [];
			const map = JSON.parse(raw) as Record<string, string[]>;
			const list = map[key];
			return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
		} catch {
			return [];
		}
	}

	private persistCurrentDirState() {
		const key = this.dirKey(this.api, this.workDir);
		if (!key) return;
		this.dirStates.set(key, {
			openFiles: [...this.openFiles],
			expandedDirs: { ...this.expandedDirs },
		});
		if (typeof localStorage === "undefined") return;
		try {
			const raw = localStorage.getItem("pipaya.workspace.tabs");
			const map: Record<string, string[]> = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
			if (this.openFiles.length > 0) map[key] = [...this.openFiles];
			else delete map[key];
			localStorage.setItem("pipaya.workspace.tabs", JSON.stringify(map));
		} catch { /* ignore storage errors */ }
	}

	bind(api: Api | null, sessionId: string | null, workDir: string, getChat?: (id: string) => ChatState | null | undefined) {
		const serverChanged = this.api !== api;
		const dirChanged = this.workDir !== workDir;
		const sessionChanged = this.sessionId !== sessionId;
		if ((serverChanged || dirChanged) && this.workDir) {
			this.persistCurrentDirState();
		}
		this.api = api;
		this.getChat = getChat ?? this.getChat;
		if (serverChanged) this.supported = true;
		if (serverChanged || dirChanged) {
			this.sessionId = sessionId;
			this.workDir = workDir;
			const nextKey = this.dirKey(api, workDir);
			const saved = nextKey ? this.dirStates.get(nextKey) : undefined;
			const restoredFiles = saved ? [...saved.openFiles] : this.readStoredTabs(nextKey);
			this.isRepo = false;
			this.branch = null;
			this.rootEntries = [];
			this.dirEntries = {};
			this.expandedDirs = saved ? { ...saved.expandedDirs } : {};
			this.search = "";
			this.searchEntries = [];
			this.changes = [];
			this.recentTouched = {};
			this.openFiles = restoredFiles;
			this.activeFile = null;
			this.selectedPath = null;
			this.fileData = null;
			this.diffData = null;
			this.treeError = null;
			this.fileError = null;
			this.recentDiffs.clear();
			this.liveTurnPaths.clear();
			this.latestTurnKey = null;
			this.dismissedTurnKey = null;
			this.seq.tree++;
			this.seq.search++;
			this.seq.file++;
			this.seq.diff++;
		} else if (sessionChanged) {
			// Same workDir, different session: keep open file tabs & expanded folders intact, re-sync that session's recent edits.
			this.sessionId = sessionId;
			this.liveTurnPaths.clear();
			this.dismissedTurnKey = null;
		}
		this.syncRecentChanges();
	}

	/** Recompute recent/pending changes from the active session's latest editing turn + live workspace events. */
	syncRecentChanges() {
		const sid = this.sessionId;
		const chat = sid ? this.getChat?.(sid) : null;
		const contentFor = (p: string) => (this.fileData?.path === p && !this.fileData.binary ? this.fileData.content : undefined);
		const derived = deriveLatestTurnEdits(chat, this.workDir, contentFor);
		this.latestTurnKey = derived.turnKey;

		if (derived.turnKey && derived.turnKey === this.dismissedTurnKey && this.liveTurnPaths.size === 0) {
			this.changes = [];
			this.recentDiffs.clear();
			return;
		}

		const nextChanges = [...derived.changes];
		const seen = new Set(nextChanges.map((c) => c.path));
		for (const livePath of this.liveTurnPaths) {
			if (!seen.has(livePath)) {
				seen.add(livePath);
				nextChanges.push({ path: livePath, status: "M", additions: 0, deletions: 0 });
			}
		}

		this.changes = nextChanges;
		this.recentDiffs = derived.diffs;

		// If the user is currently looking at the diff of a recently edited file, keep it freshly anchored.
		const cur = this.selectedPath;
		if (cur && this.recentDiffs.has(cur)) {
			this.diffData = this.recentDiffs.get(cur) ?? null;
		}
	}

	/** Acknowledge/clear the current list of recent changes until a newer edit arrives. */
	clearChanges() {
		this.dismissedTurnKey = this.latestTurnKey;
		this.liveTurnPaths.clear();
		this.changes = [];
		this.recentDiffs.clear();
	}

	/** Open a file in the TabBar for the current workDir and focus it. */
	async openFile(path: string, preferredMode?: "file" | "diff") {
		const clean = normalizeRelPath(path, this.workDir);
		if (!clean) return;
		if (!this.openFiles.includes(clean)) {
			this.openFiles = [...this.openFiles, clean];
			this.persistCurrentDirState();
		}
		this.activeFile = clean;
		await this.selectFile(clean, preferredMode);
	}

	/** Switch focus to an already-open file tab. */
	async activateFile(path: string) {
		const clean = normalizeRelPath(path, this.workDir);
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
		this.persistCurrentDirState();
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

	/** True when any recently changed file lives under directory `dirPath`. */
	dirHasChanges(dirPath: string): boolean {
		const prefix = `${dirPath}/`;
		return this.changes.some((c) => c.path.startsWith(prefix));
	}

	isRecent(path: string): boolean {
		return (this.recentTouched[path] ?? 0) > Date.now();
	}

	markTouched(path: string) {
		const clean = normalizeRelPath(path, this.workDir);
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
				this.syncRecentChanges();
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
				return;
			}
		} finally {
			if (this.seq.tree === ticket && this.supported) this.treeLoading = false;
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
			this.syncRecentChanges();
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
		this.persistCurrentDirState();
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
		const clean = normalizeRelPath(path, this.workDir);
		const changedPath = this.selectedPath !== clean;
		this.selectedPath = clean;
		if (changedPath) {
			this.fileData = null;
			this.diffData = null;
			this.fileError = null;
		}
		this.syncRecentChanges();
		const hasChange = !!this.changeFor(clean);
		this.viewMode = preferredMode ?? (hasChange ? "diff" : "file");
		await this.loadFile(clean);
		if (hasChange || this.viewMode === "diff") {
			await this.loadDiff(clean);
		} else {
			this.diffData = null;
		}
	}

	async saveFile(path: string, content: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const api = this.api;
		const sid = this.sessionId;
		if (!api || !sid) return { ok: false, error: "no active session" };
		const clean = normalizeRelPath(path, this.workDir);
		try {
			const res = await api.workspaceSaveFile(sid, clean, content);
			if (this.selectedPath === clean) {
				this.fileData = {
					path: clean,
					content,
					binary: false,
					truncated: false,
					size: res.size,
					lineCount: res.lineCount,
				};
				this.syncRecentChanges();
			}
			return { ok: true };
		} catch (e) {
			return { ok: false, error: errorText(e) };
		}
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
			// Re-anchor recent diff hunks using actual file content so diff line numbers match the file.
			this.syncRecentChanges();
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
		this.syncRecentChanges();

		// Prefer the exact recent-turn edit hunks (only what was just edited in this turn).
		const recent = this.recentDiffs.get(path);
		if (recent && recent.hunks.length > 0) {
			this.diffData = recent;
			return;
		}

		// Fallback to server git diff only for paths explicitly touched via live events without a chat edit/write hunk.
		try {
			if (this.supported) {
				const data = await api.workspaceDiff(sid, path);
				if (this.seq.diff !== ticket || this.selectedPath !== path) return;
				this.diffData = data;
			} else {
				this.diffData = {
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

	/** Live updates whenever the agent edits/writes files or starts/finishes a run. */
	onEvent(e: PipayaEvent) {
		const sid = e.sessionId;
		if (!sid || sid !== this.sessionId) return;

		if (e.type === "run_started") {
			this.liveTurnPaths.clear();
		} else if (e.type === "workspace_changed") {
			const data = e.data as { path?: string | null; tool?: string } | null;
			if (data?.path) {
				const clean = normalizeRelPath(data.path, this.workDir);
				if (clean) {
					this.liveTurnPaths.add(clean);
					this.markTouched(clean);
				}
			}
			this.syncRecentChanges();
			this.scheduleLiveRefresh();
		} else if (e.type === "tool_execution_start" || e.type === "message_update") {
			// Immediately surface in-flight / pending edits in "변경됨" even before tool_result finishes.
			this.syncRecentChanges();
		} else if (e.type === "tool_execution_end") {
			const data = e.data as { toolName?: string } | null;
			this.syncRecentChanges();
			if (data?.toolName === "write" || data?.toolName === "edit" || data?.toolName === "bash") {
				this.scheduleLiveRefresh();
			}
		} else if (e.type === "run_finished" || e.type === "message_end") {
			this.syncRecentChanges();
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
