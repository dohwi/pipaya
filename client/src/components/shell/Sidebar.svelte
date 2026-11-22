<script lang="ts">
	import ExtensionMount from "../extensions/ExtensionMount.svelte";
	import ExtensionPanels from "../extensions/ExtensionPanels.svelte";
	import { untrack } from "svelte";
	import { schedule, unschedule } from "../../lib/frame";
	import { ms } from "../../lib/motion";
	import Pin from "../ui/Pin.svelte";
	import Badge from "../ui/Badge.svelte";
	import { updater } from "../../lib/updater.svelte";
	import { serverUpdater } from "../../lib/server-update.svelte";
	import { msg, t } from "../../lib/i18n";
	import { liveNext } from "../../lib/minute-clock.svelte";
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { formatCombo } from "../../lib/keys";
	import Icon from "../ui/Icon.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import RowMenu, { type RowMenuItem } from "../ui/RowMenu.svelte";
	import PipayaMark from "../ui/PipayaMark.svelte";
	import Wordmark from "../ui/Wordmark.svelte";
	import { activityOf, type Activity } from "../../lib/activity";
	import { app } from "../../lib/store.svelte";
	import { extensionUpdates } from "../../lib/extension-updates.svelte";
	import { tilde } from "../../lib/format";
	import { copyText } from "../../lib/clipboard";
	import { chooseGroup } from "../../lib/group-picker";
	import { chooseWorkdir } from "../../lib/workdir-picker";
	import type { Point } from "../../lib/press-menu";
	import { drag } from "../../lib/dnd.svelte";
	import { blockDrag } from "../../lib/block-drag";
	import { InlineRename } from "../../lib/inline-rename.svelte";
	import { registerRenamePlace } from "../../lib/rename-places";
	import { DragMarks } from "../../lib/drag-marks.svelte";
	import { workDir, type DirBlock, type Tab } from "../../lib/nav";
	import { dissolveProject, flattenBlocks, isManualRoot, joinProject, leaveProject, newProjectId, projectKey, type SidebarBlock } from "../../lib/projects";
	import { dirKey, connectionState, edgeOf, headMenuEntries, newKey, newMenuEntries, orderServers, projectMenuEntries, rowMenuEntries, shortName, targetId, type RowActions } from "../../lib/sidebar-model";
	import type { Group, Session } from "../../lib/types";
	import { platformName } from "../../lib/terminal";
	import { setSidebarCtx, type MenuTarget, type SidebarNode } from "../../lib/sidebar-ctx";
	import ServerBlock from "./sidebar/ServerBlock.svelte";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	/** The conversation or terminal being renamed in place, and the split tab (group) being renamed. */
	const rename = new InlineRename();
	const groupRename = new InlineRename();
	const dirRename = new InlineRename();
	/** Save the folder's new name; blank goes back to the default label */
	function commitDirRename(n: Node, path: string) {
		if (!dirRename.is(dirKey(n.server.id, path))) return;
		const name = dirRename.draft;
		dirRename.cancel();
		app.sidebar.setDirName(n.server.id, path, name);
	}
	/** What the sidebar draws while something is dragged (the row pulled onto, the drop lines, the carried block). */
	const marks = new DragMarks();

	type Node = SidebarNode;

	/** `~/workspace/x` for display; each server has its own home */
	const pretty = (n: Node, path: string) => tilde(path, n.home);
	/** A folder's label on server `n` (see sidebar-model). */
	const shortLabel = (n: Node, path: string) => app.sidebar.dirName(n.server.id, path) ?? shortName(path, n.home);

	const nodes = $derived.by<Node[]>(() => {
		const list = app.servers.map((server) => {
			const current = server.id === app.serverId;
			const link = app.links[server.id];
			const state = link ? connectionState(link.net) : "checking";
			const ws = link?.workspace ?? null;
			// The shared list (see app.blocksByServer): the rail and the shortcuts walk the same one.
			const blocks = app.blocksByServer[server.id] ?? [];
			const dirs = flattenBlocks(blocks);
			const total = dirs.reduce((sum, x) => sum + x.tabs.length, 0);
			return { server, local: server.local, current, state, loaded: Boolean(link?.listed || link?.cached), stale: Boolean(link?.cached), home: ws?.home, platform: link?.terminalSupport?.platform, repos: link?.repos ?? {}, root: ws?.root, total, dirs, blocks };
		});
		// A server that is up rises above the ones still being checked, and both above the unreachable (shown only; the saved order is untouched).
		return orderServers(list);
	});

	/* Freeze the order as listed, so nothing jumps when tabs close or group. */
	$effect(() => {
		for (const n of nodes)
			if (n.loaded && n.state === "online" && n.dirs.length)
				untrack(() => app.sidebar.pin(n.server.id, n.dirs.map((d) => d.path), n.dirs.flatMap((d) => d.tabs.map((x) => x.id)), Object.fromEntries(n.dirs.flatMap((d) => d.tabs.filter((x) => x.kind === "group").map((x) => [x.id, d.path])))));
	});
	/** Activity of a session, from its own server's live state. */
	const stateOfId = (n: Node, id: string): Activity => {
		const d = app.links[n.server.id]?.data;
		return d ? activityOf(d, id) : "idle";
	};
	const stateOf = (n: Node, x: Session): Activity => stateOfId(n, x.id);


	const isFolded = (key: string) => app.sidebar.folded.includes(key);
	const isDirFolded = (key: string) => app.sidebar.isDirFolded(key);

	/**
	 * Keep the open row in view: the list scrolls to it when something else opens (a new conversation in a folder far
	 * down, a terminal started from the "+"), so the row it belongs to is on screen and not merely unfolded. The folder
	 * is unfolded first (store `revealRow`), so the row exists by the time this runs.
	 */
	let listEl: HTMLElement | undefined = $state();
	/**
	 * The row that stands for what is open: the open tab, or, while its folder (or the project holding it) is folded, that
	 * folder's row. Only one of them is ever drawn: a folded row hides the tabs under it.
	 */
	const OPEN_ROW = ".item.active, .dir.folded.cur";
	/** The open row, when the list has it out of view (null while it is visible or missing). */
	function offscreen(host: HTMLElement): HTMLElement | null {
		const row = host.querySelector<HTMLElement>(OPEN_ROW);
		if (!row) return null;
		const box = host.getBoundingClientRect();
		const r = row.getBoundingClientRect();
		return r.top >= box.top && r.bottom <= box.bottom ? null : row;
	}
	$effect(() => {
		void app.activeId;
		void app.sidebar.folded;
		void app.sidebar.openDirs;
		void app.activeTab;
		const host = listEl;
		if (!host) return;
		schedule(host, () => {
			const row = offscreen(host);
			return row ? () => row.scrollIntoView({ block: "nearest" }) : undefined;
		});
		// A folder unfolds over `normal` and the open row keeps moving under it: look once more when it has settled. The
		// folds can start late (the new row lands with the server's reply) and a folder above can fold away meanwhile, so the
		// end of each (`introend` / `outroend`, caught on the way down since they do not bubble) is the real cue; the timer
		// covers a change with no transition. Only until the user takes the list in hand (or a few seconds pass): a folder
		// they open later must not pull the list back to the open row.
		const look = () => offscreen(host)?.scrollIntoView({ block: "nearest" });
		// an outro ends before its block leaves the DOM (and the gaps around it change with it): look on the next frame
		let frame = 0;
		const later = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(look);
		};
		const settled = setTimeout(look, ms("normal") + 50);
		const ends = ["introend", "outroend"] as const;
		const hands = ["wheel", "pointerdown", "touchstart", "keydown"] as const;
		const off = () => {
			for (const e of ends) host.removeEventListener(e, later, { capture: true });
			for (const e of hands) host.removeEventListener(e, off, { capture: true });
		};
		for (const e of ends) host.addEventListener(e, later, { capture: true });
		for (const e of hands) host.addEventListener(e, off, { capture: true, passive: true });
		const stop = setTimeout(off, 3000);
		return () => {
			clearTimeout(settled);
			clearTimeout(stop);
			cancelAnimationFrame(frame);
			off();
			unschedule(host);
		};
	});

	const startRename = (id: string, title: string) => rename.start(id, title);
	/**
	 * The sidebar's rows are where F2 renames the open thing (see `rename-places`): the row of the split tab while all of
	 * its panes show, otherwise the row of the open conversation or terminal. A folded sidebar has no row to show, so the
	 * header title takes the key instead.
	 */
	$effect(() =>
		registerRenamePlace({
			order: 0,
			zone: '[data-part="sidebar"]',
			open() {
				if (app.sidebar.collapsed) return null;
				const g = app.activeGroup;
				const id = app.activeId;
				if (g && !app.zoomId && !app.isFull(g.id)) return { id: g.id, title: g.name };
				if (!id) return null;
				const title = app.session(id)?.title ?? app.terminal(id)?.title;
				return title === undefined ? null : { id, title };
			},
			start(id, title) {
				if (app.groups.some((g) => g.id === id)) groupRename.start(id, title);
				else rename.start(id, title);
			},
		})
	);
	function commitRename() {
		const done = rename.commit();
		if (done) void (app.terminal(done.id) ? app.renameTerminal(done.id, done.name) : app.rename(done.id, done.name));
	}
	const startGroupRename = (g: Group) => groupRename.start(g.id, g.name);
	function commitGroupRename() {
		const done = groupRename.commit();
		if (done) void app.renameGroup(done.id, done.name);
	}
	/** What a dragged session hovering over `key` highlights (and clears again when it leaves). */
	const hover = (key: string) => (pt: unknown) => marks.hover(key, !!pt);
	const isGroupId = (id: string | null) => !!id && app.groups.some((g) => g.id === id);
	/* ---- reordering the tabs of a directory by dragging them next to each other ---- */
	/**
	 * Over the top / bottom of a row = put it there; over the middle = put the two together (a group never goes into
	 * another group, so a carried group only ever reorders).
	 */
	function edgeAt(pt: { x: number; y: number }, whole: boolean): "before" | "after" | null {
		const r = document.elementFromPoint(pt.x, pt.y)?.closest<HTMLElement>(".item")?.getBoundingClientRect();
		return r ? edgeOf(pt.y, r, whole) : null;
	}
	/** Can the carried thing become a tab of directory `d` beside its others: one of its tabs, or a pane of one of its groups. */
	const ofDir = (d: DirBlock, id: string) => d.tabs.some((x) => x.id === id || (x.kind === "group" && x.members.some((m) => m.id === id)));
	/** The edge a drag over tab `x` means, when it is a reorder. */
	const reorderEdge = (d: DirBlock, x: string, pt: { x: number; y: number }, carried: string | null = drag.id) =>
		carried && carried !== x && ofDir(d, carried) ? edgeAt(pt, isGroupId(carried)) : null;
	/**
	 * A pinned tab always leads its folder, so a reorder across that border cannot happen (the list would sort it right
	 * back): dragging a lone tab to the edge of a row of the other kind opens no gap and drops nothing.
	 */
	const acrossPins = (n: Node, d: DirBlock, x: string, carried: string | null) =>
		!!carried && d.tabs.some((t) => t.id === carried) && app.sidebar.isTabPinned(n.server.id, carried) !== app.sidebar.isTabPinned(n.server.id, x);
	/** The slot right before / after the carried tab is where it already is: no gap there, letting go does nothing. */
	const inPlace = (d: DirBlock, x: string, carried: string | null, edge: "before" | "after") => {
		const ids = d.tabs.map((t) => t.id);
		const i = carried ? ids.indexOf(carried) : -1;
		const j = ids.indexOf(x);
		return i >= 0 && j >= 0 && (edge === "before" ? j === i + 1 : j === i - 1);
	};
	const tabHover = (n: Node, d: DirBlock, x: Tab) => (pt: { x: number; y: number } | null) => {
		const raw = pt ? reorderEdge(d, x.id, pt) : null;
		const blocked = !!raw && (acrossPins(n, d, x.id, drag.id) || inPlace(d, x.id, drag.id, raw));
		const edge = blocked ? null : raw;
		marks.setTab(x.id, edge);
		const pairs = !!pt && !raw && !isGroupId(drag.id) && !(x.kind === "group" && x.members.some((m) => m.id === drag.id));
		marks.hover(x.id, pairs);
	};
	const tabDropAt = (n: Node, d: DirBlock, x: Tab) => async (id: string, pt: { x: number; y: number }) => {
		// drag.id is already cleared when drop runs, so pass the dropped id explicitly
		const edge = reorderEdge(d, x.id, pt, id);
		marks.tab = null;
		if (edge && (acrossPins(n, d, x.id, id) || inPlace(d, x.id, id, edge))) return;
		if (edge) {
			if (!d.tabs.some((t) => t.id === id)) await app.leaveGroup(id); // a pane steps out of its group into a tab
			const now = app.dirs.find((y) => y.path === d.path)?.tabs.map((t) => t.id) ?? d.tabs.map((t) => t.id);
			app.sidebar.moveTab(n.server.id, now, id, x.id, edge === "after");
		} else if (isGroupId(id)) return;
		else if (x.kind === "group") void app.addToGroup(id, x.id);
		else void app.groupWith(id, x.id);
	};
	/** A row inside a group: something dropped on it joins that group. */
	const memberTarget = (n: Node, m: { id: string }) => ({
		accepts: (id: string) => n.current && id !== m.id && !isGroupId(id) && app.groupOf(id)?.id !== app.groupOf(m.id)?.id,
		hover: hover(m.id),
		drop: (id: string) => void app.groupWith(id, m.id),
	});
	/* ---- reordering directories by dragging their header ---- */
	const bid = (kind: "dir" | "group" | "server", key: string) => `${kind}:${key}`;
	/** `use:dirSource`: drag a directory header to reorder it (lib/block-drag.ts), drawn through `marks`. */
	const dirSource = blockDrag({
		set: (drag, drop) => marks.setBlock(drag, drop),
		get: () => marks.block,
		key: bid,
		move: (o, target, after) => (o.kind === "server" ? app.moveServer(o.path, target, after) : app.sidebar.moveDir(o.serverId, o.paths, o.path, target, after)),
	});
	/**
	 * A lone conversation let go on another working tree (main checkout or worktree) of the repository it works in moves
	 * there: its agent works there from its next message. Not while it runs (the server refuses), and not a split-tab pane.
	 */
	const movesTo = (n: Node, id: string, path: string) => {
		const s = app.session(id);
		if (!s || app.groupOf(id) || app.running[id]) return false;
		const from = n.repos[workDir(s)];
		const to = n.repos[path];
		return !!from && !!to && from.root === to.root && to.top === path && from.top !== path;
	};
	/** Let go on a folder: a split-tab pane steps out of its group, as a tab of its own; a lone conversation moves to work there. */
	const acceptsOnDir = (n: Node, path: string) => (id: string) => n.current && (!!app.groupOf(id) || movesTo(n, id, path));
	const dropOnDir = (n: Node, path: string) => (id: string) => {
		if (app.groupOf(id)) void app.leaveGroup(id);
		else if (movesTo(n, id, path)) void app.moveWorkdir(id, path);
	};
	/** The "+" of a server or directory: a conversation or a terminal, both starting in that place. */
	const newItems = (n: Node, path: string): RowMenuItem[] =>
		newMenuEntries(platformName(n.platform), {
			chat: () => app.openIn(n.server.id, { workdir: path }),
			terminal: () => app.openIn(n.server.id, { workdir: path, terminal: true }),
		});
	const hoverNew = (e: PointerEvent, n: Node, path: string, key: string) => rowMenu?.hover(e, newKey(key), newItems(n, path));
	const clickNew = (e: MouseEvent, n: Node, path: string, key: string) => rowMenu?.click(e, newKey(key), newItems(n, path));
	/** The workdir value `openIn` expects: "." for the server default, else the absolute path */

	/** What the entries of a row's "more" menu do (the entries themselves are lib/sidebar-model `rowMenuEntries`). */
	const rowActions: RowActions = {
		renameTab: startRename,
		renameGroup: startGroupRename,
		groupWith: chooseGroup,
		closeSession: (id) => void app.close(id),
		closeTerminal: (id) => void app.closeTerminal(id),
		dissolveGroup: (id) => void app.deleteGroup(id),
		leaveGroup: (id) => void app.leaveGroup(id),
		togglePin: (id) => app.sidebar.toggleTabPinned(app.serverId!, id),
		isPinned: (id) => app.sidebar.isTabPinned(app.serverId!, id),
		schedule: (id) => app.openScheduleFor(id),
		moveWorkdir: (x) => void chooseWorkdir(x),
	};
	const menuItems = (target: MenuTarget, member = false): RowMenuItem[] => rowMenuEntries(target, rowActions, member);
	let rowMenu: ReturnType<typeof RowMenu> | undefined = $state();
	/** Id of the session or group whose menu is open (its button stays highlighted). */
	let menuId = $state<string | null>(null);
	const hoverMenu = (e: PointerEvent, target: MenuTarget, member = false) => rowMenu?.hover(e, targetId(target), menuItems(target, member));
	const leaveMenu = (e: PointerEvent) => rowMenu?.leave(e);
	const clickMenu = (e: MouseEvent, target: MenuTarget, member = false) => rowMenu?.click(e, targetId(target), menuItems(target, member));
	/** Right click / long press on a row: the same entries as its "more" button, where the pointer is. */
	function rowMenuAt(pt: Point, target: MenuTarget, member: boolean) {
		const id = targetId(target);
		rowMenu?.openAt(pt, id, menuItems(target, member));
		return () => menuId === id && rowMenu?.close();
	}
	/** Right click / long press on a folder or server header: its "+" entries, copying the path, folding. */
	function headMenuAt(pt: Point, n: Node, path: string | null, key: string) {
		const id = newKey(key);
		const workdir = path === null ? "." : path === n.root ? "." : path;
		// a folder folds by its own list (they start folded); a server keeps the shared one
		const dir = path !== null;
		const items = headMenuEntries(platformName(n.platform), dir ? isDirFolded(key) : isFolded(key), {
			chat: () => app.openIn(n.server.id, { workdir }),
			terminal: () => app.openIn(n.server.id, { workdir, terminal: true }),
			toggle: () => (dir ? app.sidebar.toggleDir(key) : app.sidebar.toggleFolded(key)),
			togglePin: path === null ? undefined : () => app.sidebar.togglePinned(n.server.id, path),
			pinned: path !== null && app.sidebar.isPinned(n.server.id, path),
			rename: path !== null ? () => dirRename.start(key, shortLabel(n, path)) : undefined,
			copyPath: path === null ? undefined : () => void copyText(path).then((ok) => app.toast(ok ? t("경로를 복사했습니다") : t("복사하지 못했습니다"), ok ? "ok" : "error")),
			joinProject: path !== null && n.current ? () => pickProject(n, path) : undefined,
			leaveProject: path !== null && projectOf(n, path) ? () => app.sidebar.setOverrides(n.server.id, leaveProject(app.sidebar.overrides(n.server.id), path, !isManualRoot(projectOf(n, path)!.root))) : undefined,
		});
		rowMenu?.openAt(pt, id, items);
		return () => menuId === id && rowMenu?.close();
	}
	/** The project folder `path` is listed in, if any. */
	const projectOf = (n: Node, path: string) => {
		const b = n.blocks.find((x) => x.kind === "project" && x.dirs.some((d) => d.path === path));
		return b?.kind === "project" ? b : null;
	};
	/** A project's label: the name the user gave it, else the repository folder's short name. */
	const projectName = (n: Node, root: string) =>
		isManualRoot(root) ? (app.sidebar.overrides(n.server.id).projects?.find((p) => `manual:${p.id}` === root)?.name ?? "") : (app.sidebar.dirName(n.server.id, root) ?? shortName(root, n.home));
	/**
	 * "프로젝트로 묶기…": pick a project (or another folder, which starts a new project with this one) to list folder `path`
	 * under. A picker rather than dragging, so it works the same on touch.
	 */
	function pickProject(n: Node, path: string) {
		const sid = n.server.id;
		const own = projectOf(n, path);
		const projects = n.blocks.filter((b) => b.kind === "project" && b !== own) as Extract<SidebarBlock, { kind: "project" }>[];
		const folders = n.dirs.filter((d) => d.path !== path && !projectOf(n, d.path));
		app.palette = {
			title: t("'{name}'를 묶을 곳", { name: shortLabel(n, path) }),
			empty: msg("묶을 다른 폴더가 없습니다"),
			items: [
				...projects.map((b) => ({ id: `p:${b.root}`, title: projectName(n, b.root), sub: t("프로젝트 · 폴더 {n}개", { n: b.dirs.length }) })),
				...folders.map((d) => ({ id: `d:${d.path}`, title: shortLabel(n, d.path), sub: t("새 프로젝트 · {path}", { path: pretty(n, d.path) }) })),
			],
			onpick: (it) => {
				const over = app.sidebar.overrides(sid);
				if (it.id.startsWith("p:")) return app.sidebar.setOverrides(sid, joinProject(over, path, { root: it.id.slice(2) }));
				const other = it.id.slice(2);
				const id = newProjectId();
				app.sidebar.setOverrides(sid, joinProject(over, path, { with: other, id, name: shortLabel(n, other) }));
				app.sidebar.reveal(projectKey(sid, `manual:${id}`));
			},
		};
	}
	/** Right click / long press on a project header. */
	function projectMenuAt(pt: Point, n: Node, root: string, key: string, workdir: string) {
		const id = newKey(key);
		const manual = isManualRoot(root);
		const items = projectMenuEntries(platformName(n.platform), isFolded(key), {
			chat: () => app.openIn(n.server.id, { workdir }),
			terminal: () => app.openIn(n.server.id, { workdir, terminal: true }),
			toggle: () => app.sidebar.toggleFolded(key),
			rename: () => projectRename.start(key, projectName(n, root)),
			dissolve: manual ? () => app.sidebar.setOverrides(n.server.id, dissolveProject(app.sidebar.overrides(n.server.id), root.slice("manual:".length))) : undefined,
			copyPath: manual ? undefined : () => void copyText(root).then((ok) => app.toast(ok ? t("경로를 복사했습니다") : t("복사하지 못했습니다"), ok ? "ok" : "error")),
		});
		rowMenu?.openAt(pt, id, items);
		return () => menuId === id && rowMenu?.close();
	}
	const projectRename = new InlineRename();
	/** Save a project's new name: a hand-made one keeps it in its own entry, a repository's like a folder's name. */
	function commitProjectRename(n: Node, root: string) {
		const key = projectKey(n.server.id, root);
		if (!projectRename.is(key)) return;
		const name = projectRename.draft;
		projectRename.cancel();
		if (isManualRoot(root)) app.sidebar.renameProject(n.server.id, root.slice("manual:".length), name);
		else app.sidebar.setDirName(n.server.id, root, name);
	}
	// What the rows below share, handed down once instead of through a dozen props each.
	setSidebarCtx({
		marks,
		rename,
		groupRename,
		dirRename,
		commitDirRename,
		projectRename,
		commitProjectRename,
		projectMenuAt,
		projectName,
		get menuId() {
			return menuId;
		},
		isFolded,
		isDirFolded,
		stateOf,
		stateOfId,
		hoverMenu,
		clickMenu,
		rowMenuAt,
		headMenuAt,
		leaveMenu,
		hoverNew,
		clickNew,
		startRename,
		commitRename,
		startGroupRename,
		commitGroupRename,
		memberTarget,
		tabHover,
		tabDropAt,
		hover,
		dropOnDir,
		acceptsOnDir,
		dirSource,
		pretty,
		shortLabel,
	});
	$effect(() => { void app.configTick; void app.serverExtensionsTick; void extensionUpdates.refresh(Object.fromEntries(Object.entries(app.links).map(([id, l]) => [id, l?.api]))); });
	const problems = $derived(app.problemCount);
	/** Scheduled tasks of the open server: the button shows for any server that has the feature, even with none (so it can be found). */
	const scheduled = $derived(app.schedules.all(app.serverId));
	const graphTip = $derived(app.prefs.bindings.openGraph ? `${t("그래프 뷰")} (${formatCombo(app.prefs.bindings.openGraph)})` : t("그래프 뷰"));
	const schedulesShown = $derived(!!app.serverId && app.schedules.supported(app.serverId));
	const schedulesTip = $derived(scheduled.next === null ? t("예약 작업") : t("다음 실행: {when}", { when: liveNext(scheduled.next) }));
	/** Only an optional update is green; a version mismatch (the app and server cannot work together) stays amber. A saved model that no longer works (`problems`) outranks an update. */
	const alertTone = $derived(problems ? "danger" : app.compat === "ok" ? "ok" : "warn");
	/** Something in settings needs the user: a newer app or server build, or the two out of step. Connection state is not here: the sidebar's server block already shows it. */
	const settingsAlert = $derived(problems ? t("설정 문제 {n}", { n: problems }) : app.compat !== "ok" ? t("업데이트 필요") : updater.visible ? t("업데이트 있음") : serverUpdater.available ? t("서버 업데이트 있음") : "");
</script>


<aside class="side" data-part="sidebar">
	<!-- the logo is the app's own: no extension part or style hook here (lib/pipaya-logo.ts) -->
	<div class="brandrow" data-logo-frame>
		<PipayaMark tone="color" size={26} />
		<Wordmark size={16} />
		<IconButton icon="sidebar" label={t("사이드바 접기")} title={t("사이드바 접기") + hint} class="foldbtn" onclick={() => app.sidebar.toggleCollapsed()} />
	</div>
	<ExtensionMount slot="sidebar.top" />

	<nav class="list" bind:this={listEl} use:slidingIndicator={{ selector: OPEN_ROW, radius: "var(--radius-sm)" }} onscroll={() => rowMenu?.close()}>
		{#each nodes as n (n.server.id)}
			<ServerBlock {n} single={nodes.length < 2} />
		{/each}
	</nav>

	<div class="bottom" data-part="sidebar.bottom">
		<ExtensionPanels placement="sidebar" />
		<ExtensionMount slot="sidebar.bottom" />
		<button class="navbtn wide" class:on={app.graphOpen} onclick={() => app.toggleGraph()} title={graphTip} aria-pressed={app.graphOpen} aria-current={app.graphOpen ? "page" : undefined}>
			<span class="sico"><Icon name="fork" /></span> {t("그래프 뷰")}
		</button>
		{#if schedulesShown}
			<button class="navbtn wide" onclick={() => ((app.schedulesDialog = true), (app.sidebar.open = false))} title={schedulesTip}>
				<span class="sico"><Icon name="clock" /></span> {t("예약 작업")}
				{#if scheduled.count}<span class="salert"><Badge size="sm">{scheduled.count}</Badge></span>{/if}
			</button>
		{/if}
		<!-- the phone drawer steps aside for the sheet (like the graph view does): it was left open behind it, two layers deep -->
		<button class="settings navbtn wide" onclick={() => (app.openSettings(), (app.sidebar.open = false))}>
			<span class="sico"><Icon name="settings" />{#if settingsAlert || extensionUpdates.any}<Pin tone={alertTone} label={settingsAlert || t("업데이트 있음")} />{/if}</span> {t("설정")}
			{#if settingsAlert}<span class="salert"><Badge tone={alertTone} size="sm">{settingsAlert}</Badge></span>{/if}
			{#if updater.current}<span class="sver" class:push={!settingsAlert}>v{updater.current}</span>{/if}
		</button>
	</div>
</aside>

<RowMenu bind:this={rowMenu} bind:open={menuId} />

<style>
	.side {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-side);
		border-right: 1px solid var(--border);
		padding-top: var(--sat);
		padding-left: var(--sal);
	}
	.brandrow {
		display: flex;
		align-items: center;
		gap: 8px;
		/* same box as the header capsule (44px + 1px hairline), so the two lines meet across the sidebar edge */
		box-sizing: content-box;
		height: 44px;
		padding: 0 8px 0 12px; /* spacing scale: 4 / 8 / 12 / 16 / 24. The wordmark sits 12 in, the fold button's right edge lines up with the card (8) */
		border-bottom: 1px solid var(--border);
		color: var(--text);
	}
	/* Over a tab strip the header's hairline is the strip's --tabbar-line (Header.svelte): take the same colour so the line
	   runs unbroken from under the logo to the window's right edge */
	@media (min-width: 601px) {
		:global(:root:has(main > [data-part="tabbar"])) .brandrow {
			border-bottom-color: var(--tabbar-line);
		}
	}
	.navbtn :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 2;
	}
	:global(.iconbtn.foldbtn) {
		margin-left: auto;
		margin-right: -9.5px; /* the 19px icon's right edge sits on the 16px gutter, like the server chevron below */
	}
	/* 38px in a 44px row: an outer ring would run into the window's top edge, so it is drawn inside */
	:global(.iconbtn.foldbtn:focus-visible) {
		outline-offset: -3px; /* -2 like the other header buttons, 1 more: the -9.5px bleed puts the box 0.5px past the sidebar's clipping edge */
	}
	@media (min-width: 861px) {
		.side {
			width: clamp(220px, var(--sidebar-w), 560px); /* the wrapper animates its width; the content must not reflow. SIDEBAR_W, like App.svelte */
		}
	}
	.list {
		--band: color-mix(in srgb, var(--text) 3.5%, var(--bg-side));
		position: relative;
		flex: 1;
		overflow-y: auto;
		padding: 8px 0 16px; /* 8 below the brand row, 16 above the window edge */
		overscroll-behavior: contain;
	}
	/* the line where a carried server, folder or tab would land: its own rules below only place it */
	:global(:where(.side) .srv.before::before),
	:global(:where(.side) .srv.after::after),
	:global(:where(.side) .dirblock.before::before),
	:global(:where(.side) .dirblock.after::after),
	:global(:where(.side) .item.before::before),
	:global(:where(.side) .item.after::after) {
		content: "";
		position: absolute;
		height: 2px;
		border-radius: 1px;
		background: var(--accent);
		z-index: 1;
		pointer-events: none;
	}
	:global(:where(.side) .chev) {
		display: grid;
		flex: none;
		transition: rotate var(--motion-fast) var(--ease);
	}
	:global(:where(.side) .chev.folded) {
		rotate: -90deg;
	}
	:global(:where(.side) .chev svg) {
		width: 14px;
		height: 14px;
		stroke: var(--text-faint);
		stroke-width: 2;
	}
	/* a folded row's count: a small round badge pushed to the right edge */
	/* 20px wide, like the "+" / "⋯" / list buttons (x 246..266): one and two digits both centre on x 256, so the count and the button that replaces it share a column */
	:global(:where(.side) .cbadge) {
		margin-left: auto;
		min-width: 20px;
		padding: 0 3px 2px; /* same 1px lift as the base badge (measured at 3x: digits centred in the circle; 4px sat them 1px high) */
	}
	/* a quiet count is a bare number, like the server's; only a state inside (working, asking, done, failed) gets the tinted circle */
	:global(:where(.side) .cbadge.neutral) {
		background: transparent;
		font-weight: 500;
	}
	:global(:where(.side) .dirnew) {
		display: grid;
		place-items: center;
		flex: none;
		width: 20px; /* grid: right-hand centres at x 256 and 236, 20px apart, so the buttons sit edge to edge */
		height: 20px;
		margin-right: 0; /* the button's right edge is the row's right edge: its centre is 32px from the sidebar's edge (x 256) */
		border-radius: 50%;
		color: var(--text-faint);
		opacity: 0;
	}
	:global(:where(.side) .dir:hover .dirnew),
	:global(:where(.side) .srvhead:hover .dirnew),
	:global(:where(.side) .dirnew:focus-visible) {
		opacity: 1;
	}
	@media (pointer: coarse) {
	:global(:where(.side) .dirnew) {
		opacity: 1;
	}
	/* touch rows are 40px (a finger needs more than 32); the 20px buttons keep the x 236 / 256 columns and their hit boxes are
	   28 wide x the full row high, each grown 8px away from the other (the list button to the left, the "+" to the right
	   into the row's padding), so the two boxes touch at x 246 but never overlap (the 44px .tap box overlapped by 24) */
	:global(:where(.side) .dirnew.tap::after) {
		width: 28px;
		height: 40px;
		transform: translate(calc(-50% + 4px), -50%);
	}
	:global(:where(.side) .dirnew.listbtn.tap::after) {
		transform: translate(calc(-50% - 4px), -50%);
	}
	}
	:global(:where(.side) .dirnew.on) {
		background: color-mix(in srgb, var(--text) 14%, transparent);
		color: var(--text);
		opacity: 1;
	}
	/* hover only with a real pointer: after a tap the "+" kept its grey disc on a phone (sticky :hover) */
	@media (hover: hover) {
		:global(:where(.side) .dirnew:hover) {
			background: color-mix(in srgb, var(--text) 14%, transparent);
			color: var(--text);
			opacity: 1;
		}
	}
	/* one lead column: the model's logo, or the terminal / split icon */
	:global(:where(.side) .lead) {
		display: grid;
		place-items: center;
		flex: none;
		width: 16px;
		height: 16px;
		color: var(--text-faint);
		position: relative; /* hosts the pinned mark (PinMark, absolute): without it the mark lands on the row's corner */
	}
	/* only the line icons (terminal, split tab): a model logo keeps its own fill and colours */
	:global(:where(.side) .lead:has(> svg)) {
		--pinmark-inset: 1px; /* a 14px glyph centred in the 16px lead box: the pinned mark sits on the glyph's corner */
	}
	:global(:where(.side) .lead > svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	:global(:where(.side) .dirnew svg) {
		width: 15px;
		height: 15px;
		stroke-width: 2;
	}
	:global(:where(.side) .list .item.nested .open) {
		padding-left: 39px; /* grid: the tab icon centres on x 68 (28 / 48 / 68, 20px apart) */
	}
	/* the sliding marker draws the selection; the row itself stays clear so the two never double up */
	:global(:where(.side) .list[data-indicator-ready] .item.active) {
		background: transparent;
	}
	/* the open tab: a soft wash that fades out to the right and a lifted title; no bar and no outline (a framed row inside the framed card read as a box in a box) */
	:global(:where(.side) .list .slide-ind) {
		border-radius: var(--radius-control) !important;
		z-index: 1; /* above the server band's own background, which would otherwise hide it; the wash is translucent */
		background: linear-gradient(90deg, color-mix(in srgb, var(--text) 13%, transparent), color-mix(in srgb, var(--text) 5%, transparent));
	}
	:global(:where(.side) .item.active .lead > svg) {
		color: var(--text);
	}
	/* stays here, not in RowOpen: scoped there it would out-rank the padding-left / touch min-height rules of the nested, member and touch rules in this sheet (specificity, measured as a 390px diff) */
	:global(:where(.side) .open:not(.acc):not(.chev)) {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 32px;
		padding: 0 8px 0 4px;
		text-align: left;
		outline-offset: -1px;
	}
	.bottom {
		padding: 8px 8px calc(8px + var(--sab));
		border-top: 1px solid var(--border);
	}
	/* the buttons at the bottom (graph view, scheduled tasks, settings) are one shape: same height, padding and glyph column.
	   32px rows like the list's; the 16px glyph sits 12 in, on the search magnifier's column (x 28) */
	.navbtn {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 32px;
		padding: 0 12px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-md);
		line-height: 20px;
		color: var(--text-dim);
		transition: background var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.navbtn:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.navbtn.on {
		background: var(--bg-active);
		color: var(--text);
	}
	.salert {
		margin-left: auto;
		display: inline-flex;
	}
	.sver {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.sver.push {
		margin-left: auto;
	}
	.salert + .sver {
		margin-left: 8px;
	}
	.sico {
		position: relative;
		display: inline-flex;
	}
	:global(:where(.side) .grp .item.nested .open) {
		padding-left: 4px; /* chevron (x 41-55, centre 48) + 4 + 6 gap: the book icon centres on x 68 like the tabs' icons */
	}
	:global(:where(.side) .grp .item.member .open) {
		padding-left: 59px; /* grid: the pane icon centres on x 84, 20px past the book */
		min-height: 32px;
	}
	:global(:where(.side) .grp .item.member .title) {
		color: var(--text-dim);
	}
	:global(:where(.side) .grp .item.member.active .title) {
		color: var(--text);
	}
	/* the row in the air: it keeps its place, faded (dropping it on itself does nothing) */
	:global(:where(.side) .item.carried),
	:global(:where(.side) .grp:has(> .item.carried) .members .item) {
		opacity: 0.45;
	}
	@media (max-width: 860px) {
		:global(.iconbtn.foldbtn) {
			display: none;
		}
	}
	/* touch: tab rows are 40px too. Last in the sheet, so it wins over the 32px base rules above it with the same specificity. */
	@media (pointer: coarse) {
		:global(:where(.side) .open:not(.acc):not(.chev)),
		:global(:where(.side) .grp .item.member .open) {
			min-height: 40px;
		}
		.navbtn {
			height: 40px;
		}
	}
</style>
