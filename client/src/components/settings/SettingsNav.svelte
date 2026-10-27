<script lang="ts">
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { rovingKeys } from "../../lib/roving";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { Api } from "../../lib/api";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { SETTINGS_TABS, type SettingsTabId } from "../../lib/settings-search";
	import type { Server } from "../../lib/store.svelte";
	import Icon from "../Icon.svelte";
	import Pin from "../Pin.svelte";
	import { extensionUpdates } from "../../lib/extension-updates.svelte";

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
		scoped,
		server,
	}: {
		tab: string;
		extId: string | null;
		dir: number;
		/** Set to a client extension id to open its install preview on the device tab (the clip of a pair whose client half is missing) */
		installFor?: string | null;
		scoped: readonly (typeof SETTINGS_TABS)[number][];
		server: Server | null;
	} = $props();

	type TabId = SettingsTabId;
	const order = (id: string) => SETTINGS_TABS.findIndex((x) => x.id === id);
	/** Sections whose extensions the user folded away; everything starts unfolded. */
	let collapsed = $state<Record<string, boolean>>({});
	const extScope = (id: string) => (id === "extensions" ? "device" : id === "srvext" ? "server" : null);
	/** Extensions running inside the chosen server (read-only); listed under "서버 확장" like installed ones. */
	let serverSide = $state<{ id: string; names: { name: string; title?: string; companion?: string }[] } | null>(null);
	const apiOf = (id: string) => {
		const s = app.servers.find((x) => x.id === id);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	};
	$effect(() => {
		void app.configTick;
		const id = server?.id;
		if (!id) { serverSide = null; return; }
		let live = true;
		apiOf(id)?.serverExtensions().then((r) => { if (live) serverSide = { id, names: r.extensions.map((x) => ({ name: x.name, title: x.title, ...(x.companion ? { companion: x.companion } : {}) })) }; }).catch(() => { if (live) serverSide = null; });
		return () => { live = false; };
	});
	type Kid = { id: string; name: string; live: boolean; builtin: boolean; update?: boolean; /** a server extension whose client half is not installed on this device */ half?: boolean; halfLabel?: string; /** one half of a server + client pair: shown with a clip, and a warning clip when the other half is missing */ paired?: boolean; /** name of the other half of the pair, for the clip tooltip */ partner?: string; /** the last row: the trunk line stops here */ end?: boolean; /** where the clip leads: the other half of the pair (`install`: it is not installed, so open its install preview) */ link?: { tab: TabId; id: string | null; install?: string } };
	const hasUpdate = (id: string) => (id === "srvext" ? extensionUpdates.serverCount : id === "extensions" ? extensionUpdates.deviceCount : 0) > 0;
	const extsOf = (id: string): Kid[] => {
		const sc = extScope(id);
		if (!sc) return [];
		const own = extensions.installed.filter((e) => e.scope === sc).map((e) => ({ id: e.package.manifest.id, name: e.package.manifest.name, live: e.state === "active" || e.state === "starting", builtin: false, update: extensionUpdates.clientIds(sc).has(e.package.manifest.id), half: !!extensionUpdates.missingServerFor(e.package.manifest.id), halfLabel: t("서버 확장 필요") }));
		const side = sc === "server" && serverSide && serverSide.id === server?.id ? serverSide.names.map((n) => ({ id: `srv:${n.name}`, companion: n.companion, name: n.title ?? n.name, live: true, builtin: false, update: extensionUpdates.serverNames.has(n.name), halfLabel: t("클라이언트 확장 필요"), half: !!n.companion && !extensions.installed.some((e) => e.package.manifest.id === n.companion) })) : [];
		const owned = (id: string) => side.some((n) => n.companion === id);
		// the open server's extensions, whichever tab is listed: a client extension on this device is paired with its server half
		const serverNow = serverSide && serverSide.id === server?.id ? serverSide.names : [];
		const free = own.filter((e) => !owned(e.id));
		// a pair stays flat: the client half sits right after its server extension, both marked with a clip
		const rows: Kid[] = [...free.map((e) => { const m = extensionUpdates.missingServerFor(e.id); const here = serverNow.find((n) => n.companion === e.id); return { ...e, paired: !!m || !!here, partner: m?.name ?? here?.title ?? here?.name, link: { tab: "srvext" as TabId, id: here ? `srv:${here.name}` : null } }; })];
		for (const n of side) {
			const mate = own.find((e) => e.id === n.companion);
			rows.push({ ...n, paired: !!n.companion, partner: mate?.name ?? extensions.installed.find((e) => e.package.manifest.id === n.companion)?.package.manifest.name ?? (n.companion ? extensionUpdates.clientName(n.companion) ?? n.companion : undefined), link: n.companion ? (mate || extensions.installed.some((e) => e.package.manifest.id === n.companion) ? { tab: "extensions" as TabId, id: n.companion } : { tab: "extensions" as TabId, id: null, install: n.companion }) : undefined });
			if (mate) rows.push({ ...mate, paired: true, partner: n.name, link: { tab: "srvext" as TabId, id: n.id } });
		}
		return rows.map((e, i) => ({ ...e, end: i === rows.length - 1 }));
	};
	const clipTip = (e: Kid) => (e.half ? e.halfLabel : e.partner ? t("확장 ‘{name}’와 함께 작동합니다.", { name: e.partner }) : t("짝 확장과 함께 작동"));
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
</script>

<!-- desktop: a column on the left; phone: a row of tabs above the content -->
<div
	class="nav"
	role="tablist"
	aria-label={t("설정 구역")}
	use:slidingIndicator={{ selector: "button.on", variant: "fill", radius: "var(--radius-control)" }}
	use:rovingKeys={{ item: '[role="tab"]', axis: "both" }}
>
	{#each scoped as x (x.id)}
		{#if !x.server || server}
			{@const kids = extsOf(x.id)}
			{@const open = kids.length > 0 && !collapsed[x.id]}
			<div class="row" class:has={kids.length > 0}>
				<button role="tab" class:srvtab={x.server} aria-selected={tab === x.id && !extId} tabindex={tab === x.id && !extId ? 0 : -1} class:on={tab === x.id && !extId} onclick={() => go(x.id)}>
					<span class="nico"><Icon name={x.icon} />{#if hasUpdate(x.id) && !open}<Pin tone="ok" label={t("업데이트 있음")} />{/if}</span>
					<span class="nt">
						<span class="nl">{t(x.label)}</span>
						{#if x.sub}<span class="ns">{t(x.sub)}</span>{/if}
					</span>
				</button>
				{#if kids.length}
					<button type="button" class="fold hit" aria-expanded={open} aria-label={open ? t("하위 항목 접기") : t("하위 항목 펼치기")} onclick={() => (collapsed[x.id] = open)}>{#if !open}<span class="cbadge">{kids.length}</span>{/if}<Icon name="chevron-left" /></button>
				{/if}
			</div>
			{#if open}
				<div class="tree" role="group" aria-label={t(x.label)}>
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
			{#if x.id === "devices"}
				<button class="addsrv" onclick={() => (app.serverForm = "new")}><Icon name="plus" /> {t("서버 추가")}</button>
			{/if}
		{/if}
	{/each}
</div>

<style>
	.nav button.addsrv {
		gap: 8px;
		padding: 7px 12px;
		font-size: var(--fs-sm);
		color: var(--text-faint);
	}
	.nico {
		position: relative;
		display: inline-flex;
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
		padding-right: 56px;
	}
	.nav button.fold {
		position: absolute;
		top: 50%;
		right: 6px;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	.nav button.fold :global(svg) {
		width: 15px;
		height: 15px;
		transition: transform var(--motion-fast) var(--ease-std);
	}
	/* the arrow is always there: "<" = folded (can open), down = open; the shared count badge sits beside it only while folded */
	.nav button.fold[aria-expanded="true"] :global(svg) {
		transform: rotate(-90deg);
	}
	/* every child draws its stretch of a straight trunk (::after) and a short branch curving off it into itself (::before); the last trunk stops at its branch */
	.nav .tree {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0 0 4px 21px;
		padding-left: 18px;
	}
	.nav .item {
		position: relative;
		display: flex;
	}
	.nav button.sub {
		flex: 1;
		min-width: 0;
		gap: 8px;
		padding: 7px 10px;
	}
	.nav button.sub.linked {
		padding-right: 38px;
	}
	.nav .item::before,
	.nav .item::after {
		content: "";
		position: absolute;
		left: -18px;
		pointer-events: none;
	}
	.nav .item::after {
		top: -2px;
		bottom: -2px;
		border-left: 1.5px solid var(--border-strong);
	}
	.nav .item:first-child::after {
		top: -10px;
	}
	.nav .item.end::after {
		bottom: calc(50% + 9px);
	}
	.nav .item::before {
		top: calc(50% - 9px);
		width: 18px;
		height: 9px;
		border-left: 1.5px solid var(--border-strong);
		border-bottom: 1.5px solid var(--border-strong);
		border-bottom-left-radius: 9px;
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
	.nav button.srvtab {
		padding: 8px 12px;
	}
	.nav {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 2px;
		align-self: stretch;
		padding: 12px 10px;
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
		padding: 10px 12px;
		border-radius: var(--radius-control);
		text-align: left;
		color: var(--text-dim);
	}
	.nav button:hover {
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
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.nl {
		font-size: var(--fs-md);
		font-weight: 600;
	}
	.ns {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (max-width: 760px) {
		.nav {
			flex-direction: row;
			padding: 6px 12px;
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
			padding: 8px 14px;
			border-radius: var(--radius-control);
			white-space: nowrap;
		}
		.nav button.addsrv {
			padding: 9px 12px;
			font-size: var(--fs-md);
		}
		.ns {
			display: none;
		}
		.nav .tree, .nav button.fold {
			display: none;
		}
		.nav .row.has > button:first-child {
			padding-right: 12px;
		}
	}
</style>
