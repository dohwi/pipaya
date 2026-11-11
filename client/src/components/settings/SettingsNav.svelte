<script lang="ts">
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { treePath } from "../../lib/tree-path";
	import { rovingKeys } from "../../lib/roving";
	import { easeEnter, easeExit, ms } from "../../lib/motion";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { SETTINGS_TABS, needsOnlineServer, type SettingsTabId } from "../../lib/settings-search";
	import { extensionRows, type ExtensionRow } from "../../lib/settings-extension-rows";
	import { initialFolded } from "../../lib/settings-fold";
	import type { Server } from "../../lib/store.svelte";
	import Icon from "../Icon.svelte";
	import Pin from "../Pin.svelte";
	import { extensionUpdates } from "../../lib/extension-updates.svelte";
	import { serverUpdater } from "../../lib/server-update.svelte";

	/**
	 * The column of sections on the left (a row of tabs on a phone). A section with extensions lists them under it as a
	 * small tree; picking one opens it inside that section. `tab` and `extId` are the window's selection and move with
	 * every click, so the pane on the right follows; `dir` is the side the next pane enters from.
	 */
	let {
		tab = $bindable(),
		extId = $bindable(),
		dir = $bindable(),
		installFor = $bindable(null),
		serverName = "",
		server,
		serverOnline = true,
	}: {
		tab: string;
		extId: string | null;
		dir: number;
		/** Set to a client extension id to open its install preview in the 확장 section (the clip of a pair whose client half is missing) */
		installFor?: string | null;
		/** Label above the chosen server's sections, so it is clear which server they belong to */
		serverName?: string;
		server: Server | null;
		/** False while the server does not answer: its sections (all but "정보") are greyed out and cannot be opened. */
		serverOnline?: boolean;
	} = $props();

	type TabId = SettingsTabId;
	const COMMON = SETTINGS_TABS.filter((x) => !x.server);
	const PER_SERVER = SETTINGS_TABS.filter((x) => x.server);
	const order = (id: string) => SETTINGS_TABS.findIndex((x) => x.id === id);
	/** Sections whose extensions the user folded away; "MCP" and "확장" start folded (see `settings-fold`). */
	let collapsed = $state<Record<string, boolean>>(initialFolded());
	/** Extensions running inside the chosen server (read-only); listed under "서버 확장" like installed ones. */
	let serverSide = $state<{ id: string; names: { name: string; title?: string; companion?: string }[] } | null>(null);
	$effect(() => {
		void app.configTick;
		void app.serverExtensionsTick;
		const id = server?.id;
		if (!id) { serverSide = null; return; }
		let live = true;
		app.links[id]?.api.serverExtensions().then((r) => { if (live) serverSide = { id, names: r.extensions.map((x) => ({ name: x.name, title: x.title, ...(x.companion ? { companion: x.companion } : {}) })) }; }).catch(() => { if (live) serverSide = null; });
		return () => { live = false; };
	});
	/** MCP servers of the chosen server, listed under "MCP" the same way (picking one narrows the pane to it). */
	let mcpSide = $state<{ id: string; rows: { name: string; ready: boolean; failed: boolean }[] } | null>(null);
	$effect(() => {
		void app.mcpTick;
		const id = server?.id;
		if (!id) { mcpSide = null; return; }
		let live = true;
		app.links[id]?.api.mcp().then((r) => { if (live) mcpSide = { id, rows: r.servers.map((x) => ({ name: x.name, ready: x.status === "ready", failed: x.status === "error" })) }; }).catch(() => { if (live) mcpSide = null; });
		return () => { live = false; };
	});
	type Kid = ExtensionRow;
	/** The server's own update lives in "정보": its dot there says where the dot on the server chip leads (only the open server is known). */
	const serverHasUpdate = $derived(!!server && server.id === app.serverId && serverUpdater.available);
	const hasUpdate = (id: string) => (id === "info" ? serverHasUpdate : (id === "srvext" ? extensionUpdates.serverCount(server?.id) : 0) > 0);
	const extsOf = (id: string): Kid[] => {
		if (id === "mcp") {
			const rows = mcpSide && mcpSide.id === server?.id ? mcpSide.rows : [];
			return rows.map((m, i) => ({ id: `mcp:${m.name}`, name: m.name, live: m.ready, half: m.failed, halfLabel: t("오류"), builtin: false, end: i === rows.length - 1 }));
		}
		if (id !== "srvext") return [];
		void app.extensionStoreTick;
		const installed = app.clientExtensionsOf(server?.id).map((e) => ({ id: e.id, name: e.name, live: e.live }));
		return extensionRows(installed, serverSide && serverSide.id === server?.id ? serverSide.names : null, {
			clientIds: () => extensionUpdates.clientIds(server?.id),
			serverNames: extensionUpdates.serverNames(server?.id),
			missingServerFor: (cid) => extensionUpdates.missingServerFor(cid, server?.id),
			clientName: (cid) => extensionUpdates.clientName(cid),
		});
	};
	const clipTip = (e: Kid) => (e.half ? e.halfLabel : e.partner ? t("‘{name}’ 확장과 함께 작동합니다.", { name: e.partner }) : t("다른 확장과 함께 작동"));
	function openExt(tabId: TabId, id: string) {
		if (tabId !== tab) { dir = order(tabId) > order(tab) ? 1 : -1; tab = tabId; }
		extId = id;
	}
	function follow(link: { tab: TabId; id: string | null; install?: string }) {
		if (link.install) { go(link.tab); installFor = link.install; }
		else if (link.id) openExt(link.tab, link.id);
		else go(link.tab);
	}
	function go(next: TabId) {
		extId = null;
		if (next === tab) return;
		dir = order(next) > order(tab) ? 1 : -1;
		tab = next;
	}

	/**
	 * Opens or closes a section's tree by its height. Not `slide`: that sets overflow:hidden, which would cut the first row's trunk where it
	 * reaches 10px up into the section row. The clip-path clips only the bottom (and nothing above), so the rows below never show through.
	 */
	function fold(node: HTMLElement, dir: "in" | "out") {
		const h = node.offsetHeight;
		const mb = parseFloat(getComputedStyle(node).marginBottom) || 0;
		return {
			duration: ms(dir === "in" ? "normal" : "fast"),
			easing: dir === "in" ? easeEnter : easeExit,
			css: (t: number) =>
				`height:${(t * h).toFixed(2)}px;margin-bottom:${(t * mb).toFixed(2)}px;opacity:${Math.min(1, t * 1.5).toFixed(3)};clip-path:inset(-16px -16px 0 -16px)`,
		};
	}
</script>

<!-- desktop: a column on the left; phone: a row of tabs above the content -->
<div
	class="nav"
	role="tablist"
	aria-label={t("설정 구역")}
	use:slidingIndicator={{ selector: "button.on", variant: "fill", radius: "var(--radius-control)" }}
	use:rovingKeys={{ item: '[role="tab"]', axis: "both" }}
>
	<div class="glabel" aria-hidden="true">{t("공통")}</div>
	{#each COMMON as x (x.id)}
		{@render item(x)}
	{/each}
	{#if server}
		<div class="gsep" role="separator" aria-orientation="horizontal"></div>
		<div class="glabel" aria-hidden="true" title={serverName}><span>{serverName}</span></div>
		{#each PER_SERVER as x (x.id)}
			{@render item(x)}
		{/each}
	{/if}
</div>

{#snippet item(x: (typeof SETTINGS_TABS)[number])}
			{@const off = !serverOnline && needsOnlineServer(x.id)}
			{@const kids = off ? [] : extsOf(x.id)}
			{@const open = kids.length > 0 && !collapsed[x.id]}
			<div class="row" class:has={kids.length > 0}>
				<button role="tab" class:srvtab={x.server} disabled={off} title={off ? t("서버에 연결되어 있지 않습니다") : x.sub ? t(x.sub) : undefined} aria-selected={tab === x.id && !extId} tabindex={tab === x.id && !extId ? 0 : -1} class:on={tab === x.id && !extId} onclick={() => go(x.id)}>
					<span class="nico"><Icon name={x.icon} />{#if x.id === "models" && server && app.problemsOf(server.id).length}<Pin tone="danger" label={t("설정 문제 {n}", { n: app.problemsOf(server.id).length })} />{:else if hasUpdate(x.id) && !open}<Pin tone="ok" label={x.id === "info" ? t("서버 업데이트 있음") : t("업데이트 있음")} />{/if}</span>
					<span class="nt">
						<span class="nl">{t(x.label)}</span>
					</span>
				</button>
				{#if kids.length}
					<button type="button" class="fold tap" aria-expanded={open} aria-label={open ? t("하위 항목 접기") : t("하위 항목 펼치기")} onclick={() => (collapsed[x.id] = open)}><Icon name="chevron-down" /></button>
					{#if !open}<span class="cbadge" aria-hidden="true">{kids.length}</span>{/if}
				{/if}
			</div>
			{#if open}
				<div class="tree" role="group" aria-label={t(x.label)} in:fold={"in"} out:fold={"out"} use:treePath={{ row: ".item:has(button.sub.on)", lead: 10 }}>
					{#each kids as e (e.id)}
						{@const link = e.link}
						<div class="item" class:end={e.end}>
							<button role="tab" class="sub" class:linked={e.paired && !!link} aria-selected={extId === e.id} tabindex={extId === e.id ? 0 : -1} class:on={extId === e.id} onclick={() => (e.builtin ? go(x.id) : openExt(x.id, e.id))}>
								<span class="dot" class:live={e.live && !e.half} class:half={e.half} role="img" aria-label={e.half ? e.halfLabel : e.live ? t("실행 중") : t("꺼짐")}></span>
								<span class="nl">{e.name}</span>
								{#if e.paired && !link}<span class="clip" class:half={e.half} role="img" aria-label={clipTip(e)} title={clipTip(e)}><Icon name="clip" /></span>{/if}
								{#if e.update}<span class="upmark" role="img" aria-label={t("업데이트 있음")} title={t("업데이트 있음")}><Icon name="arrow-up" /></span>{/if}
							</button>
							{#if e.paired && link}
								<button type="button" class="clip go" class:half={e.half} aria-label={clipTip(e)} title={clipTip(e)} onclick={() => follow(link)}><Icon name="clip" /></button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
{/snippet}

<style>
	.nico {
		position: relative;
		display: inline-flex;
	}
	/* a small muted label over each group; the server's name says which server the sections below belong to */
	.nav .glabel {
		flex: none;
		padding: 0 12px;
		font-size: var(--fs-xs);
		line-height: 20px;
		font-weight: 600;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nav .gsep {
		flex: none;
		height: 1px;
		margin: 8px 4px 4px; /* 4px nav gap + 8 = 12 above the rule, 4 + 4 = 8 below it, before the server's label */
		background: var(--border);
	}
	.nav .upmark {
		margin-left: auto;
		flex: none;
		display: inline-flex;
		color: var(--ok);
		opacity: 0.85;
	}
	.nav .upmark :global(svg) {
		width: 13px;
		height: 13px;
		stroke-width: 2.4;
	}
	.nav .row {
		position: relative;
		display: flex;
	}
	.nav .row > button:first-child {
		flex: 1;
		min-width: 0;
	}
	.nav .row.has > button:first-child {
		padding-right: 60px; /* room for the count and the arrow, so a long label never runs under them */
	}
	/* the row's right end holds [count][arrow]. The arrow is the only control: a 24x24 box around its 14px chevron (5px each side), so the
	   focus ring (the global 2px + 2px offset, as on every other control) is a small square around the glyph and stops 12px short of the
	   count. It sits 7px from the row's edge, which puts the chevron's centre 19px from it (12px of padding, the mirror of the 19px icon's
	   12px on the left) whatever the badge does. `.tap` widens only the touch hit area (an invisible ::after), never the ring. */
	.nav button.fold {
		position: absolute;
		top: calc(50% - 12px);
		right: 7px; /* 7 + 12 = the chevron's centre 19px from the row's edge */
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	/* the count is display only: it neither takes focus nor a click (a click on it falls through to the row's section button). A fixed 20px
	   column like the sidebar's counts, 10px left of the chevron and clear of the focus ring, shown only while folded; the arrow's x does not
	   depend on it */
	.nav .row > .cbadge {
		position: absolute;
		top: calc(50% - 9px); /* the badge is 18px tall: centred on the row */
		right: 36px; /* its 20px column ends 36px from the row's edge (centre 46): 7 + 24 = the button's left edge, + 5 = the ring's outer edge */
		z-index: 1;
		width: 20px;
		min-width: 20px;
		padding: 0 0 2px; /* the shared badge's 1px digit lift, without its side padding: 20px column, as in the sidebar */
		pointer-events: none;
	}
	.nav button.fold :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 2;
		transition: rotate var(--motion-fast) var(--ease-std);
	}
	.nav button.fold[aria-expanded="false"] :global(svg) {
		rotate: -90deg;
	}
	/* every child draws its stretch of a straight trunk (::after) and a short branch curving off it into itself (::before); the last trunk stops at its branch */
	.nav .tree {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0 0 4px 20px; /* the tree line hangs under the item icon's centre */
		padding-left: 16px;
	}
	.nav .item {
		position: relative;
		display: flex;
	}
	.nav button.sub {
		flex: 1;
		min-width: 0;
		height: 32px; /* every row is 32px tall, tree rows too */
		gap: 8px;
		padding: 0 8px;
	}
	.nav button.sub.linked {
		padding-right: 40px; /* room for the 38px unlink button + 2px, so the label never runs under it */
	}
	.nav .item::before,
	.nav .item::after {
		content: "";
		position: absolute;
		/* trunk centre = icon centre: nav 8 + button 12 + glyph 19/2 = 29.5; rows start at 44, so the 1.5px line's left edge is 44 - 15.25 = 28.75 */
		left: -15.25px;
		pointer-events: none;
	}
	.nav .item::after {
		top: -2px;
		bottom: -2px;
		border-left: 1.5px solid var(--tree-line);
	}
	.nav .item:first-child::after {
		top: -10px;
	}
	.nav .item.end::after {
		bottom: calc(50% + 9px);
	}
	.nav .item::before {
		top: calc(50% - 9px);
		width: 15.25px; /* from the trunk to the row's left edge */
		height: 9px;
		border-left: 1.5px solid var(--tree-line);
		border-bottom: 1.5px solid var(--tree-line);
		border-bottom-left-radius: 3px;
	}
	/* the open extension's path: one element from the section down to its branch, one step darker than the quiet trunk. Only its
	   height moves (lib/tree-path), on the selection marker's time and curve, so the two travel together */
	.nav .tree {
		position: relative;
	}
	.nav .tree :global(.tree-path) {
		position: absolute;
		left: 0.75px; /* the trunk's column: the rows' trunks sit 15.25px left of the rows, which start 16px in */
		top: -10px; /* up to the section row, where the first trunk starts */
		z-index: 1; /* above the rows' quiet trunks */
		width: 15.25px;
		height: var(--path-h, 0px); /* already counts the 10px lead above the first row (lib/tree-path) */
		box-sizing: border-box;
		border-left: 1.5px solid var(--text-dim);
		border-bottom: 1.5px solid var(--text-dim);
		border-bottom-left-radius: 3px;
		pointer-events: none;
		transition: height var(--motion-normal) var(--ease), opacity var(--motion-fast) var(--ease-std);
	}
	.nav .tree :global(.tree-path[data-empty]) {
		opacity: 0;
	}
	.nav .clip {
		flex: none;
		display: inline-flex;
		color: var(--text-faint);
	}
	.nav .clip.half {
		color: var(--warn);
	}
	.nav button.clip.go {
		position: absolute;
		top: 50%;
		right: 4px;
		transform: translateY(-50%);
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border-radius: var(--radius-sm);
	}
	.nav button.clip.go:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.nav .clip :global(svg) {
		width: 14px;
		height: 14px;
	}
	.nav button.sub .nl {
		font-size: var(--fs-sm);
		line-height: 20px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nav .dot {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--border-strong);
	}
	.nav .dot.live {
		background: var(--ok);
	}
	.nav .dot.half {
		background: var(--warn);
	}
	.nav {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 4px;
		align-self: stretch;
		padding: 12px 8px;
		border-right: 1px solid var(--border);
		overflow-y: auto;
		scroll-padding-block: 8px;
	}
	.nav button {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 12px;
		height: 32px; /* the sidebar's row height; the description lives in the pane header (and the tooltip), not in the row */
		padding: 0 12px;
		border-radius: var(--radius-control);
		text-align: left;
		color: var(--text-dim);
	}
	.nav button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.nav button:not(:disabled):hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.nav button.on {
		color: var(--text);
	}
	/* the sliding marker draws the selection; the button's own hover fill steps aside */
	.nav:global([data-indicator-ready]) button.on {
		background: none;
	}
	.nav button :global(svg) {
		flex: none;
		width: 19px;
		height: 19px;
		stroke-width: 1.8;
	}
	.nt {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.nl {
		font-size: var(--fs-md);
		line-height: 20px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (max-width: 760px) {
		.nav {
			flex-direction: row;
			padding: 4px 12px;
			border-right: 0;
			border-bottom: 1px solid var(--border);
			overflow-x: auto;
			overflow-y: hidden;
			scrollbar-width: none;
			overscroll-behavior-x: contain;
			scroll-padding-inline: 12px;
			gap: 4px;
			/* fade the edges so it reads as a scrollable row */
			mask-image: linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 28px), transparent 100%);
		}
		.nav::-webkit-scrollbar {
			display: none;
		}
		.nav .row {
			flex: 1 0 auto;
		}
		.nav button {
			flex: 1 0 auto;
			justify-content: center;
			gap: 8px;
			height: 38px; /* a tab you touch keeps its 38px (it was 37.7 from the body line height) */
			padding: 0 12px;
			border-radius: var(--radius-control);
			white-space: nowrap;
		}
		.nav .glabel {
			display: none;
		}
		.nav .gsep {
			align-self: center;
			flex: none;
			width: 1px;
			height: 24px;
			margin: 0 4px;
		}
		.nav .tree, .nav button.fold, .nav .cbadge {
			display: none;
		}
		.nav .row.has > button:first-child {
			padding-right: 12px;
		}
	}
</style>
