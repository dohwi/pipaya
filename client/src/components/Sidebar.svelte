<script lang="ts">
	import SearchField from "./SearchField.svelte";
	import ExtensionMount from "./extensions/ExtensionMount.svelte";
	import ExtensionPart from "./extensions/ExtensionPart.svelte";
	import { untrack } from "svelte";
	import Pin from "./Pin.svelte";
	import Badge from "./Badge.svelte";
	import { updater } from "../lib/updater.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";
	import { msg, t } from "../lib/i18n";
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
	import { drag } from "../lib/dnd.svelte";
	import { blockDrag } from "../lib/block-drag";
	import { InlineRename } from "../lib/inline-rename.svelte";
	import { DragMarks } from "../lib/drag-marks.svelte";
	import { collapseIn, collapseOut } from "../lib/motion";
	import { sidebarDirs, type DirBlock, type Tab } from "../lib/nav";
	import { connectionState, edgeOf, newKey, newMenuEntries, rowMenuEntries, shortName, targetId, unreachable, type RowActions } from "../lib/sidebar-model";
	import type { Group, Session, WorkspaceInfo } from "../lib/types";
	import { platformName, type TerminalInfo } from "../lib/terminal";
	import { setSidebarCtx, type MenuTarget, type SidebarNode } from "../lib/sidebar-ctx";
	import DirBlockView from "./sidebar/DirBlock.svelte";
	import NewButton from "./sidebar/NewButton.svelte";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	let query = $state("");
	/** The conversation or terminal being renamed in place, and the split tab (group) being renamed. */
	const rename = new InlineRename();
	const groupRename = new InlineRename();
	/** What the sidebar draws while something is dragged (the row pulled onto, the drop lines, the carried block). */
	const marks = new DragMarks();

	type Node = SidebarNode;

	/** Everything shown comes from the servers themselves: their session lists and workspace roots. */
	function build(sessions: Session[], groups: Group[], ws: WorkspaceInfo | null, q: string, order: string[] | undefined, torder: string[] | undefined, gdir: Record<string, string> | undefined, terminals: TerminalInfo[]): Pick<Node, "root" | "total" | "dirs"> {
		const dirs = sidebarDirs(sessions, groups, terminals, {
			match: (x) => !q || x.title.toLowerCase().includes(q),
			matchGroup: (g) => !!q && g.name.toLowerCase().includes(q),
			matchTerminal: (x) => !q || x.title.toLowerCase().includes(q),
			dirOrder: order,
			tabOrder: torder,
			groupDir: gdir,
		});
		const total = dirs.reduce((n, d) => n + d.tabs.length, 0);
		return { root: ws?.root, total, dirs };
	}
	/** `~/workspace/x` for display; each server has its own home */
	const pretty = (n: Node, path: string) => tilde(path, n.home);
	/** A folder's label on server `n` (see sidebar-model). */
	const shortLabel = (n: Node, path: string) => shortName(path, n.dirs, n.home);

	const nodes = $derived.by<Node[]>(() => {
		const q = query.trim().toLowerCase();
		return app.servers.map((server) => {
			const current = server.id === app.serverId;
			const ov = app.overview[server.id];
			const state = current ? connectionState(app.net) : ((app.status[server.id] ?? "checking") as Node["state"]);
			const ws = current ? app.workspace : (ov?.workspace ?? null);
			const data = build(current ? app.sessions : (ov?.sessions ?? []), current ? app.groups : (ov?.groups ?? []), ws, q, app.sidebar.dirOrder[server.id], app.sidebar.tabOrder[server.id], app.sidebar.groupDir[server.id], current ? app.terminals : (ov?.terminals ?? []));
			return { server, current, state, loaded: current ? app.sessionsLoaded : Boolean(ov), home: ws?.home, platform: current ? app.terminalSupport?.platform : undefined, ...data };
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
	/** Activity of a session on the open server (other servers report running / waiting only). */
	const stateOf = (n: Node, x: Session): Activity => {
		if (n.current) return activityOf(app, x.id);
		const ov = app.overview[n.server.id];
		return ov ? activityOf({ running: ov.running, awaiting: ov.awaiting, unread: {}, failed: {} }, x.id) : "idle";
	};

	const statusText = { online: "", offline: msg("연결 안 됨"), unauthorized: msg("토큰 거부됨"), incompatible: msg("앱 업데이트 필요"), checking: msg("확인 중") };

	const isFolded = (key: string) => !searching && app.sidebar.folded.includes(key);

	/* The other servers are read from the servers themselves, and kept fresh while the sidebar is in use. */
	$effect(() => {
		void app.servers.length;
		void app.serverId;
		void app.refreshOverview();
		const t = setInterval(() => !document.hidden && void app.refreshOverview(), 5_000);
		const onVisible = () => !document.hidden && void app.refreshOverview();
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(t);
			document.removeEventListener("visibilitychange", onVisible);
		};
	});

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
	/** Touch has no drag and drop: pick the conversation to pull this one together with. */
	function chooseGroup(x: { id: string; title: string }) {
		const own = app.groupOf(x.id);
		app.palette = {
			title: t("'{title}'와 묶기", { title: x.title }),
			empty: msg("묶을 다른 대화가 없습니다"),
			items: [...app.sessions, ...app.terminals]
				.filter((s) => s.id !== x.id)
				.map((s) => ({ id: s.id, title: s.title, sub: app.groupOf(s.id)?.name ?? tilde(s.cwd, app.workspace?.home), current: !!own && app.groupOf(s.id)?.id === own.id })),
			onpick: (it) => void app.groupWith(x.id, it.id),
		};
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
	const reorderEdge = (d: DirBlock, x: string, pt: { x: number; y: number }) =>
		!searching && drag.id && drag.id !== x && ofDir(d, drag.id) ? edgeAt(pt, isGroupId(drag.id)) : null;
	const tabHover = (d: DirBlock, x: Tab) => (pt: { x: number; y: number } | null) => {
		const edge = pt ? reorderEdge(d, x.id, pt) : null;
		marks.setTab(x.id, edge);
		const pairs = !!pt && !edge && !isGroupId(drag.id) && !(x.kind === "group" && x.members.some((m) => m.id === drag.id));
		marks.hover(x.id, pairs);
	};
	const tabDropAt = (n: Node, d: DirBlock, x: Tab) => async (id: string, pt: { x: number; y: number }) => {
		const edge = reorderEdge(d, x.id, pt);
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
		closeTerminal: (id) => void app.closeTerminal(id),
		dissolveGroup: (id) => void app.deleteGroup(id),
	};
	const menuItems = (target: MenuTarget): RowMenuItem[] => rowMenuEntries(target, rowActions);
	let rowMenu: ReturnType<typeof RowMenu> | undefined = $state();
	/** Id of the session or group whose menu is open (its button stays highlighted). */
	let menuId = $state<string | null>(null);
	const hoverMenu = (e: PointerEvent, target: MenuTarget) => rowMenu?.hover(e, targetId(target), menuItems(target));
	const leaveMenu = (e: PointerEvent) => rowMenu?.leave(e);
	const clickMenu = (e: MouseEvent, target: MenuTarget) => rowMenu?.click(e, targetId(target), menuItems(target));
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
	const settingsAlert = $derived(updater.visible || serverUpdater.available || app.compat !== "ok" ? t("업데이트 필요") : "");
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
			{@const sfold = isFolded(n.server.id)}
			{@const srvMark = marks.blockMark(bid("server", n.server.id))}
			<section class="srv band" data-block={bid("server", n.server.id)} data-server="" class:carried={srvMark.carried} class:before={srvMark.before} class:after={srvMark.after} class:cur={n.current} class:off={n.state === "offline" || n.state === "unauthorized" || n.state === "incompatible"}>
				<div class="srvhead grabbable" class:folded={sfold} use:dirSource={{ kind: "server", serverId: "", path: n.server.id, paths: [], disabled: nodes.length < 2 }}>
					<button class="srvtoggle" onclick={() => app.sidebar.toggleFolded(n.server.id)} aria-expanded={!sfold} title={n.root ? `${n.server.baseUrl}\n${n.root}` : n.server.baseUrl}>
						<span class="chev" class:folded={sfold}><Icon name="chevron-down" /></span>
						<span class="sicon {n.state}"><Icon name="server" /></span>
						<span class="sname">{app.serverLabel(n.server)}</span>
						{#if n.state !== "online"}<Badge size="sm" variant="outline" tone={n.state === "offline" ? "danger" : n.state === "checking" ? "neutral" : "warn"}>{t(statusText[n.state])}</Badge>{/if}
						{#if sfold && (n.state === "online" || n.loaded)}<span class="cbadge" title={t("{n}개", { n: n.total })}>{n.total}</span>{/if}
					</button>
					<NewButton {n} workdir="." key={n.server.id} name={app.serverLabel(n.server)} tip={t("이 서버에서 새 대화 또는 터미널")} />
				</div>

				{#if !sfold}
				<div class="fold" in:collapseIn out:collapseOut>
					{#if unreachable(n.state)}
						{#if n.loaded}<div class="nosess warnline">{t("마지막으로 확인된 목록")}</div>{/if}
					{/if}
					{#if !n.loaded && !unreachable(n.state)}
						<div class="sk skeleton-bar"></div>
					{:else if n.total === 0}
						{#if !unreachable(n.state) || n.loaded}
							<div class="nosess">{searching ? t("검색 결과 없음") : t("활성 대화 없음")}</div>
						{/if}
					{/if}

					{#each n.dirs as d (d.path)}
						<DirBlockView {n} {d} {searching} />
					{/each}
				</div>
				{/if}
			</section>
		{/each}

		{#if nothingFound}<div class="empty">{t("검색 결과가 없습니다")}</div>{/if}
	</nav>

	<div class="bottom" data-part="sidebar.bottom">
		<ExtensionMount slot="sidebar.bottom" />
		<button class="settings wide" onclick={() => app.openSettings()}>
			<span class="sico"><Icon name="settings" />{#if app.net !== "online" || settingsAlert || extensionUpdates.any}<Pin tone={app.net !== "online" ? "warn" : alertTone} label={app.net !== "online" ? t("연결 안 됨") : undefined} />{/if}</span> {t("설정")}
			{#if settingsAlert}<span class="salert"><Badge tone={alertTone} size="sm">{settingsAlert}</Badge></span>{/if}
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
	/* one full-bleed band per server: a tone step instead of a card, so no space is lost to a frame. The inner 8px keeps every row where it was */
	.srv {
		position: relative;
		padding: 0 8px 4px;
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
	/* where a carried server would land: a line in the gap beside its card */
	:global(:where(.side) .srv.before::before),
	:global(:where(.side) .srv.after::after) {
		left: 0;
		right: 0;
	}
	:global(:where(.side) .srv.before::before) {
		top: -5px;
	}
	:global(:where(.side) .srv.after::after) {
		bottom: -5px;
	}
	:global(:where(.side) .srv:has(> .fold)) {
		padding-bottom: 8px;
	}
	/* every server sits in a band, even when it is the only one */
	.srv.band {
		margin: 0 8px;
		background: var(--band);
		border: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
		border-radius: var(--radius);
	}
	.srv.band + .srv.band {
		margin-top: 8px;
	}
	:global(:where(.side) .srv.off .fold) {
		opacity: 0.45;
	}
	/* several servers: the folders hang under their server: the folder icon sits under its status dot and the name under the server name; the right edge stays put, so every "+" keeps one column */
	:global(:where(.side) .srv > .fold) {
		padding-left: 6px;
	}
	.srvhead {
		display: flex;
		align-items: center;
		margin: 0 -8px 4px; /* header strip spanning the card: a darker tone marks everything below as belonging to this server */
		padding: 0 8px;
		background: var(--band-head);
		border-radius: 11px 11px 0 0; /* the card's corners, minus its 1px border */
	}
	.srvhead:last-child {
		border-radius: 11px;
		margin-bottom: 0;
	}
	.srv:has(> .srvhead:last-child) {
		padding-bottom: 0; /* folded: the header is the whole card, no band strip under it */
	}
	.srvhead:hover {
		background: color-mix(in srgb, var(--text) 11%, var(--bg-side));
	}
	/* pressing the name or the "+" darkens the whole strip one more step; the global row tint (a lighter square inside the strip) is switched off here */
	.srvhead:has(.srvtoggle:active),
	:global(:where(.side) .srvhead:has(.dirnew:active)) {
		background: color-mix(in srgb, var(--text) 15%, var(--bg-side));
	}
	.srvhead .srvtoggle:active:not(:disabled) {
		background-color: transparent;
	}
	:global(:where(.side) .srvhead .dirnew:hover),
	:global(:where(.side) .srvhead .dirnew.on) {
		background: color-mix(in srgb, var(--text) 15%, var(--bg-side));
	}
	.srvtoggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 6px 0 10px; /* chevron and icon sit in the folder rows' columns */
		text-align: left;
		color: var(--text-dim);
	}
	:global(:where(.side) .srv.cur .srvtoggle) {
		color: var(--text);
	}
	/* the icon takes the folder-icon column, so the name lines up with the directory names */
	.sicon {
		position: relative;
		display: grid;
		flex: none;
		width: 14px;
		height: 14px;
		color: var(--text-faint);
	}
	.sicon :global(svg),
	:global(:where(.side) .dicon svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	/* the status is the server icon's colour (green online, red offline, amber needs attention, blinking while checking); only a problem adds a text pill after the name */
	.sicon.online {
		color: var(--ok);
	}
	.sicon.offline {
		color: var(--danger);
	}
	.sicon.unauthorized,
	.sicon.incompatible {
		color: var(--warn);
	}
	.sicon.checking {
		animation: blink-cursor 1s ease-in-out infinite;
	}
	.sname {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-md);
		font-weight: 600;
	}
	.warnline {
		color: var(--warn);
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
		margin-right: 2px;
		border-radius: var(--radius-sm);
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
		background: var(--bg-active);
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
	.nosess {
		padding: 4px 10px 6px 44px;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	:global(:where(.side) .item) {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: var(--radius-sm);
		margin: 0;
		transition: background var(--motion-fast) var(--ease-std);
	}
	:global(:where(.side) .item.nested .open) {
		padding-left: 43px; /* one step in: the tab's icon sits under the folder's name */
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
		font-weight: 600;
	}
	:global(:where(.side) .open) {
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
		width: 28px;
		height: 28px;
		margin-right: 2px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	:global(:where(.side) .more:hover),
	:global(:where(.side) .more.on),
	:global(:where(.side) .more:focus-visible) {
		background: var(--bg-active);
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
	.empty {
		padding: 28px 10px;
		text-align: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
	.sk {
		height: 36px;
		margin: 6px 4px;
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
		padding-left: 6px;
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
		width: 16px;
		height: 16px;
		margin-left: 43px; /* same left edge as the lead icon of the tabs above */
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	:global(:where(.side) .gfold svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.9;
	}
	:global(:where(.side) .gfold:hover) {
		background: var(--bg-active);
		color: var(--text);
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
	}
</style>
