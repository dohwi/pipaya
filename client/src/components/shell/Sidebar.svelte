<script lang="ts">
	import { sessionTitle } from "../../lib/session-title";
	import EmptyState from "../ui/EmptyState.svelte";
	import SearchField from "../ui/SearchField.svelte";
	import ExtensionMount from "../extensions/ExtensionMount.svelte";
	import ExtensionPanels from "../extensions/ExtensionPanels.svelte";
	import ExtensionPart from "../extensions/ExtensionPart.svelte";
	import { untrack } from "svelte";
	import { schedule, unschedule } from "../../lib/frame";
	import { ms } from "../../lib/motion";
	import Pin from "../ui/Pin.svelte";
	import Badge from "../ui/Badge.svelte";
	import { updater } from "../../lib/updater.svelte";
	import { serverUpdater } from "../../lib/server-update.svelte";
	import { t } from "../../lib/i18n";
	import { whenShort } from "../../lib/schedules";
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
	import type { Point } from "../../lib/press-menu";
	import { drag } from "../../lib/dnd.svelte";
	import { blockDrag } from "../../lib/block-drag";
	import { InlineRename } from "../../lib/inline-rename.svelte";
	import { registerRenamePlace } from "../../lib/rename-places";
	import { DragMarks } from "../../lib/drag-marks.svelte";
	import { sidebarDirs, type DirBlock, type Tab } from "../../lib/nav";
	import { dirKey, connectionState, edgeOf, headMenuEntries, newKey, newMenuEntries, orderServers, rowMenuEntries, shortName, targetId, type RowActions } from "../../lib/sidebar-model";
	import type { Group, Session, WorkspaceInfo } from "../../lib/types";
	import { platformName, type TerminalInfo } from "../../lib/terminal";
	import { setSidebarCtx, type MenuTarget, type SidebarNode } from "../../lib/sidebar-ctx";
	import ServerBlock from "./sidebar/ServerBlock.svelte";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	let query = $state("");
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

	/** Everything shown comes from the servers themselves: their session lists and workspace roots. */
	function build(sessions: Session[], groups: Group[], ws: WorkspaceInfo | null, q: string, order: string[] | undefined, torder: string[] | undefined, gdir: Record<string, string> | undefined, keep: string[] | undefined, ptabs: string[] | undefined, terminals: TerminalInfo[], shared?: DirBlock[]): Pick<Node, "root" | "total" | "dirs"> {
		// a copy: a search builds its own list, and the caller's shared one must not be touched
		const dirs = shared ? [...shared] : sidebarDirs(sessions, groups, terminals, {
			match: (x) => !q || sessionTitle(x.title).toLowerCase().includes(q),
			matchGroup: (g) => !!q && g.name.toLowerCase().includes(q),
			matchTerminal: (x) => !q || x.title.toLowerCase().includes(q),
			dirOrder: order,
			tabOrder: torder,
			groupDir: gdir,
			keep: q ? [] : keep, // a search lists matches only
			pinnedTabs: ptabs,
		});
		const total = dirs.reduce((n, d) => n + d.tabs.length, 0);
		return { root: ws?.root, total, dirs };
	}
	/** `~/workspace/x` for display; each server has its own home */
	const pretty = (n: Node, path: string) => tilde(path, n.home);
	/** A folder's label on server `n` (see sidebar-model). */
	const shortLabel = (n: Node, path: string) => app.sidebar.dirName(n.server.id, path) ?? shortName(path, n.home);

	const nodes = $derived.by<Node[]>(() => {
		const q = query.trim().toLowerCase();
		const list = app.servers.map((server) => {
			const current = server.id === app.serverId;
			const link = app.links[server.id];
			const state = link ? connectionState(link.net) : "checking";
			const ws = link?.workspace ?? null;
			const d = link?.data;
			// Not searching: the shared list (see app.dirsByServer); a search narrows it, so only then is it built here.
			const shared = q ? undefined : app.dirsByServer[server.id] ?? [];
			const data = build(d?.sessions ?? [], d?.groups ?? [], ws, q, app.sidebar.dirOrder[server.id], app.sidebar.tabOrder[server.id], app.sidebar.groupDir[server.id], app.sidebar.pinned[server.id], app.sidebar.pinnedTabs[server.id], d?.terminals ?? [], shared);
			return { server, current, state, loaded: Boolean(link?.loaded), home: ws?.home, platform: link?.terminalSupport?.platform, ...data };
		});
		// A server that is up rises above the ones still being checked, and both above the unreachable (shown only; the saved order is untouched).
		return orderServers(list);
	});

	const searching = $derived(query.trim().length > 0);
	/* Freeze the order as listed (never while searching: that list is partial), so nothing jumps when tabs close or group. */
	$effect(() => {
		if (searching) return;
		for (const n of nodes)
			if (n.loaded && n.state === "online" && n.dirs.length)
				untrack(() => app.sidebar.pin(n.server.id, n.dirs.map((d) => d.path), n.dirs.flatMap((d) => d.tabs.map((x) => x.id)), Object.fromEntries(n.dirs.flatMap((d) => d.tabs.filter((x) => x.kind === "group").map((x) => [x.id, d.path])))));
	});
	const nothingFound = $derived(searching && nodes.every((n) => n.total === 0));
	/** Activity of a session, from its own server's live state. */
	const stateOfId = (n: Node, id: string): Activity => {
		const d = app.links[n.server.id]?.data;
		return d ? activityOf(d, id) : "idle";
	};
	const stateOf = (n: Node, x: Session): Activity => stateOfId(n, x.id);


	const isFolded = (key: string) => !searching && app.sidebar.folded.includes(key);

	/**
	 * Keep the open row in view: the list scrolls to it when something else opens (a new conversation in a folder far
	 * down, a terminal started from the "+"), so the row it belongs to is on screen and not merely unfolded. The folder
	 * is unfolded first (store `revealRow`), so the row exists by the time this runs.
	 */
	let listEl: HTMLElement | undefined = $state();
	/** The open row, when the list has it out of view (null while it is visible or missing). */
	function offscreen(host: HTMLElement): HTMLElement | null {
		const row = host.querySelector<HTMLElement>(".item.active");
		if (!row) return null;
		const box = host.getBoundingClientRect();
		const r = row.getBoundingClientRect();
		return r.top >= box.top && r.bottom <= box.bottom ? null : row;
	}
	$effect(() => {
		void app.activeId;
		void app.sidebar.folded;
		const host = listEl;
		if (!host) return;
		schedule(host, () => {
			const row = offscreen(host);
			return row ? () => row.scrollIntoView({ block: "nearest" }) : undefined;
		});
		// A folder unfolds over `normal` and the open row keeps moving under it: look once more when it has settled.
		const settled = setTimeout(() => offscreen(host)?.scrollIntoView({ block: "nearest" }), ms("normal") + 50);
		return () => {
			clearTimeout(settled);
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
		!searching && carried && carried !== x && ofDir(d, carried) ? edgeAt(pt, isGroupId(carried)) : null;
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
	/** Let go on a folder: the pane steps out of its group, as a tab of its own. */
	const dropOnDir = (id: string) => void app.leaveGroup(id);
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
		const items = headMenuEntries(platformName(n.platform), isFolded(key), {
			chat: () => app.openIn(n.server.id, { workdir }),
			terminal: () => app.openIn(n.server.id, { workdir, terminal: true }),
			toggle: () => app.sidebar.toggleFolded(key),
			togglePin: path === null ? undefined : () => app.sidebar.togglePinned(n.server.id, path),
			pinned: path !== null && app.sidebar.isPinned(n.server.id, path),
			rename: path !== null ? () => dirRename.start(key, shortLabel(n, path)) : undefined,
			copyPath: path === null ? undefined : () => void copyText(path).then((ok) => app.toast(ok ? t("경로를 복사했습니다") : t("복사하지 못했습니다"), ok ? "ok" : "error")),
		});
		rowMenu?.openAt(pt, id, items);
		return () => menuId === id && rowMenu?.close();
	}
	// What the rows below share, handed down once instead of through a dozen props each.
	setSidebarCtx({
		marks,
		rename,
		groupRename,
		dirRename,
		commitDirRename,
		get menuId() {
			return menuId;
		},
		get searching() {
			return searching;
		},
		isFolded,
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
		dirSource,
		pretty,
		shortLabel,
	});
	$effect(() => { void app.configTick; void app.serverExtensionsTick; void extensionUpdates.refresh(Object.fromEntries(Object.entries(app.links).map(([id, l]) => [id, l?.api]))); });
	/** Something in settings needs the user: a newer app or server build, or the two out of step. Connection state is not here: the sidebar's server block already shows it. */
	/** Only an optional update is green; a version mismatch (the app and server cannot work together) stays amber. */
	/** A saved model that no longer works outranks an update: chats, compaction or naming fail until it is fixed. */
	const problems = $derived(app.problemCount);
	/** Scheduled tasks of the open server: the button shows for any server that has the feature, even with none (so it can be found). */
	const scheduled = $derived(app.schedules.all(app.serverId));
	const schedulesShown = $derived(!!app.serverId && app.schedules.supported(app.serverId));
	const schedulesTip = $derived(scheduled.next === null ? t("예약 작업") : t("다음 실행: {when}", { when: whenShort(scheduled.next) }));
	const alertTone = $derived(problems ? "danger" : app.compat === "ok" ? "ok" : "warn");
	const settingsAlert = $derived(problems ? t("설정 문제 {n}", { n: problems }) : app.compat !== "ok" ? t("업데이트 필요") : updater.visible ? t("업데이트 있음") : serverUpdater.available ? t("서버 업데이트 있음") : "");
</script>


<aside class="side" data-part="sidebar">
	<div class="brandrow" data-part="sidebar.brand">
		<ExtensionPart part="sidebar.brand">
		<PipayaMark color size={26} />
		<Wordmark size={16} />
		</ExtensionPart>
		<IconButton icon="sidebar" label={t("사이드바 접기")} title={t("사이드바 접기") + hint} class="foldbtn" onclick={() => app.sidebar.toggleCollapsed()} />
	</div>
	<ExtensionMount slot="sidebar.top" />
	<div class="tools">
		<SearchField label={t("대화 검색")} data-sidebar-search bind:value={query} />
	</div>

	<nav class="list" bind:this={listEl} use:slidingIndicator={{ selector: ".item.active", radius: "var(--radius-sm)" }} onscroll={() => rowMenu?.close()}>
		{#each nodes as n (n.server.id)}
			<ServerBlock {n} {searching} single={nodes.length < 2} />
		{/each}

		{#if nothingFound}<EmptyState tone="plain">{t("검색 결과가 없습니다")}</EmptyState>{/if}
	</nav>

	<div class="bottom" data-part="sidebar.bottom">
		<ExtensionPanels placement="sidebar" />
		<ExtensionMount slot="sidebar.bottom" />
		{#if schedulesShown}
			<button class="navbtn wide" onclick={() => (app.schedulesDialog = true)} title={schedulesTip}>
				<span class="sico"><Icon name="clock" /></span> {t("예약 작업")}
				{#if scheduled.count}<span class="salert"><Badge size="sm">{scheduled.count}</Badge></span>{/if}
			</button>
		{/if}
		<button class="settings navbtn wide" onclick={() => app.openSettings()}>
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
	.tools {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
		padding: 12px 8px; /* the search box shares the card's left and right edges (8) */
		border-bottom: 1px solid var(--border);
	}
	.navbtn :global(svg) {
		width: 18px;
		height: 18px;
		stroke-width: 1.9;
	}
	:global(.iconbtn.foldbtn) {
		margin-left: auto;
		margin-right: -9.5px; /* the 19px icon's right edge sits on the 16px gutter, like the server chevron below */
	}
	/* 38px in a 44px row: an outer ring would run into the window's top edge, so it is drawn inside */
	:global(.iconbtn.foldbtn:focus-visible) {
		outline-offset: -2px;
	}
	@media (min-width: 861px) {
		.side {
			width: var(--sidebar-w); /* the wrapper animates its width; the content must not reflow */
		}
	}
	.list {
		--band: color-mix(in srgb, var(--text) 3.5%, var(--bg-side));
		--band-head: color-mix(in srgb, var(--text) 8%, var(--bg-side));
		position: relative;
		flex: 1;
		overflow-y: auto;
		padding: 8px 0 16px; /* 8 below the search box, 16 above the window edge */
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
	   20 wide x the full row high, so the list button's and the "+" boxes touch but never overlap (the 44px .tap box overlapped by 24) */
	:global(:where(.side) .dirnew.tap::after) {
		width: 100%;
		height: 40px;
	}
	}
	:global(:where(.side) .dirnew:hover),
	:global(:where(.side) .dirnew.on) {
		background: color-mix(in srgb, var(--text) 14%, transparent);
		color: var(--text);
		opacity: 1;
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
	/* the open tab: a soft wash that fades out to the right, a faint hairline and a lifted title; no bar, so it stays quiet */
	:global(:where(.side) .list .slide-ind) {
		border-radius: var(--radius-control) !important;
		z-index: 1; /* above the server band's own background, which would otherwise hide it; the wash is translucent */
		background: linear-gradient(90deg, color-mix(in srgb, var(--text) 13%, transparent), color-mix(in srgb, var(--text) 5%, transparent));
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 9%, transparent);
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
	/* the two buttons at the bottom (scheduled tasks, settings) are one shape: same height, padding and glyph column */
	.navbtn {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 38px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		transition: background var(--motion-fast) var(--ease-std);
	}
	.navbtn:hover {
		background: var(--bg-hover);
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
	}
</style>
