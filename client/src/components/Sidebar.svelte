<script lang="ts">
	import StatusDot from "./StatusDot.svelte";
	import { msg, t } from "../lib/i18n";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { formatCombo } from "../lib/keys";
	import Icon from "./Icon.svelte";
	import RowMenu, { type RowMenuItem } from "./RowMenu.svelte";
	import { marquee, tail } from "../lib/fit-text";
	import PipayaLogo from "./PipayaLogo.svelte";
	import Wordmark from "./Wordmark.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import { activityOf, type Activity } from "../lib/activity";
	import { app, type Server } from "../lib/store.svelte";
	import { hostOf, tilde } from "../lib/format";
	import { dragSource, dropTarget } from "../lib/dnd.svelte";
	import { sidebarBlocks, type DirBlock, type GroupBlock } from "../lib/nav";
	import type { Group, Session, WorkspaceInfo } from "../lib/types";
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
		state: "online" | "offline" | "unauthorized" | "checking";
		loaded: boolean;
		root: string | undefined;
		home: string | undefined;
		total: number;
		dirs: DirBlock[];
		groups: GroupBlock[];
	}

	/** Everything shown comes from the servers themselves: their session lists and workspace roots. */
	function build(sessions: Session[], groups: Group[], ws: WorkspaceInfo | null, q: string, order: string[] | undefined, gorder: string[] | undefined): Pick<Node, "root" | "total" | "dirs" | "groups"> {
		const { groups: all, dirs } = sidebarBlocks(
			sessions,
			groups,
			(x) => !q || x.title.toLowerCase().includes(q),
			(g) => !!q && g.name.toLowerCase().includes(q),
			order,
			gorder,
		);
		const blocks = all.filter((b) => b.sessions.length || !q);
		const total = dirs.reduce((n, d) => n + d.sessions.length, 0) + blocks.reduce((n, b) => n + b.sessions.length, 0);
		return { root: ws?.root, total, dirs, groups: blocks };
	}
	/** `~/workspace/x` for display; each server has its own home */
	const pretty = (n: Node, path: string) => tilde(path, n.home);

	const nodes = $derived.by<Node[]>(() => {
		const q = query.trim().toLowerCase();
		return app.servers.map((server) => {
			const current = server.id === app.serverId;
			const ov = app.overview[server.id];
			const state = current
				? app.net === "online"
					? "online"
					: app.net === "unauthorized"
						? "unauthorized"
						: app.net === "connecting"
							? "checking"
							: "offline"
				: ((app.status[server.id] ?? "checking") as Node["state"]);
			const ws = current ? app.workspace : (ov?.workspace ?? null);
			const data = build(current ? app.sessions : (ov?.sessions ?? []), current ? app.groups : (ov?.groups ?? []), ws, q, app.sidebar.dirOrder[server.id], app.sidebar.groupOrder[server.id]);
			return { server, current, state, loaded: current ? app.sessionsLoaded : Boolean(ov), home: ws?.home, ...data };
		});
	});

	const searching = $derived(query.trim().length > 0);
	const nothingFound = $derived(searching && nodes.every((n) => n.total === 0));
	/** Activity of a session on the open server (other servers only report what their session list carries). */
	const stateOf = (n: Node, x: Session): Activity => (n.current ? activityOf(app, x.id) : "idle");

	const statusText = { online: "", offline: msg("연결 안 됨"), unauthorized: msg("토큰 거부됨"), checking: msg("확인 중") };

	const dirKey = (id: string, path: string) => `${id}\u0000${path}`;
	const isFolded = (key: string) => !searching && app.sidebar.folded.includes(key);

	/* The other servers are read from the servers themselves, and kept fresh while the sidebar is in use. */
	$effect(() => {
		void app.servers.length;
		void app.serverId;
		void app.refreshOverview();
		const t = setInterval(() => !document.hidden && void app.refreshOverview(), 15_000);
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
		if (editing && draft.trim()) void app.rename(editing, draft);
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
	function chooseGroup(x: Session) {
		const own = app.groupOf(x.id);
		app.palette = {
			title: t("'{title}'와 묶기", { title: x.title }),
			empty: msg("묶을 다른 대화가 없습니다"),
			items: app.sessions
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
	/** Let go on a group: join it. */
	const dropOnGroup = (groupId: string) => (id: string) => void app.addToGroup(id, groupId);
	/** Let go on a session: they become a group right there (or it joins that session's group). */
	const dropOnSession = (other: string) => (id: string) => void app.groupWith(id, other);
	/* ---- reordering directories / groups by dragging their header ---- */
	/** the block being carried (`kind:key`), and the one of the same kind it would land next to */
	let dirDrag = $state<string | null>(null);
	let dirDrop = $state<{ id: string; after: boolean } | null>(null);
	const bid = (kind: "dir" | "group", key: string) => `${kind}:${key}`;
	interface DirSrc {
		kind: "dir" | "group";
		serverId: string;
		path: string;
		paths: string[];
		disabled: boolean;
	}
	function dirSource(node: HTMLElement, initial: DirSrc) {
		let o = initial;
		let st: { pid: number; touch: boolean; x: number; y: number; timer: number } | null = null;
		let active = false;
		const at = (x: number, y: number) => {
			const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-block]");
			if (!el || el.dataset.server !== o.serverId || !el.dataset.block!.startsWith(`${o.kind}:`)) return null;
			const r = el.getBoundingClientRect();
			return { id: el.dataset.block!, after: y > r.top + r.height / 2 };
		};
		const activate = () => {
			if (!st || active) return;
			active = true;
			clearTimeout(st.timer);
			navigator.vibrate?.(12);
			dirDrag = bid(o.kind, o.path);
			document.documentElement.classList.add("dnd");
		};
		function down(e: PointerEvent) {
			if (o.disabled || st || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0) || (e.target as Element).closest(".dirnew, .more, input")) return;
			st = { pid: e.pointerId, touch: e.pointerType === "touch", x: e.clientX, y: e.clientY, timer: 0 };
			if (st.touch) st.timer = window.setTimeout(activate, 380);
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", cancel);
			window.addEventListener("touchmove", block, { passive: false });
			window.addEventListener("keydown", key);
		}
		function move(e: PointerEvent) {
			if (!st || e.pointerId !== st.pid) return;
			if (!active) {
				if (Math.hypot(e.clientX - st.x, e.clientY - st.y) <= (st.touch ? 10 : 5)) return;
				if (st.touch) return cleanup(); // scrolling, not dragging
				activate();
			}
			dirDrop = at(e.clientX, e.clientY);
			// near the edge of the list: scroll it
			const list = node.closest<HTMLElement>(".list");
			if (list) {
				const r = list.getBoundingClientRect();
				if (e.clientY < r.top + 40) list.scrollTop -= 12;
				else if (e.clientY > r.bottom - 40) list.scrollTop += 12;
			}
		}
		function up(e: PointerEvent) {
			if (!st || e.pointerId !== st.pid) return;
			if (active) {
				const d = dirDrop;
				if (d) {
					const target = d.id.slice(o.kind.length + 1);
					if (o.kind === "dir") app.sidebar.moveDir(o.serverId, o.paths, o.path, target, d.after);
					else app.sidebar.moveGroup(o.serverId, o.paths, o.path, target, d.after);
				}
				const stop = (ev: Event) => (ev.stopPropagation(), ev.preventDefault());
				window.addEventListener("click", stop, { capture: true, once: true });
				setTimeout(() => window.removeEventListener("click", stop, true), 120);
			}
			cleanup();
		}
		function cancel(e: PointerEvent) {
			if (st && e.pointerId === st.pid) cleanup();
		}
		function block(e: TouchEvent) {
			if (active && e.cancelable) e.preventDefault();
		}
		function key(e: KeyboardEvent) {
			if (e.key === "Escape" && active) cleanup();
		}
		function cleanup() {
			if (st) clearTimeout(st.timer);
			if (active) document.documentElement.classList.remove("dnd");
			st = null;
			active = false;
			dirDrag = null;
			dirDrop = null;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("touchmove", block);
			window.removeEventListener("keydown", key);
		}
		node.addEventListener("pointerdown", down);
		return {
			update: (next: DirSrc) => (o = next),
			destroy() {
				node.removeEventListener("pointerdown", down);
				cleanup();
			},
		};
	}
	/** Let go on a folder: the session steps out of its group. */
	const dropOnDir = (id: string) => void app.leaveGroup(id);
	function newIn(n: Node, path: string) {
		app.openIn(n.server.id, { workdir: path });
	}
	/** The workdir value `openIn` expects: "." for the server default, else the absolute path */
	const asWorkdir = (n: Node, path: string) => (path === n.root ? "." : path);

	type MenuTarget = { kind: "session"; x: Session } | { kind: "group"; g: Group };
	/** Items of a row's "more" menu. */
	function menuItems(target: MenuTarget): RowMenuItem[] {
		if (target.kind === "group") {
			const g = target.g;
			return [
				{ icon: "pencil", label: t("그룹 이름 바꾸기"), title: "", run: () => startGroupRename(g) },
				{ icon: "unlink", label: t("그룹 해제"), title: t("그룹 해제 (대화는 그대로 남습니다)"), run: () => void app.deleteGroup(g.id) },
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
	const targetId = (target: MenuTarget) => (target.kind === "session" ? target.x.id : target.g.id);
	const hoverMenu = (e: PointerEvent, target: MenuTarget) => rowMenu?.hover(e, targetId(target), menuItems(target));
	const leaveMenu = (e: PointerEvent) => rowMenu?.leave(e);
	const clickMenu = (e: MouseEvent, target: MenuTarget) => rowMenu?.click(e, targetId(target), menuItems(target));
</script>


{#snippet row(n: Node, x: Session, nested: boolean)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="item"
		class:nested
		class:active={n.current && x.id === app.activeId}
		class:over={dropOn === x.id}
		class:grabbable={n.current && editing !== x.id}
		class:menuopen={menuId === x.id}
		use:dragSource={{ id: x.id, disabled: !n.current || editing === x.id }}
		use:dropTarget={{ accepts: (id) => n.current && id !== x.id, hover: hover(x.id), drop: dropOnSession(x.id) }}
	>
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
			<button class="open wide" onclick={() => app.openIn(n.server.id, { session: x.id })} ondblclick={() => n.current && startRename(x.id, x.title)}>
				<AgentBadge id={x.id} state={stateOf(n, x)} size={18} />
				{#if x.parentId}<span class="forkmark" title={t("분기된 대화")}><Icon name="fork" /></span>{/if}
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

<aside class="side">
	<div class="brandrow">
		<PipayaLogo size={26} />
		<Wordmark size={16} />
		<button class="iconbtn fold" onclick={() => app.sidebar.toggleCollapsed()} aria-label={t("사이드바 접기")} title={t("사이드바 접기") + hint}><Icon name="sidebar" /></button>
	</div>
	<div class="tools">
		<div class="searchwrap">
			<Icon name="search" />
			<input class="search" data-sidebar-search placeholder={t("대화 검색")} bind:value={query} />
		</div>
		<button class="newbtn" onclick={() => app.newChat()} aria-label={t("새 대화")} title={t("새 대화")}><Icon name="plus" /></button>
	</div>

	<nav class="list" use:slidingIndicator={{ selector: ".item.active" }} onscroll={() => rowMenu?.close()}>
		{#each nodes as n (n.server.id)}
			{@const sfold = isFolded(n.server.id)}
			<section class="srv" class:cur={n.current}>
				<div class="srvhead">
					<button class="srvtoggle" onclick={() => app.sidebar.toggleFolded(n.server.id)} aria-expanded={!sfold} title={n.root ? `${n.server.baseUrl}\n${n.root}` : n.server.baseUrl}>
						<span class="chev" class:folded={sfold}><Icon name="chevron-down" /></span>
						<span class="sdot {n.state}"></span>
						<span class="sname">{app.serverLabel(n.server)}</span>
						<span class="dcount mono">{n.state === "online" || n.loaded ? n.total : ""}</span>
					</button>
					<button class="dirnew" onclick={() => newIn(n, n.current ? app.workdir : ".")} aria-label={t("{name}에서 새 대화", { name: app.serverLabel(n.server) })} title={t("이 서버에서 새 대화")}><Icon name="plus" /></button>
				</div>

				{#if !sfold}
					{#if n.state === "offline" || n.state === "unauthorized"}
						<div class="nosess warnline">{t(statusText[n.state])}{n.loaded ? ` · ${t("마지막으로 확인된 목록")}` : ""}</div>
					{/if}
					{#if !n.loaded && n.state !== "offline" && n.state !== "unauthorized"}
						<div class="sk skeleton-bar"></div>
					{:else if n.total === 0}
						{#if !(n.state === "offline" || n.state === "unauthorized") || n.loaded}
							<div class="nosess">{searching ? t("검색 결과 없음") : t("활성 대화 없음")}</div>
						{/if}
					{/if}

					{#each n.dirs as d (d.path)}
						{@const dfold = isFolded(dirKey(n.server.id, d.path))}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="dirblock" data-block={bid("dir", d.path)} data-server={n.server.id} class:carried={dirDrag === bid("dir", d.path)} class:before={dirDrop?.id === bid("dir", d.path) && !dirDrop.after && dirDrag !== bid("dir", d.path)} class:after={dirDrop?.id === bid("dir", d.path) && dirDrop.after && dirDrag !== bid("dir", d.path)}>
						<div class="dir grabbable" class:cur={n.current && d.path === app.workdirAbs} class:over={dropOn === dirKey(n.server.id, d.path)} use:dropTarget={{ accepts: (id) => n.current && !!app.groupOf(id), hover: hover(dirKey(n.server.id, d.path)), drop: dropOnDir }} use:dirSource={{ kind: "dir", serverId: n.server.id, path: d.path, paths: n.dirs.map((x) => x.path), disabled: searching || n.dirs.length < 2 }}>
							<button class="dirtoggle" onclick={() => app.sidebar.toggleFolded(dirKey(n.server.id, d.path))} aria-expanded={!dfold} title={d.path}>
								<span class="chev" class:folded={dfold}><Icon name="chevron-down" /></span>
								<span class="dname mono" use:tail={pretty(n, d.path)}></span>
								<span class="dcount mono">{d.sessions.length}</span>
							</button>
							<button class="dirnew" onclick={() => newIn(n, asWorkdir(n, d.path))} aria-label={t("{name}에서 새 대화", { name: pretty(n, d.path) })} title={t("이 디렉터리에서 새 대화")}><Icon name="plus" /></button>
						</div>
						{#if !dfold}
							{#each d.sessions as x (x.id)}{@render row(n, x, true)}{/each}
						{/if}
						</div>
					{/each}

					{#each n.groups as b (b.group.id)}
						{@const gfold = isFolded(`group\u0000${b.group.id}`)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="grp dirblock" data-block={bid("group", b.group.id)} data-server={n.server.id} class:carried={dirDrag === bid("group", b.group.id)} class:before={dirDrop?.id === bid("group", b.group.id) && !dirDrop.after && dirDrag !== bid("group", b.group.id)} class:after={dirDrop?.id === bid("group", b.group.id) && dirDrop.after && dirDrag !== bid("group", b.group.id)} class:over={dropOn === b.group.id} use:dropTarget={{ accepts: () => n.current, hover: hover(b.group.id), drop: dropOnGroup(b.group.id) }}>
							<div class="grphead grabbable" class:cur={n.current && b.group.id === app.activeGroup?.id} class:menuopen={menuId === b.group.id} use:dirSource={{ kind: "group", serverId: n.server.id, path: b.group.id, paths: n.groups.map((x) => x.group.id), disabled: searching || n.groups.length < 2 || editingGroup === b.group.id }}>
								{#if n.current && editingGroup === b.group.id}
									<input
										class="rename grpname"
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
									<button class="grptoggle" onclick={() => app.sidebar.toggleFolded(`group\u0000${b.group.id}`)} ondblclick={() => n.current && startGroupRename(b.group)} aria-expanded={!gfold} title={t("{name} · 더블 클릭으로 이름 바꾸기", { name: b.group.name })}>
										<span class="chev" class:folded={gfold}><Icon name="chevron-down" /></span>
										<span class="gicon"><Icon name="columns" /></span>
										<span class="dname">{b.group.name}</span>
										<span class="dcount mono">{b.sessions.length}</span>
									</button>
									{#if n.current}
										<div class="gacts">
											<button class="more" class:on={menuId === b.group.id} onpointerenter={(e) => hoverMenu(e, { kind: "group", g: b.group })} onpointerleave={leaveMenu} onclick={(e) => clickMenu(e, { kind: "group", g: b.group })} aria-label={t("더 보기")} aria-haspopup="menu" aria-expanded={menuId === b.group.id}><Icon name="more" /></button>
										</div>
									{/if}
								{/if}
							</div>
							{#if !gfold}
								{#each b.sessions as x (x.id)}{@render row(n, x, true)}{/each}
							{/if}
						</div>
					{/each}
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
		align-items: center;
		gap: 8px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--border);
	}
	.newbtn {
		flex: none;
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		color: var(--text);
		transition: background var(--motion-fast) var(--ease-std);
	}
	.newbtn:hover {
		background: var(--bg-active);
	}
	.newbtn :global(svg),
	.settings :global(svg) {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.fold {
		margin-left: auto;
		margin-right: -9.5px; /* the 19px icon's right edge sits on the 16px gutter, like the server chevron below */
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
		padding: 2px 8px 12px;
		overscroll-behavior: contain;
	}
	.srv {
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
		margin: 0 -8px; /* rows span the full width: hairlines run edge to edge like the header's */
		padding-left: 8px;
		padding-right: 8px;
	}
	.srvhead {
		display: flex;
		align-items: center;
		margin-top: 6px;
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
		height: 34px;
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
		margin-top: 2px;
		border-radius: var(--radius-sm);
	}
	.dir:hover {
		background: var(--bg-hover);
	}
	.dir.grabbable,
	.grphead.grabbable {
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
		padding: 0 6px 0 30px; /* level 1: chevron under the server dot (x=38) */
		text-align: left;
		color: var(--text-dim);
	}
	.dir.cur .dirtoggle {
		color: var(--text);
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
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;

		font-size: var(--fs-xs);
		font-weight: 600;
	}
	.dcount {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
	}
	.dirnew {
		display: grid;
		place-items: center;
		flex: none;
		width: 28px;
		height: 28px;
		margin-right: 2px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		opacity: 0;
	}
	.dir:hover .dirnew,
	.dir.cur .dirnew,
	.srvhead:hover .dirnew,
	.srv.cur .srvhead .dirnew,
	.dirnew:focus-visible {
		opacity: 1;
	}
	@media (pointer: coarse) {
		.dirnew {
			opacity: 1;
		}
	}
	.dirnew:hover {
		background: var(--bg-active);
		color: var(--text);
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
		padding: 4px 10px 6px 30px;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.item {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: var(--radius);
		margin: 0;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.item.nested .open {
		padding-left: 50px; /* level 2: sessions of a directory sit under its name (x=58) */
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
		gap: 8px;
		min-height: 36px;
		padding: 0 10px 0 30px; /* level 1: the agent face sits under the directory chevrons (x=38) */
		text-align: left;
		outline-offset: -1px;
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-md);
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
		.item:not(.active):not(.menuopen) .acts {
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
	.grp {
		margin-top: 4px;
		border-radius: var(--radius);
		border: 1px solid transparent;
	}
	.grp.over,
	.dir.over {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	/* the row being pulled onto: pairs up with whatever is dropped */
	.item.over {
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 1.5px var(--accent);
	}
	.grphead {
		display: flex;
		align-items: center;
		border-radius: var(--radius-sm);
	}
	.grphead:hover {
		background: var(--bg-hover);
	}
	.grphead.cur .dname {
		color: var(--text);
	}
	.grptoggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		padding: 0 6px 0 30px;
		text-align: left;
		color: var(--text-dim);
	}
	.gicon {
		display: grid;
		flex: none;
	}
	.gicon :global(svg) {
		width: 14px;
		height: 14px;
		stroke: var(--text-dim);
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.grpname {
		margin-left: 26px;
		height: 28px;
		font-size: var(--fs-md);
	}
	.gacts {
		display: none;
		padding-right: 0;
	}
	.grphead:hover .gacts,
	.grphead:focus-within .gacts,
	.grphead.menuopen .gacts {
		display: flex;
	}
	@media (pointer: coarse) {
		.gacts {
			display: flex;
		}
	}
	.item.grabbable {
		cursor: grab;
		-webkit-tap-highlight-color: transparent;
	}
	@media (max-width: 860px) {
		.fold {
			display: none;
		}
	}
</style>
