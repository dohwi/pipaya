<script lang="ts">
	import { extensions } from "../lib/extensions/host.svelte";
	import StatusDot from "./StatusDot.svelte";
	import { msg, t } from "../lib/i18n";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { formatCombo } from "../lib/keys";
	import Icon from "./Icon.svelte";
	import RowMenu, { type RowMenuItem } from "./RowMenu.svelte";
	import { marquee, tail } from "../lib/fit-text";
	import PipayaMark from "./PipayaMark.svelte";
	import Wordmark from "./Wordmark.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import { ACTIVITY_LABEL, activityOf, type Activity } from "../lib/activity";
	import { app, type Server } from "../lib/store.svelte";
	import { hostOf, tilde } from "../lib/format";
	import { drag, dragSource, dropTarget, type DropOpts } from "../lib/dnd.svelte";
	import { blockDrag } from "../lib/block-drag";
	import { collapseIn, collapseOut } from "../lib/motion";
	import { sidebarDirs, type DirBlock, type Tab } from "../lib/nav";
	import type { Group, Session, WorkspaceInfo } from "../lib/types";
	import { isTerminalId, platformName, type TerminalInfo } from "../lib/terminal";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	let query = $state("");
	/** id of the session being renamed */
	let editing = $state<string | null>(null);
	let draft = $state("");
	/** id of the group being renamed */
	let editingGroup = $state<string | null>(null);
	let groupDraft = $state("");
	/** what a dragged session is hovering over: a group (join it) or another session (group with it) */
	let dropOn = $state<string | null>(null);

	interface Node {
		server: Server;
		current: boolean;
		state: "online" | "offline" | "unauthorized" | "incompatible" | "checking";
		loaded: boolean;
		root: string | undefined;
		home: string | undefined;
		total: number;
		dirs: DirBlock[];
		/** What the server runs (linux, darwin, win32), when it says so */
		platform: string | undefined;
	}

	/** Everything shown comes from the servers themselves: their session lists and workspace roots. */
	function build(sessions: Session[], groups: Group[], ws: WorkspaceInfo | null, q: string, order: string[] | undefined, torder: string[] | undefined, terminals: TerminalInfo[]): Pick<Node, "root" | "total" | "dirs"> {
		const dirs = sidebarDirs(sessions, groups, terminals, {
			match: (x) => !q || x.title.toLowerCase().includes(q),
			matchGroup: (g) => !!q && g.name.toLowerCase().includes(q),
			matchTerminal: (x) => !q || x.title.toLowerCase().includes(q),
			dirOrder: order,
			tabOrder: torder,
		});
		const total = dirs.reduce((n, d) => n + d.tabs.length, 0);
		return { root: ws?.root, total, dirs };
	}
	/** `~/workspace/x` for display; each server has its own home */
	const pretty = (n: Node, path: string) => tilde(path, n.home);
	const segs = (n: Node, path: string) => pretty(n, path).split("/").filter(Boolean);
	/** A folder's label: its own name, with as many parent names as it takes to tell it from the other folders. */
	function shortName(n: Node, path: string): string {
		const mine = segs(n, path);
		const others = n.dirs.filter((d) => d.path !== path).map((d) => segs(n, d.path));
		for (let k = 1; k < mine.length; k++) {
			const tail = mine.slice(-k).join("/");
			if (!others.some((o) => o.slice(-k).join("/") === tail)) return tail;
		}
		return mine.join("/") || pretty(n, path);
	}

	const nodes = $derived.by<Node[]>(() => {
		const q = query.trim().toLowerCase();
		return app.servers.map((server) => {
			const current = server.id === app.serverId;
			const ov = app.overview[server.id];
			const state = current
				? app.net === "online"
					? "online"
					: app.net === "unauthorized" || app.net === "incompatible"
						? app.net
						: app.net === "connecting"
							? "checking"
							: "offline"
				: ((app.status[server.id] ?? "checking") as Node["state"]);
			const ws = current ? app.workspace : (ov?.workspace ?? null);
			const data = build(current ? app.sessions : (ov?.sessions ?? []), current ? app.groups : (ov?.groups ?? []), ws, q, app.sidebar.dirOrder[server.id], app.sidebar.tabOrder[server.id], current ? app.terminals : (ov?.terminals ?? []));
			return { server, current, state, loaded: current ? app.sessionsLoaded : Boolean(ov), home: ws?.home, platform: current ? app.terminalSupport?.platform : undefined, ...data };
		});
	});

	const searching = $derived(query.trim().length > 0);
	const nothingFound = $derived(searching && nodes.every((n) => n.total === 0));
	/** Activity of a session on the open server (other servers report running / waiting only). */
	const stateOf = (n: Node, x: Session): Activity => {
		if (n.current) return activityOf(app, x.id);
		const ov = app.overview[n.server.id];
		return ov ? activityOf({ running: ov.running, awaiting: ov.awaiting, unread: {}, failed: {} }, x.id) : "idle";
	};

	const statusText = { online: "", offline: msg("연결 안 됨"), unauthorized: msg("토큰 거부됨"), incompatible: msg("앱 업데이트 필요"), checking: msg("확인 중") };

	const dirKey = (id: string, path: string) => `${id}\u0000${path}`;
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

	function startRename(id: string, title: string) {
		editing = id;
		draft = title;
	}
	function commitRename() {
		if (editing && draft.trim()) void (app.terminal(editing) ? app.renameTerminal(editing, draft) : app.rename(editing, draft));
		editing = null;
	}
	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
	function startGroupRename(g: Group) {
		editingGroup = g.id;
		groupDraft = g.name;
	}
	function commitGroupRename() {
		if (editingGroup && groupDraft.trim()) void app.renameGroup(editingGroup, groupDraft);
		editingGroup = null;
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
	const hover = (key: string) => (pt: unknown) => {
		if (pt) dropOn = key;
		else if (dropOn === key) dropOn = null;
	};
	const isGroupId = (id: string | null) => !!id && app.groups.some((g) => g.id === id);
	/* ---- reordering the tabs of a directory by dragging them next to each other ---- */
	/** the tab row a carried tab would land before / after */
	let tabDrop = $state<{ id: string; after: boolean } | null>(null);
	/**
	 * Over the top / bottom of a row = put it there; over the middle = put the two together (a group never goes into
	 * another group, so a carried group only ever reorders).
	 */
	function edgeAt(pt: { x: number; y: number }, whole: boolean): "before" | "after" | null {
		const r = document.elementFromPoint(pt.x, pt.y)?.closest<HTMLElement>(".item")?.getBoundingClientRect();
		if (!r) return null;
		const f = whole ? 0.5 : 0.28;
		if (pt.y < r.top + r.height * f) return "before";
		if (pt.y > r.bottom - r.height * f) return "after";
		return null;
	}
	/** Can the carried thing become a tab of directory `d` beside its others: one of its tabs, or a pane of one of its groups. */
	const ofDir = (d: DirBlock, id: string) => d.tabs.some((x) => x.id === id || (x.kind === "group" && x.members.some((m) => m.id === id)));
	/** The edge a drag over tab `x` means, when it is a reorder. */
	const reorderEdge = (d: DirBlock, x: string, pt: { x: number; y: number }) =>
		!searching && drag.id && drag.id !== x && ofDir(d, drag.id) ? edgeAt(pt, isGroupId(drag.id)) : null;
	const tabHover = (d: DirBlock, x: Tab) => (pt: { x: number; y: number } | null) => {
		const edge = pt ? reorderEdge(d, x.id, pt) : null;
		tabDrop = edge ? { id: x.id, after: edge === "after" } : tabDrop?.id === x.id ? null : tabDrop;
		const pairs = !!pt && !edge && !isGroupId(drag.id) && !(x.kind === "group" && x.members.some((m) => m.id === drag.id));
		if (pairs) dropOn = x.id;
		else if (dropOn === x.id) dropOn = null;
	};
	const tabDropAt = (n: Node, d: DirBlock, x: Tab) => async (id: string, pt: { x: number; y: number }) => {
		const edge = reorderEdge(d, x.id, pt);
		tabDrop = null;
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
	/** the block being carried (`dir:path`), and the one it would land next to */
	let dirDrag = $state<string | null>(null);
	let dirDrop = $state<{ id: string; after: boolean } | null>(null);
	const bid = (kind: "dir" | "group", key: string) => `${kind}:${key}`;
	/** `use:dirSource`: drag a directory header to reorder it (lib/block-drag.ts), drawn through dirDrag/dirDrop. */
	const dirSource = blockDrag({
		set: (drag, drop) => {
			dirDrag = drag;
			dirDrop = drop;
		},
		get: () => dirDrop,
		key: bid,
		move: (o, target, after) => app.sidebar.moveDir(o.serverId, o.paths, o.path, target, after),
	});
	/** Let go on a folder: the pane steps out of its group, as a tab of its own. */
	const dropOnDir = (id: string) => void app.leaveGroup(id);
	function newIn(n: Node, path: string) {
		app.openIn(n.server.id, { workdir: path });
	}
	/** The "+" of a server or directory: a conversation or a terminal, both starting in that place. */
	function newItems(n: Node, path: string): RowMenuItem[] {
		const os = platformName(n.platform);
		return [
			{ icon: "chat", label: t("새 대화"), title: "", run: () => newIn(n, path) },
			{
				icon: "terminal",
				label: os ? t("새 터미널 ({os})", { os }) : t("새 터미널"),
				title: t("서버의 셸을 이 폴더에서 엽니다 (Windows는 PowerShell)"),
				run: () => app.openIn(n.server.id, { workdir: path, terminal: true }),
			},
		];
	}
	const newId = (key: string) => `new\u0000${key}`;
	const hoverNew = (e: PointerEvent, n: Node, path: string, key: string) => rowMenu?.hover(e, newId(key), newItems(n, path));
	const clickNew = (e: MouseEvent, n: Node, path: string, key: string) => rowMenu?.click(e, newId(key), newItems(n, path));
	/** The workdir value `openIn` expects: "." for the server default, else the absolute path */
	const asWorkdir = (n: Node, path: string) => (path === n.root ? "." : path);

	type MenuTarget = { kind: "session"; x: Session } | { kind: "group"; g: Group } | { kind: "terminal"; x: TerminalInfo };
	/** Items of a row's "more" menu. */
	function menuItems(target: MenuTarget): RowMenuItem[] {
		if (target.kind === "group") {
			const g = target.g;
			return [
				{ icon: "pencil", label: t("그룹 이름 바꾸기"), title: "", run: () => startGroupRename(g) },
				{ icon: "unlink", label: t("그룹 해제"), title: t("그룹 해제 (대화는 그대로 남습니다)"), run: () => void app.deleteGroup(g.id) },
			];
		}
		if (target.kind === "terminal") {
			const x = target.x;
			return [
				{ icon: "columns", label: t("다른 대화와 묶기"), title: "", run: () => chooseGroup(x) },
				{ icon: "pencil", label: t("이름 바꾸기"), title: "", run: () => startRename(x.id, x.title) },
				{ icon: "x", label: t("터미널 닫기"), title: t("셸을 종료합니다"), run: () => void app.closeTerminal(x.id) },
			];
		}
		const x = target.x;
		return [
			{ icon: "columns", label: t("다른 대화와 묶기"), title: "", run: () => chooseGroup(x) },
			{ icon: "pencil", label: t("이름 바꾸기"), title: "", run: () => startRename(x.id, x.title) },
			{ icon: "x", label: t("닫기"), title: t("닫기 (/resume 으로 다시 열기)"), run: () => void app.close(x.id) },
		];
	}
	let rowMenu: ReturnType<typeof RowMenu> | undefined = $state();
	/** Id of the session or group whose menu is open (its button stays highlighted). */
	let menuId = $state<string | null>(null);
	const targetId = (target: MenuTarget) => (target.kind === "group" ? target.g.id : target.x.id);
	const hoverMenu = (e: PointerEvent, target: MenuTarget) => rowMenu?.hover(e, targetId(target), menuItems(target));
	const leaveMenu = (e: PointerEvent) => rowMenu?.leave(e);
	const clickMenu = (e: MouseEvent, target: MenuTarget) => rowMenu?.click(e, targetId(target), menuItems(target));
</script>


{#snippet row(n: Node, x: Session, drop: DropOpts, member = false)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="item nested"
		class:member
		class:active={n.current && x.id === app.activeId}
		class:over={dropOn === x.id}
		class:before={tabDrop?.id === x.id && !tabDrop.after}
		class:after={tabDrop?.id === x.id && tabDrop.after}
		class:grabbable={n.current && editing !== x.id}
		class:menuopen={menuId === x.id}
		use:dragSource={{ id: x.id, disabled: !n.current || editing === x.id }}
		use:dropTarget={drop}
	>
		{#if member}<span class="branch" aria-hidden="true"></span>{/if}
		{#if n.current && editing === x.id}
			<input
				class="rename"
				bind:value={draft}
				use:focusSelect
				onblur={commitRename}
				onkeydown={(e) => {
					if (e.key === "Enter") commitRename();
					if (e.key === "Escape") editing = null;
				}}
			/>
		{:else}
			{@const st = stateOf(n, x)}
			<button class="open wide" onclick={() => app.openIn(n.server.id, { session: x.id })} ondblclick={() => n.current && startRename(x.id, x.title)} title={[extensions.labelOf(x.id)?.title ?? "", x.title, st !== "idle" ? ACTIVITY_LABEL[st] : "", x.parentId ? t("분기된 대화") : ""].filter(Boolean).join(" · ")}>
				<!-- the model's logo; it takes the state colour and a dot while working, asking, done or failed -->
				<span class="lead"><AgentBadge id={x.id} state={st} size={16} /></span>
				{#if extensions.labelOf(x.id)}<span class="who mono {st}">{extensions.labelOf(x.id)?.text}</span>{/if}
				<span class="title" use:marquee={x.title}><span class="track"><span class="mq">{x.title}</span><span class="dup" aria-hidden="true">{x.title}</span></span></span>
			</button>
			<div class="acts">
				{#if n.current}
					<button class="more" class:on={menuId === x.id} onpointerenter={(e) => hoverMenu(e, { kind: "session", x })} onpointerleave={leaveMenu} onclick={(e) => clickMenu(e, { kind: "session", x })} aria-label={t("더 보기")} aria-haspopup="menu" aria-expanded={menuId === x.id}><Icon name="more" /></button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet termRow(n: Node, x: TerminalInfo, drop: DropOpts, member = false)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="item nested term"
		class:member
		class:active={n.current && x.id === app.activeId}
		class:over={dropOn === x.id}
		class:before={tabDrop?.id === x.id && !tabDrop.after}
		class:after={tabDrop?.id === x.id && tabDrop.after}
		class:grabbable={n.current && editing !== x.id}
		class:menuopen={menuId === x.id}
		use:dragSource={{ id: x.id, disabled: !n.current || editing === x.id }}
		use:dropTarget={drop}
	>
		{#if member}<span class="branch" aria-hidden="true"></span>{/if}
		{#if n.current && editing === x.id}
			<input
				class="rename"
				bind:value={draft}
				use:focusSelect
				onblur={commitRename}
				onkeydown={(e) => {
					if (e.key === "Enter") commitRename();
					if (e.key === "Escape") editing = null;
				}}
			/>
		{:else}
			<button class="open wide" onclick={() => app.openIn(n.server.id, { session: x.id })} ondblclick={() => n.current && startRename(x.id, x.title)} title={`${x.shell}\n${x.cwd}`}>
				<span class="lead"><Icon name="terminal" /></span>
				<span class="title" use:marquee={x.title}><span class="track"><span class="mq">{x.title}</span><span class="dup" aria-hidden="true">{x.title}</span></span></span>
			</button>
			<div class="acts">
				{#if n.current}
					<button class="more" class:on={menuId === x.id} onpointerenter={(e) => hoverMenu(e, { kind: "terminal", x })} onpointerleave={leaveMenu} onclick={(e) => clickMenu(e, { kind: "terminal", x })} aria-label={t("더 보기")} aria-haspopup="menu" aria-expanded={menuId === x.id}><Icon name="more" /></button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<aside class="side">
	<div class="brandrow">
		<PipayaMark color size={26} />
		<Wordmark size={16} />
		<button class="iconbtn foldbtn" onclick={() => app.sidebar.toggleCollapsed()} aria-label={t("사이드바 접기")} title={t("사이드바 접기") + hint}><Icon name="sidebar" /></button>
	</div>
	<div class="tools">
		<div class="searchwrap">
			<Icon name="search" />
			<input class="search" data-sidebar-search placeholder={t("대화 검색")} bind:value={query} />
		</div>
	</div>

	<nav class="list" use:slidingIndicator={{ selector: ".item.active", radius: "var(--radius-sm)" }} onscroll={() => rowMenu?.close()}>
		{#each nodes as n (n.server.id)}
			{@const sfold = isFolded(n.server.id)}
			<section class="srv" class:cur={n.current}>
				<div class="srvhead">
					<button class="srvtoggle" onclick={() => app.sidebar.toggleFolded(n.server.id)} aria-expanded={!sfold} title={n.root ? `${n.server.baseUrl}\n${n.root}` : n.server.baseUrl}>
						<span class="chev" class:folded={sfold}><Icon name="chevron-down" /></span>
						<span class="sdot {n.state}"></span>
						<span class="sname">{app.serverLabel(n.server)}</span>
						{#if sfold}<span class="dcount mono">{n.state === "online" || n.loaded ? n.total : ""}</span>{/if}
					</button>
					<button class="dirnew" class:on={menuId === `new\u0000${n.server.id}`} data-menu-button onpointerenter={(e) => hoverNew(e, n, ".", n.server.id)} onpointerleave={leaveMenu} onclick={(e) => clickNew(e, n, ".", n.server.id)} aria-label={t("{name}에서 새로 만들기", { name: app.serverLabel(n.server) })} aria-haspopup="menu" title={t("이 서버에서 새 대화 또는 터미널")}><Icon name="plus" /></button>
				</div>

				{#if !sfold}
				<div class="fold" in:collapseIn out:collapseOut>
					{#if n.state === "offline" || n.state === "unauthorized" || n.state === "incompatible"}
						<div class="nosess warnline">{t(statusText[n.state])}{n.loaded ? ` · ${t("마지막으로 확인된 목록")}` : ""}</div>
					{/if}
					{#if !n.loaded && n.state !== "offline" && n.state !== "unauthorized" && n.state !== "incompatible"}
						<div class="sk skeleton-bar"></div>
					{:else if n.total === 0}
						{#if !(n.state === "offline" || n.state === "unauthorized" || n.state === "incompatible") || n.loaded}
							<div class="nosess">{searching ? t("검색 결과 없음") : t("활성 대화 없음")}</div>
						{/if}
					{/if}

					{#each n.dirs as d (d.path)}
						{@const dfold = isFolded(dirKey(n.server.id, d.path))}
						{@const label = shortName(n, d.path)}
						{@const parent = pretty(n, d.path)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="dirblock" data-block={bid("dir", d.path)} data-server={n.server.id} class:carried={dirDrag === bid("dir", d.path)} class:before={dirDrop?.id === bid("dir", d.path) && !dirDrop.after && dirDrag !== bid("dir", d.path)} class:after={dirDrop?.id === bid("dir", d.path) && dirDrop.after && dirDrag !== bid("dir", d.path)}>
						<div class="dir grabbable" class:cur={n.current && d.path === (app.activeTab?.dir.path ?? app.workdirAbs)} class:over={dropOn === dirKey(n.server.id, d.path)} use:dropTarget={{ accepts: (id) => n.current && !!app.groupOf(id), hover: hover(dirKey(n.server.id, d.path)), drop: dropOnDir }} use:dirSource={{ kind: "dir", serverId: n.server.id, path: d.path, paths: n.dirs.map((x) => x.path), disabled: searching || n.dirs.length < 2 }}>
							<button class="dirtoggle" onclick={() => app.sidebar.toggleFolded(dirKey(n.server.id, d.path))} aria-expanded={!dfold} title={pretty(n, d.path)}>
								<span class="chev" class:folded={dfold}><Icon name="chevron-down" /></span>
								<span class="dicon"><Icon name="folder" /></span>
								<span class="dlabel">
									<span class="dname">{label}</span>
									{#if parent}<span class="dparent mono" use:tail={parent}></span>{/if}
								</span>
								{#if dfold}<span class="dcount mono">{d.tabs.length}</span>{/if}
							</button>
							<button class="dirnew" class:on={menuId === `new\u0000${dirKey(n.server.id, d.path)}`} data-menu-button onpointerenter={(e) => hoverNew(e, n, asWorkdir(n, d.path), dirKey(n.server.id, d.path))} onpointerleave={leaveMenu} onclick={(e) => clickNew(e, n, asWorkdir(n, d.path), dirKey(n.server.id, d.path))} aria-label={t("{name}에서 새로 만들기", { name: pretty(n, d.path) })} aria-haspopup="menu" title={t("이 디렉터리에서 새 대화 또는 터미널")}><Icon name="plus" /></button>
						</div>
						{#if !dfold}
							<div class="fold" in:collapseIn out:collapseOut>
								{#each d.tabs as tab (tab.id)}
									{@const drop = { accepts: (id: string) => n.current && id !== tab.id, hover: tabHover(d, tab), drop: tabDropAt(n, d, tab) }}
									{#if tab.kind === "session"}
										{@render row(n, tab.session, drop)}
									{:else if tab.kind === "terminal"}
										{@render termRow(n, tab.terminal, drop)}
									{:else}
										{@const g = tab.group}
										{@const gfold = isFolded(`group\u0000${g.id}`)}
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div class="grp" class:over={dropOn === g.id}>
											<!-- a split tab is a tab row like the others (book that opens/closes, name, then the menu); the panes hang under it on a tree line -->
											<div
												class="item nested grprow"
												class:grabbable={n.current && editingGroup !== g.id}
												class:cur={n.current && g.id === app.activeGroup?.id}
												class:menuopen={menuId === g.id}
												class:before={tabDrop?.id === g.id && !tabDrop.after}
												class:after={tabDrop?.id === g.id && tabDrop.after}
												use:dragSource={{ id: g.id, disabled: !n.current || editingGroup === g.id }}
												use:dropTarget={drop}
											>
												{#if n.current && editingGroup === g.id}
													<input
														class="rename"
														bind:value={groupDraft}
														use:focusSelect
														maxlength="100"
														onblur={commitGroupRename}
														onkeydown={(e) => {
															if (e.key === "Enter") commitGroupRename();
															if (e.key === "Escape") editingGroup = null;
														}}
													/>
												{:else}
													<button class="gfold" onclick={() => app.sidebar.toggleFolded(`group\u0000${g.id}`)} aria-expanded={!gfold} aria-label={gfold ? t("펼치기") : t("접기")} title={gfold ? t("펼치기") : t("접기")}>
														<Icon name={gfold ? "group" : "group-open"} />
													</button>
													<button class="open wide" onclick={() => (n.current ? app.openTab(g.id) : app.openIn(n.server.id, { session: tab.members[0]!.id }))} ondblclick={() => n.current && startGroupRename(g)} title={t("{name} · 더블 클릭으로 이름 바꾸기", { name: g.name })}>
														<span class="title" use:marquee={g.name}><span class="track"><span class="mq">{g.name}</span><span class="dup" aria-hidden="true">{g.name}</span></span></span>
														<span class="gcount mono" title={t("{n}개", { n: tab.members.length })}>{tab.members.length}</span>
													</button>
													<div class="acts">
														{#if n.current}
															<button class="more" class:on={menuId === g.id} onpointerenter={(e) => hoverMenu(e, { kind: "group", g })} onpointerleave={leaveMenu} onclick={(e) => clickMenu(e, { kind: "group", g })} aria-label={t("더 보기")} aria-haspopup="menu" aria-expanded={menuId === g.id}><Icon name="more" /></button>
														{/if}
													</div>
												{/if}
											</div>
											{#if !gfold}
												<div class="members fold" in:collapseIn out:collapseOut>
													{#each tab.members as m (m.id)}
														{#if isTerminalId(m.id)}{@render termRow(n, m as TerminalInfo, memberTarget(n, m), true)}{:else}{@render row(n, m as Session, memberTarget(n, m), true)}{/if}
													{/each}
												</div>
											{/if}
										</div>
									{/if}
								{/each}
							</div>
						{/if}
						</div>
					{/each}
				</div>
				{/if}
			</section>
		{/each}

		{#if nothingFound}<div class="empty">{t("검색 결과가 없습니다")}</div>{/if}
	</nav>

	<div class="bottom">
		<button class="settings wide" onclick={() => app.openSettings()}>
			<Icon name="settings" /> {t("설정")}
			{#if app.net !== "online"}<span class="settingsdot"><StatusDot tone="warn" /></span>{/if}
		</button>
	</div>
</aside>

<RowMenu bind:this={rowMenu} bind:open={menuId} />

<style>
	/* @name of a pane in a split tab: how the other panes call it, so it stays in view there */
	.who {
		flex: none;
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--text-faint);
	}
	.who.working { color: var(--info); }
	.who.asking { color: var(--warn); }
	.who.done { color: var(--ok); }
	.who.failed { color: var(--danger); }
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
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.foldbtn {
		margin-left: auto;
		margin-right: -9.5px; /* the 19px icon's right edge sits on the 16px gutter, like the server chevron below */
	}
	/* 38px in a 44px row: an outer ring would run into the window's top edge, so it is drawn inside */
	.foldbtn:focus-visible {
		outline-offset: -2px;
	}
	.forkmark {
		display: grid;
		flex: none;
		color: var(--text-faint);
	}
	.forkmark :global(svg) {
		width: 13px;
		height: 13px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	@media (min-width: 861px) {
		.side {
			width: var(--sidebar-w); /* the wrapper animates its width; the content must not reflow */
		}
	}
	.searchwrap {
		position: relative;
		flex: 1;
		min-width: 0;
	}
	.searchwrap :global(svg) {
		position: absolute;
		left: 11px;
		top: 50%;
		translate: 0 -50%;
		width: 16px;
		height: 16px;
		stroke: var(--text-faint);
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		pointer-events: none;
	}
	.search {
		width: 100%;
		height: 34px;
		padding: 0 10px 0 32px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: transparent;
		outline: 0;
		font-size: var(--fs-lg);
	}
	.search:focus {
		border-color: var(--accent);
	}
	.list {
		position: relative;
		flex: 1;
		overflow-y: auto;
		padding: 4px 8px 12px;
		overscroll-behavior: contain;
	}
	.srv {
		padding-bottom: 8px;
	}
	.srv + .srv {
		margin-top: 4px;
		padding-top: 4px;
		border-top: 1px solid var(--border);
	}
	/* several servers: the folders hang under their server: the folder icon sits under its status dot and the name under the server name; the right edge stays put, so every "+" keeps one column */
	.srv > .fold {
		padding-left: 6px;
	}
	.srvhead {
		display: flex;
		align-items: center;
		margin-top: 4px;
		border-radius: var(--radius-sm);
	}
	.srvhead:hover {
		background: var(--bg-hover);
	}
	.srvtoggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 6px 0 8px;
		text-align: left;
		color: var(--text-dim);
	}
	.srv.cur .srvtoggle {
		color: var(--text);
	}
	.srvtoggle .sdot {
		margin-right: 4px; /* server name starts at x=58, the same column as directory names */
	}
	.sname {
		flex: 1;
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
	.dir {
		display: flex;
		align-items: center;
		margin-top: 12px;
		border-radius: var(--radius-sm);
	}
	.dirblock:first-child > .dir {
		margin-top: 4px;
	}
	.dir.grabbable {
		cursor: grab;
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
	}
	.dirblock {
		position: relative;
	}
	.dirblock.carried {
		opacity: 0.45;
	}
	.dirblock.before::before,
	.dirblock.after::after {
		content: "";
		position: absolute;
		left: 0;
		right: 0;
		height: 2px;
		border-radius: 1px;
		background: var(--accent);
		z-index: 1;
		pointer-events: none;
	}
	.dirblock.before::before {
		top: -1px;
	}
	.dirblock.after::after {
		bottom: -1px;
	}
	.dirtoggle {
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
	.dir:hover .dirtoggle,
	.dir.cur .dirtoggle {
		color: var(--text);
	}
	.dicon {
		display: grid;
		flex: none;
		width: 14px;
		color: var(--text-faint);
	}
	.dicon :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	/* name and parent path share one baseline; the pair is centred on the icons (line-height 1 drops the uneven leading) */
	.dlabel {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 6px;
		line-height: 1;
		padding-bottom: 1px; /* lowercase sits low in its box: lift it onto the icons' centre */
	}
	/* where the folder sits, dim after its name; the full path is the tooltip */
	.dparent {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
	}
	.chev {
		display: grid;
		flex: none;
		transition: rotate var(--motion-fast) var(--ease);
	}
	.chev.folded {
		rotate: -90deg;
	}
	.chev :global(svg) {
		width: 14px;
		height: 14px;
		stroke: var(--text-faint);
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.dname {
		flex: none;
		max-width: 70%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		font-weight: 600;
	}
	.dcount,
	.dcount:empty {
		display: none;
	}
	.dirnew {
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
	.dir:hover .dirnew,
	.srvhead:hover .dirnew,
	.dirnew:focus-visible {
		opacity: 1;
	}
	@media (pointer: coarse) {
		.dirnew {
			opacity: 1;
		}
	}
	.dirnew:hover,
	.dirnew.on {
		background: var(--bg-active);
		color: var(--text);
		opacity: 1;
	}
	/* one lead column: the model's logo, or the terminal / split icon */
	.lead {
		display: grid;
		place-items: center;
		flex: none;
		width: 16px;
		height: 16px;
		color: var(--text-faint);
	}
	/* only the line icons (terminal, split tab): a model logo keeps its own fill and colours */
	.lead > :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.dirnew :global(svg) {
		width: 15px;
		height: 15px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
	}
	.nosess {
		padding: 4px 10px 6px 44px;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.item {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: var(--radius-sm);
		margin: 0;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.item.nested .open {
		padding-left: 43px; /* one step in: the tab's icon sits under the folder's name */
	}
	.item:hover {
		background: var(--bg-hover);
	}
	.item.active {
		background: var(--bg-active);
	}
	/* the sliding marker draws the selection; the row itself stays clear so the two never double up */
	.list:global([data-indicator-ready]) .item.active {
		background: transparent;
	}
	.item.active .title {
		font-weight: 600;
	}
	.open {
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
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
	}
	/* a title that does not fit flows by while the row is hovered or focused, looping back to its start */
	.title .track {
		display: inline;
	}
	.title .dup {
		display: none;
	}
	@media (hover: hover) {
		.item:hover .title:global([data-over]),
		.item:focus-within .title:global([data-over]) {
			text-overflow: clip;
			-webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
			mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
		}
		.item:hover .title:global([data-over]) .track,
		.item:focus-within .title:global([data-over]) .track {
			display: flex;
			width: max-content;
			animation: mq var(--mq-d, 8s) linear infinite;
		}
		.item:hover .title:global([data-over]) .mq,
		.item:focus-within .title:global([data-over]) .mq,
		.item:hover .title:global([data-over]) .dup,
		.item:focus-within .title:global([data-over]) .dup {
			display: block;
			flex: none;
			padding-right: 32px;
		}
	}
	/* touch has no hover, so the open session's long title flows by on its own; on desktop only hover/focus (above) does */
	@media (hover: none) {
		.item.active .title:global([data-over]) {
			text-overflow: clip;
			-webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
			mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
		}
		.item.active .title:global([data-over]) .track {
			display: flex;
			width: max-content;
			animation: mq var(--mq-d, 8s) linear infinite;
		}
		.item.active .title:global([data-over]) .mq,
		.item.active .title:global([data-over]) .dup {
			display: block;
			flex: none;
			padding-right: 32px;
		}
	}
	@keyframes mq {
		from {
			translate: 0;
		}
		to {
			translate: -50%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.item .title:global([data-over]) .track {
			animation: none !important;
		}
	}
	.acts {
		display: none;
	}
	.item:hover .acts,
	.item:focus-within .acts,
	.item.menuopen .acts {
		display: flex;
	}
	@media (pointer: coarse) {
		.acts {
			display: flex;
		}
		.item:not(.active):not(.cur):not(.menuopen) .acts {
			display: none;
		}
	}
	/* the three dots: same box and right edge as the + on the directory row above */
	.more {
		display: grid;
		place-items: center;
		flex: none;
		width: 28px;
		height: 28px;
		margin-right: 2px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	.more:hover,
	.more.on,
	.more:focus-visible {
		background: var(--bg-active);
		color: var(--text);
	}
	.more :global(svg) {
		width: 15px;
		height: 15px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2.6;
		stroke-linecap: round;
	}
	.rename {
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
	@keyframes blink {
		50% {
			opacity: 0.25;
		}
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
	.settingsdot {
		margin-left: auto;
	}
	/* hairline between workspaces / groups */

	/* A split tab and its panes read as one tree: the book row on top, its panes hanging off a line under the book. */
	.grp {
		margin: 2px 0; /* full width like the other tabs, so the book sits where their icons do */
		border-radius: var(--radius-sm);
	}
	.grp .item.nested .open {
		padding-left: 6px;
	}
	.grp .item.member .open {
		padding-left: 70px; /* the pane's icon, just past the elbow */
		min-height: 30px;
	}
	.grp .item.member .title {
		color: var(--text-dim);
	}
	.grp .item.member.active .title {
		color: var(--text);
	}
	/* tree line: a rule down from the book's centre; each pane gets a short rounded elbow (the last one ends the rule) */
	.branch {
		position: absolute;
		left: 50px; /* the book's centre */
		top: 0;
		bottom: 0;
		width: 12px;
		pointer-events: none;
	}
	.branch::before {
		content: "";
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		border-left: 1.5px solid var(--border-strong, var(--border));
	}
	.branch::after {
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
	.members .item:last-child .branch::before {
		bottom: calc(50% + 8px);
	}
	.grprow.cur .title {
		font-weight: 600;
	}
	.gfold {
		flex: none;
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		margin-left: 43px; /* same left edge as the lead icon of the tabs above */
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	.gfold :global(svg) {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.gfold:hover {
		background: var(--bg-active);
		color: var(--text);
	}
	.grp.over {
		background: var(--accent-soft);
	}
	.dir.over {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	/* the line where a carried session would land among its siblings */
	.item.before::before,
	.item.after::after {
		content: "";
		position: absolute;
		left: 8px;
		right: 8px;
		height: 2px;
		border-radius: 1px;
		background: var(--accent);
		z-index: 1;
		pointer-events: none;
	}
	.item.before::before {
		top: -1px;
	}
	.item.after::after {
		bottom: -1px;
	}
	/* the row being pulled onto: pairs up with whatever is dropped */
	.item.over {
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 1.5px var(--accent);
	}
	.item.grabbable {
		cursor: grab;
		-webkit-tap-highlight-color: transparent;
	}
	@media (max-width: 860px) {
		.foldbtn {
			display: none;
		}
	}
</style>
