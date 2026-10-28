<script lang="ts">
	import EmptyState from "./EmptyState.svelte";
	import SearchField from "./SearchField.svelte";
	import ExtensionMount from "./extensions/ExtensionMount.svelte";
	import ExtensionPanels from "./extensions/ExtensionPanels.svelte";
	import ExtensionPart from "./extensions/ExtensionPart.svelte";
	import { untrack } from "svelte";
	import Pin from "./Pin.svelte";
	import Badge from "./Badge.svelte";
	import { updater } from "../lib/updater.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";
	import { t } from "../lib/i18n";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { formatCombo } from "../lib/keys";
	import Icon from "./Icon.svelte";
	import IconButton from "./IconButton.svelte";
	import RowMenu, { type RowMenuItem } from "./RowMenu.svelte";
	import PipayaMark from "./PipayaMark.svelte";
	import Wordmark from "./Wordmark.svelte";
	import { activityOf, type Activity } from "../lib/activity";
	import { app } from "../lib/store.svelte";
	import { extensionUpdates } from "../lib/extension-updates.svelte";
	import { tilde } from "../lib/format";
	import { copyText } from "../lib/clipboard";
	import { chooseGroup } from "../lib/group-picker";
	import type { Point } from "../lib/press-menu";
	import { drag } from "../lib/dnd.svelte";
	import { blockDrag } from "../lib/block-drag";
	import { InlineRename } from "../lib/inline-rename.svelte";
	import { DragMarks } from "../lib/drag-marks.svelte";
	import { sidebarDirs, type DirBlock, type Tab } from "../lib/nav";
	import { connectionState, edgeOf, headMenuEntries, newKey, newMenuEntries, rowMenuEntries, shortName, targetId, type RowActions } from "../lib/sidebar-model";
	import type { Group, Session, WorkspaceInfo } from "../lib/types";
	import { platformName, type TerminalInfo } from "../lib/terminal";
	import { setSidebarCtx, type MenuTarget, type SidebarNode } from "../lib/sidebar-ctx";
	import ServerBlock from "./sidebar/ServerBlock.svelte";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	let query = $state("");
	/** The conversation or terminal being renamed in place, and the split tab (group) being renamed. */
	const rename = new InlineRename();
	const groupRename = new InlineRename();
	/** What the sidebar draws while something is dragged (the row pulled onto, the drop lines, the carried block). */
	const marks = new DragMarks();

	type Node = SidebarNode;

	/** Everything shown comes from the servers themselves: their session lists and workspace roots. */
	function build(sessions: Session[], groups: Group[], ws: WorkspaceInfo | null, q: string, order: string[] | undefined, torder: string[] | undefined, gdir: Record<string, string> | undefined, terminals: TerminalInfo[], archived: Session[]): Pick<Node, "root" | "total" | "dirs" | "archived"> {
		const dirs = sidebarDirs(sessions, groups, terminals, {
			match: (x) => !q || x.title.toLowerCase().includes(q),
			matchGroup: (g) => !!q && g.name.toLowerCase().includes(q),
			matchTerminal: (x) => !q || x.title.toLowerCase().includes(q),
			dirOrder: order,
			tabOrder: torder,
			groupDir: gdir,
		});
		const total = dirs.reduce((n, d) => n + d.tabs.length, 0);
		// Archived conversations hang under their folder; a folder with only archived ones still shows, after the others.
		const byDir: Record<string, Session[]> = {};
		for (const s of archived) if (!q || s.title.toLowerCase().includes(q)) (byDir[s.cwd] ??= []).push(s);
		for (const cwd of Object.keys(byDir)) if (!dirs.some((d) => d.path === cwd)) dirs.push({ path: cwd, tabs: [] });
		return { root: ws?.root, total, dirs, archived: byDir };
	}
	/** `~/workspace/x` for display; each server has its own home */
	const pretty = (n: Node, path: string) => tilde(path, n.home);
	/** A folder's label on server `n` (see sidebar-model). */
	const shortLabel = (n: Node, path: string) => shortName(path, n.home);

	const nodes = $derived.by<Node[]>(() => {
		const q = query.trim().toLowerCase();
		return app.servers.map((server) => {
			const current = server.id === app.serverId;
			const link = app.links[server.id];
			const state = link ? connectionState(link.net) : "checking";
			const ws = link?.workspace ?? null;
			const d = link?.data;
			const data = build(d?.sessions ?? [], d?.groups ?? [], ws, q, app.sidebar.dirOrder[server.id], app.sidebar.tabOrder[server.id], app.sidebar.groupDir[server.id], d?.terminals ?? [], d?.archived ?? []);
			return { server, current, state, loaded: Boolean(link?.loaded), home: ws?.home, platform: link?.terminalSupport?.platform, ...data };
		});
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
	const stateOf = (n: Node, x: Session): Activity => {
		const d = app.links[n.server.id]?.data;
		return d ? activityOf(d, x.id) : "idle";
	};


	const isFolded = (key: string) => !searching && app.sidebar.folded.includes(key);

	const startRename = (id: string, title: string) => rename.start(id, title);
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
	const tabHover = (d: DirBlock, x: Tab) => (pt: { x: number; y: number } | null) => {
		const edge = pt ? reorderEdge(d, x.id, pt) : null;
		marks.setTab(x.id, edge);
		const pairs = !!pt && !edge && !isGroupId(drag.id) && !(x.kind === "group" && x.members.some((m) => m.id === drag.id));
		marks.hover(x.id, pairs);
	};
	const tabDropAt = (n: Node, d: DirBlock, x: Tab) => async (id: string, pt: { x: number; y: number }) => {
		// drag.id is already cleared when drop runs, so pass the dropped id explicitly
		const edge = reorderEdge(d, x.id, pt, id);
		marks.tab = null;
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
		archiveSession: (id) => void app.archive(id),
		closeTerminal: (id) => void app.closeTerminal(id),
		dissolveGroup: (id) => void app.deleteGroup(id),
		leaveGroup: (id) => void app.leaveGroup(id),
	};
	const menuItems = (target: MenuTarget, member = false): RowMenuItem[] => rowMenuEntries(target, rowActions, member);
	let rowMenu: ReturnType<typeof RowMenu> | undefined = $state();
	/** Id of the session or group whose menu is open (its button stays highlighted). */
	let menuId = $state<string | null>(null);
	const hoverMenu = (e: PointerEvent, target: MenuTarget) => rowMenu?.hover(e, targetId(target), menuItems(target));
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
		get menuId() {
			return menuId;
		},
		get searching() {
			return searching;
		},
		isFolded,
		stateOf,
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
	$effect(() => { void app.configTick; void app.serverExtensionsTick; void extensionUpdates.refresh(app.api); });
	/** Something in settings needs the user: a newer app or server build, or the two out of step. */
	/** Only an optional update is green; a version mismatch (the app and server cannot work together) stays amber. */
	const alertTone = $derived(app.net === "online" && app.compat === "ok" ? "ok" : "warn");
	const settingsAlert = $derived(app.compat !== "ok" ? t("업데이트 필요") : updater.visible || serverUpdater.available ? t("업데이트 있음") : "");
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

	<nav class="list" use:slidingIndicator={{ selector: ".item.active", radius: "var(--radius-sm)" }} onscroll={() => rowMenu?.close()}>
		{#each nodes as n (n.server.id)}
			<ServerBlock {n} {searching} single={nodes.length < 2} />
		{/each}

		{#if nothingFound}<EmptyState tone="plain">{t("검색 결과가 없습니다")}</EmptyState>{/if}
	</nav>

	<div class="bottom" data-part="sidebar.bottom">
		<ExtensionPanels placement="sidebar" />
		<ExtensionMount slot="sidebar.bottom" />
		<button class="settings wide" onclick={() => app.openSettings()}>
			<span class="sico"><Icon name="settings" />{#if app.net !== "online" || settingsAlert || extensionUpdates.any}<Pin tone={app.net !== "online" ? "warn" : alertTone} label={app.net !== "online" ? t("연결 안 됨") : settingsAlert || t("업데이트 있음")} />{/if}</span> {t("설정")}
			{#if settingsAlert}<span class="salert"><Badge tone={alertTone} size="sm">{settingsAlert}</Badge></span>{/if}
			{#if updater.current}<span class="sver" class:push={!settingsAlert}>v{updater.current}</span>{/if}
		</button>
	</div>
</aside>

<RowMenu bind:this={rowMenu} bind:open={menuId} />

<style>
	/* label of a pane in a split tab: kept in view while the pane scrolls */
	:global(:where(.side) .who) {
		flex: none;
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--text-faint);
	}
	:global(:where(.side) .who.working) { color: var(--info); }
	:global(:where(.side) .who.asking) { color: var(--warn); }
	:global(:where(.side) .who.done) { color: var(--ok); }
	:global(:where(.side) .who.failed) { color: var(--danger); }
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
		gap: 10px;
		/* same box as the header capsule (44px + 1px hairline), so the two lines meet across the sidebar edge */
		box-sizing: content-box;
		height: 44px;
		padding: 0 16px;
		border-bottom: 1px solid var(--border);
		color: var(--text);
	}
	.tools {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--border);
	}
	.settings :global(svg) {
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
	:global(:where(.side) .forkmark) {
		display: grid;
		flex: none;
		color: var(--text-faint);
	}
	:global(:where(.side) .forkmark svg) {
		width: 13px;
		height: 13px;
		stroke-width: 2;
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
		padding: 4px 0 12px;
		overscroll-behavior: contain;
	}
	/* a block being dragged fades */
	:global(:where(.side) .srv.carried),
	:global(:where(.side) .dirblock.carried) {
		opacity: 0.45;
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
	:global(:where(.side) .dicon svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	:global(:where(.side) .dir) {
		display: flex;
		align-items: center;
		margin-top: 12px;
		border-radius: var(--radius-sm);
	}
	:global(:where(.side) .dirblock:first-child > .dir) {
		margin-top: 4px;
	}
	:global(:where(.side) .dir.grabbable),
	:global(:where(.side) .srvhead.grabbable) {
		cursor: grab;
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
	}
	:global(:where(.side) .dirblock) {
		position: relative;
	}
	:global(:where(.side) .dirblock.before::before),
	:global(:where(.side) .dirblock.after::after) {
		left: 0;
		right: 0;
	}
	:global(:where(.side) .dirblock.before::before) {
		top: -1px;
	}
	:global(:where(.side) .dirblock.after::after) {
		bottom: -1px;
	}
	:global(:where(.side) .dirtoggle) {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		border-radius: var(--radius-sm);
		padding: 0 6px 0 4px; /* chevron, folder icon, name: its tabs hang under the icon */
		text-align: left;
		color: var(--text-dim);
		transition: color var(--motion-fast) var(--ease-std);
	}
	:global(:where(.side) .dir:hover .dirtoggle),
	:global(:where(.side) .dir.cur .dirtoggle) {
		color: var(--text);
	}
	:global(:where(.side) .dicon) {
		display: grid;
		flex: none;
		width: 14px;
		color: var(--text-faint);
	}
	/* name and parent path share one baseline; the pair is centred on the icons (line-height 1 drops the uneven leading) */
	:global(:where(.side) .dlabel) {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 6px;
		line-height: 1;
		padding-bottom: 1px; /* lowercase sits low in its box: lift it onto the icons' centre */
	}
	/* where the folder sits, dim after its name; the full path is the tooltip */
	:global(:where(.side) .dparent) {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
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
	:global(:where(.side) .dname) {
		flex: none;
		max-width: 70%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		font-weight: 600;
	}
	/* a folded row's count: a small round badge pushed to the right edge */
	:global(:where(.side) .cbadge) {
		margin-left: auto;
	}
	:global(:where(.side) .dirnew) {
		display: grid;
		place-items: center;
		flex: none;
		width: 24px;
		height: 24px;
		margin-right: 4px;
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
	}
	/* folded rows: on hover the count gives way to the "+", which takes its place instead of sitting beside it */
	@media (hover: hover) {
		:global(:where(.side) .dir.folded),
	:global(:where(.side) .srvhead.folded) {
			position: relative;
		}
		:global(:where(.side) .dir.folded .dirnew),
	:global(:where(.side) .srvhead.folded .dirnew) {
			position: absolute;
			top: 50%;
			translate: 0 -50%;
		}
		:global(:where(.side) .dir.folded .dirnew) {
			right: 2px;
		}
		:global(:where(.side) .srvhead.folded .dirnew) {
			right: 10px;
		}
		:global(:where(.side) .dir.folded .cbadge),
	:global(:where(.side) .srvhead.folded .cbadge) {
			transition: opacity var(--motion-fast) var(--ease-std);
		}
		:global(:where(.side) .dir.folded:hover .cbadge),
	:global(:where(.side) .srvhead.folded:hover .cbadge) {
			opacity: 0;
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
	}
	/* only the line icons (terminal, split tab): a model logo keeps its own fill and colours */
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
	:global(:where(.side) .item) {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: var(--radius-control);
		margin: 1px 2px;
		transition: background var(--motion-fast) var(--ease-std);
	}
	:global(:where(.side) .list .item.nested .open) {
		padding-left: 43px; /* one step in: the tab's icon sits under the folder's icon (.list outranks the generic .open padding below) */
	}
	:global(:where(.side) .item:hover) {
		background: var(--bg-hover);
	}
	:global(:where(.side) .item.active) {
		background: var(--bg-active);
	}
	/* the sliding marker draws the selection; the row itself stays clear so the two never double up */
	:global(:where(.side) .list[data-indicator-ready] .item.active) {
		background: transparent;
	}
	:global(:where(.side) .item.active .title) {
		font-weight: 700;
		color: var(--text);
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
	:global(:where(.side) .item.active:hover) {
		background: transparent;
	}
	:global(:where(.side) .open:not(.acc):not(.chev)) {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		padding: 0 10px 0 4px;
		text-align: left;
		outline-offset: -1px;
	}
	:global(:where(.side) .title) {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
	}
	/* a title that does not fit flows by while the row is hovered or focused, looping back to its start */
	:global(:where(.side) .title .track) {
		display: inline;
	}
	:global(:where(.side) .title .dup) {
		display: none;
	}
	@media (hover: hover) {
		:global(:where(.side) .item:hover .title[data-over]),
	:global(:where(.side) .item:focus-within .title[data-over]) {
			text-overflow: clip;
			-webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
			mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
		}
		:global(:where(.side) .item:hover .title[data-over] .track),
	:global(:where(.side) .item:focus-within .title[data-over] .track) {
			display: flex;
			width: max-content;
			animation: mq var(--mq-d, 8s) linear infinite;
		}
		:global(:where(.side) .item:hover .title[data-over] .mq),
	:global(:where(.side) .item:focus-within .title[data-over] .mq),
	:global(:where(.side) .item:hover .title[data-over] .dup),
	:global(:where(.side) .item:focus-within .title[data-over] .dup) {
			display: block;
			flex: none;
			padding-right: 32px;
		}
	}
	/* touch has no hover, so the open session's long title flows by on its own; on desktop only hover/focus (above) does */
	@media (hover: none) {
		:global(:where(.side) .item.active .title[data-over]) {
			text-overflow: clip;
			-webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
			mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
		}
		:global(:where(.side) .item.active .title[data-over] .track) {
			display: flex;
			width: max-content;
			animation: mq var(--mq-d, 8s) linear infinite;
		}
		:global(:where(.side) .item.active .title[data-over] .mq),
	:global(:where(.side) .item.active .title[data-over] .dup) {
			display: block;
			flex: none;
			padding-right: 32px;
		}
	}
	@keyframes -global-mq {
		from {
			translate: 0;
		}
		to {
			translate: -50%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(:where(.side) .item .title[data-over] .track) {
			animation: none !important;
		}
	}
	:global(:where(.side) .acts) {
		display: none;
	}
	:global(:where(.side) .item:hover .acts),
	:global(:where(.side) .item:focus-within .acts),
	:global(:where(.side) .item.menuopen .acts) {
		display: flex;
	}
	@media (pointer: coarse) {
		:global(:where(.side) .acts) {
			display: flex;
		}
		:global(:where(.side) .item:not(.active):not(.cur):not(.menuopen) .acts) {
			display: none;
		}
	}
	/* the three dots: same box and right edge as the + on the directory row above */
	:global(:where(.side) .more) {
		display: grid;
		place-items: center;
		flex: none;
		width: 24px;
		height: 24px;
		margin-right: 2px; /* a tab row ends 2px short of a folder row, so 24px + 2px = the "+" column of the folder row above (x 242-266) */
		border-radius: 50%; /* a round hit area: a square tint on a row of rounded corners looked off */
		color: var(--text-faint);
		transition: background-color var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std);
	}
	:global(:where(.side) .more:hover),
	:global(:where(.side) .more.on),
	:global(:where(.side) .more:focus-visible) {
		background: color-mix(in srgb, var(--text) 14%, transparent); /* over the row's own tint, so it also shows on the open row */
		color: var(--text);
	}
	:global(:where(.side) .more svg) {
		width: 15px;
		height: 15px;
		stroke-width: 2.6;
	}
	:global(:where(.side) .rename) {
		flex: 1;
		margin: 4px;
		height: 34px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--accent);
		background: var(--bg);
		outline: 0;
		font-size: var(--fs-lg);
		min-width: 0;
	}
	.bottom {
		padding: 6px 8px calc(8px + var(--sab));
		border-top: 1px solid var(--border);
	}
	.settings {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		height: 38px;
		padding: 0 10px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		transition: background var(--motion-fast) var(--ease-std);
	}
	.settings:hover {
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
	/* hairline between workspaces / groups */

	/* A split tab and its panes read as one tree: the book row on top, its panes hanging off a line under the book. */
	:global(:where(.side) .grp) {
		margin: 2px 0; /* full width like the other tabs, so the book sits where their icons do */
		border-radius: var(--radius-sm);
	}
	:global(:where(.side) .grp .item.nested .open) {
		padding-left: 7px; /* chevron (x 47-61) + 7 = the tabs' icon column at x 68 */
	}
	:global(:where(.side) .grp .item.member .open) {
		padding-left: 70px; /* the pane's icon, just past the elbow */
		min-height: 30px;
	}
	:global(:where(.side) .grp .item.member .title) {
		color: var(--text-dim);
	}
	:global(:where(.side) .grp .item.member.active .title) {
		color: var(--text);
	}
	/* tree line: a rule down from the book's centre; each pane gets a short rounded elbow (the last one ends the rule) */
	:global(:where(.side) .branch) {
		position: absolute;
		left: 50px; /* the book's centre */
		top: 0;
		bottom: 0;
		width: 12px;
		pointer-events: none;
	}
	:global(:where(.side) .branch::before) {
		content: "";
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		border-left: 1.5px solid var(--border-strong, var(--border));
	}
	:global(:where(.side) .branch::after) {
		content: "";
		position: absolute;
		left: 0;
		top: calc(50% - 8px);
		width: 100%;
		height: 8px;
		border-left: 1.5px solid var(--border-strong, var(--border));
		border-bottom: 1.5px solid var(--border-strong, var(--border));
		border-bottom-left-radius: 8px;
	}
	:global(:where(.side) .members .item:last-child .branch::before) {
		bottom: calc(50% + 8px);
	}
	:global(:where(.side) .grprow.cur .title) {
		font-weight: 600;
	}
	:global(:where(.side) .gfold) {
		flex: none;
		display: grid;
		place-items: center;
		width: 14px;
		height: 24px;
		margin-left: 22px; /* the folder row's chevron column: chevron, then the icon at the tabs' icon edge */
		border-radius: var(--radius-sm);
	}
	:global(:where(.side) .grprow .lead) {
		width: 16px; /* the tabs' icon column (16px), so the book icon and the name line up with theirs */
	}
	:global(:where(.side) .gfold:hover .chev svg) {
		stroke: var(--text);
	}
	:global(:where(.side) .grp.over) {
		background: var(--accent-soft);
	}
	:global(:where(.side) .dir.over) {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	/* the line where a carried session would land among its siblings */
	:global(:where(.side) .item.before::before),
	:global(:where(.side) .item.after::after) {
		left: 8px;
		right: 8px;
	}
	:global(:where(.side) .item.before::before) {
		top: -1px;
	}
	:global(:where(.side) .item.after::after) {
		bottom: -1px;
	}
	/* the row being pulled onto: pairs up with whatever is dropped */
	:global(:where(.side) .item.over) {
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 1.5px var(--accent);
	}
	:global(:where(.side) .item.grabbable) {
		cursor: grab;
		-webkit-tap-highlight-color: transparent;
	}
	@media (max-width: 860px) {
		:global(.iconbtn.foldbtn) {
			display: none;
		}
	}</style>
