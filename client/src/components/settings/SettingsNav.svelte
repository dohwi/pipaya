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

	/**
	 * The column of sections on the left (a row of tabs on a phone). A section with extensions lists them under it as a
	 * small tree; picking one opens it inside that section. `tab` and `extId` are the window's selection and move with
	 * every click, so the pane on the right follows; `dir` is the side the next pane enters from.
	 */
	let {
		tab = $bindable(),
		extId = $bindable(),
		dir = $bindable(),
		scoped,
		server,
	}: {
		tab: string;
		extId: string | null;
		dir: number;
		scoped: readonly (typeof SETTINGS_TABS)[number][];
		server: Server | null;
	} = $props();

	type TabId = SettingsTabId;
	const order = (id: string) => SETTINGS_TABS.findIndex((x) => x.id === id);
	/** Sections whose extensions the user folded away; everything starts unfolded. */
	let collapsed = $state<Record<string, boolean>>({});
	const extScope = (id: string) => (id === "extensions" ? "device" : id === "srvext" ? "server" : null);
	/** Extensions running inside the chosen server (read-only); listed under "서버 확장" like installed ones. */
	let serverSide = $state<{ id: string; names: { name: string; title?: string }[] } | null>(null);
	const apiOf = (id: string) => {
		const s = app.servers.find((x) => x.id === id);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	};
	$effect(() => {
		void app.configTick;
		const id = server?.id;
		if (!id) { serverSide = null; return; }
		let live = true;
		apiOf(id)?.serverExtensions().then((r) => { if (live) serverSide = { id, names: r.extensions.map((x) => ({ name: x.name, title: x.title })) }; }).catch(() => { if (live) serverSide = null; });
		return () => { live = false; };
	});
	type Kid = { id: string; name: string; live: boolean; builtin: boolean };
	const extsOf = (id: string): Kid[] => {
		const sc = extScope(id);
		if (!sc) return [];
		const own = extensions.installed.filter((e) => e.scope === sc).map((e) => ({ id: e.package.manifest.id, name: e.package.manifest.name, live: e.state === "active" || e.state === "starting", builtin: false }));
		const side = sc === "server" && serverSide && serverSide.id === server?.id ? serverSide.names.map((n) => ({ id: `srv:${n.name}`, name: n.title ?? n.name, live: true, builtin: false })) : [];
		return [...own, ...side];
	};
	function openExt(tabId: TabId, id: string) {
		if (tabId !== tab) { dir = order(tabId) > order(tab) ? 1 : -1; tab = tabId; }
		extId = id;
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
	use:slidingIndicator={{ selector: "button.on", variant: "fill", radius: "var(--radius)" }}
	use:rovingKeys={{ item: '[role="tab"]', axis: "both" }}
>
	{#each scoped as x (x.id)}
		{#if !x.server || server}
			{@const kids = extsOf(x.id)}
			{@const open = kids.length > 0 && !collapsed[x.id]}
			<div class="row" class:has={kids.length > 0}>
				<button role="tab" class:srvtab={x.server} aria-selected={tab === x.id && !extId} tabindex={tab === x.id && !extId ? 0 : -1} class:on={tab === x.id && !extId} onclick={() => go(x.id)}>
					<Icon name={x.icon} />
					<span class="nt">
						<span class="nl">{t(x.label)}</span>
						{#if x.sub}<span class="ns">{t(x.sub)}</span>{/if}
					</span>
				</button>
				{#if kids.length}
					<button type="button" class="fold" aria-expanded={open} aria-label={open ? t("하위 항목 접기") : t("하위 항목 펼치기")} onclick={() => (collapsed[x.id] = open)}>{#if open}<Icon name="chevron-down" />{:else}<span class="cbadge">{kids.length}</span>{/if}</button>
				{/if}
			</div>
			{#if open}
				<div class="tree" role="group" aria-label={t(x.label)}>
					{#each kids as e (e.id)}
						<button role="tab" class="sub" aria-selected={extId === e.id} tabindex={extId === e.id ? 0 : -1} class:on={extId === e.id} onclick={() => (e.builtin ? go(x.id) : openExt(x.id, e.id))}>
							<span class="dot" class:live={e.live} role="img" aria-label={e.live ? t("실행 중") : t("꺼짐")}></span>
							<span class="nl">{e.name}</span>
						</button>
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
	.nav .row {
		position: relative;
		display: flex;
	}
	.nav .row > button:first-child {
		flex: 1;
		min-width: 0;
	}
	.nav .row.has > button:first-child {
		padding-right: 38px;
	}
	.nav button.fold {
		position: absolute;
		top: 50%;
		right: 6px;
		transform: translateY(-50%);
		padding: 4px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	.nav button.fold :global(svg) {
		width: 15px;
		height: 15px;
		transition: transform var(--motion-fast) var(--ease-std);
	}
	.nav .cbadge {
		display: grid;
		place-items: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px 2px; /* 2px under the digits lifts them 1px: the font leaves more room below the baseline than above */
		box-sizing: border-box;
		border-radius: 9px;
		background: var(--bg-active);
		color: var(--text-faint);
		font-size: var(--fs-2xs);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	/* every child draws its stretch of a straight trunk (::after) and a short branch curving off it into itself (::before); the last trunk stops at its branch */
	.nav .tree {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: -6px 0 4px 21px;
		padding-left: 18px;
	}
	.nav button.sub {
		position: relative;
		gap: 8px;
		padding: 7px 10px;
	}
	.nav button.sub::before,
	.nav button.sub::after {
		content: "";
		position: absolute;
		left: -18px;
		pointer-events: none;
	}
	.nav button.sub::after {
		top: -2px;
		bottom: -2px;
		border-left: 1.5px solid var(--border-strong);
	}
	.nav button.sub:first-child::after {
		top: -8px;
	}
	.nav button.sub:last-child::after {
		bottom: calc(50% + 9px);
	}
	.nav button.sub::before {
		top: calc(50% - 9px);
		width: 16px;
		height: 9px;
		border-left: 1.5px solid var(--border-strong);
		border-bottom: 1.5px solid var(--border-strong);
		border-bottom-left-radius: 9px;
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
		border-radius: var(--radius);
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
			border-radius: 999px;
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
