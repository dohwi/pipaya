<script lang="ts">
	import SearchField from "./SearchField.svelte";
	import { fadeIn, paneIn } from "../lib/motion";
	import { ACTIONS, formatCombo } from "../lib/keys";
	import Modal from "./Modal.svelte";
	import GeneralPane from "./settings/GeneralPane.svelte";
	import SearchHits from "./settings/SearchHits.svelte";
	import SettingsNav from "./settings/SettingsNav.svelte";
	import ModalHeader from "./ModalHeader.svelte";
	import Shortcuts from "./Shortcuts.svelte";
	import Extensions from "./Extensions.svelte";
	import Backup from "./Backup.svelte";
	import ServerForm from "./ServerForm.svelte";
	import FilterChip from "./FilterChip.svelte";
	import Pin from "./Pin.svelte";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { app } from "../lib/store.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";
	import { SETTINGS_TABS, queryWords, searchSettings, type Hit, type SettingsTabId } from "../lib/settings-search";
	import { t } from "../lib/i18n";
	import { srvKey } from "../lib/server-extension";
	import { backLayer } from "../lib/dialog";
	import { viewport } from "../lib/viewport.svelte";

	// App.svelte mounts this only while open, so the tab requested at open time is read once.
	// svelte-ignore state_referenced_locally
	let tab = $state<string>(app.settingsTab === "servers" ? "info" : app.settingsTab);

	/** Settings follow the open server: its own sections (`server: true`) sit between the app-wide ones. */
	const tabs = SETTINGS_TABS;
	type TabId = SettingsTabId;
	/** The extension open in the "확장" panes; the sidebar lists them under their section. */
	let extId = $state<string | null>(null);
	let dir = $state(1);
	/** A server extension to look up in the marketplace once the server tab opens (set from a client extension that needs it). */
	let marketFor = $state<string | null>(null);
	/** Asked from elsewhere (a model that needs an extension): open the server's marketplace on it, even while open. */
	$effect(() => {
		const id = app.settingsMarketFor;
		if (!id) return;
		app.settingsMarketFor = null;
		sid = app.serverId;
		go("srvext");
		marketFor = id;
	});
	/** A client extension to download and preview for install as soon as the device tab opens (set from the clip of a server extension whose client half is missing). */
	let installFor = $state<string | null>(null);
	function go(next: TabId) {
		extId = null;
		if (next === tab) return;
		dir = tabs.findIndex((x) => x.id === next) > tabs.findIndex((x) => x.id === tab) ? 1 : -1;
		tab = next;
	}
	const current = $derived(tabs.find((x) => x.id === tab) ?? tabs[0]);
	/** The chips above split the sections: "내 설정" shows the app-wide ones, a server chip shows that server's own. */
	const scoped = $derived(tabs.filter((x) => x.server === current.server));
	function showCommon() {
		if (current.server) go("general");
	}
	/**
	 * The server whose sections are shown. Picking one here only changes what this window shows: it never switches the
	 * open server, and nothing in here touches the open chat.
	 */
	// svelte-ignore state_referenced_locally
	let sid = $state<string | null>(app.serverId);
	function showServer(id: string) {
		sid = id;
		if (!current.server) go("info");
	}
	/** Update state is only known for the open server: a newer server build, or server and app out of step. */
	const needsUpdate = (id: string) => id === app.serverId && (serverUpdater.available || app.compat !== "ok");
	const server = $derived(app.servers.find((s) => s.id === sid) ?? app.servers.find((s) => s.id === app.serverId) ?? null);
	// without a server there is nothing server-specific left to show
	$effect(() => {
		if (!server && current.server) tab = "general";
	});


	/* ---------- search: settings sections and shortcuts in one list ---------- */
	let query = $state("");
	/** Filter handed to the shortcut list when a shortcut result is opened. */
	let keyFilter = $state("");
	const words = $derived(queryWords(query));
	const hits = $derived(
		searchSettings(words, {
			hasServer: !!server,
			shortcuts: ACTIONS.map((a) => {
				const combo = app.prefs.bindings[a.id];
				return { id: a.id, label: a.label, hint: a.hint, combo, shown: formatCombo(combo) };
			}),
		}),
	);
	function pick(h: Hit) {
		if (h.target.keyFilter !== undefined) keyFilter = h.target.keyFilter;
		go(h.target.tab);
		query = "";
	}

	/** Phone: an open extension page is one step inside the window, so back returns to the list before it closes the window. */
	$effect(() => {
		if (!viewport.narrow || !extId || words.length) return;
		return backLayer({ onclose: () => (extId = null) });
	});

	const close = () => (app.settingsOpen = false);
</script>

<Modal onclose={close} label={t("설정")} width="920px" height="700px" maxHeight="700px" gutter="48px" safeArea>
	<ModalHeader title={t("설정")} onclose={close} />
	<div class="srvbar" role="group" aria-label={t("설정 범위")} use:slidingIndicator={{ selector: ".fchip.on", radius: "999px" }}>
		<FilterChip on={!current.server} title={t("이 기기에만 적용되고 모든 서버에서 같은 설정")} onclick={showCommon}>{t("내 설정")}</FilterChip>
		{#each app.servers as s (s.id)}
			<span class="chipwrap">
				<FilterChip on={current.server && s.id === server?.id} title={app.serverLabel(s)} onclick={() => showServer(s.id)}><span class="srvname">{app.serverLabel(s)}</span></FilterChip>
				{#if needsUpdate(s.id)}<Pin tone={app.compat === "ok" ? "ok" : "warn"} label={app.compat === "ok" ? t("업데이트 있음") : t("업데이트 필요")} />{/if}
			</span>
		{/each}
	</div>

	<div class="searchbar">
		<SearchField label={t("설정·단축키 검색")} bind:value={query} onkeydown={(e) => { if (e.key === "Enter" && hits[0]) pick(hits[0]); }} />
	</div>

	<div class="layout">
		<SettingsNav bind:tab bind:extId bind:dir bind:installFor {scoped} {server} />

		<div class="body">
			{#if words.length}
				<div class="pane" role="region" aria-label={t("검색 결과")} in:fadeIn>
					<SearchHits {hits} onpick={pick} />
				</div>
			{:else}
			{#key tab + (current.server ? (server?.id ?? "") : "")}
			<div class="pane" role="tabpanel" in:paneIn={{ x: dir * 18 }}>
			<div class="phead">
				<h3>{t(current.label)}</h3>
				{#if current.sub}<p>{t(current.sub)}</p>{/if}
			</div>
			{#if tab === "extensions"}
				<Extensions scope="device" bind:selected={extId} bind:installFor ongoserver={(id) => { marketFor = id; go("srvext"); }} onopenserverext={(name) => { go("srvext"); extId = srvKey(name); }} />
			{:else if tab === "srvext"}
				<Extensions scope="server" bind:selected={extId} bind:marketFor ongoclient={(id) => { go("extensions"); extId = id; }} />
			{:else if tab === "backup"}
				<Backup />
			{:else if tab === "keys"}
				<Shortcuts bind:filter={keyFilter} />
			{:else if tab === "general"}
				<GeneralPane />
			{:else if current.server && server}
				{#key server.id}<ServerForm target={server.id} embedded section={current.id as "info"} />{/key}
			{/if}
			</div>
			{/key}
			{/if}
		</div>
	</div>
</Modal>

<style>
	.searchbar {
		flex: none;
		position: relative;
		padding: 0 22px 12px;
	}
	/* The chips' focus ring (4px) needs room inside the scroller, which clips on both axes */
	.srvbar {
		position: relative;
		flex: none;
		display: flex;
		gap: 6px;
		margin-top: -6px;
		padding: 8px 22px 12px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.srvbar::-webkit-scrollbar {
		display: none;
	}
	.chipwrap {
		position: relative;
		flex: none;
		display: inline-flex;
		--pin-ring: var(--bg-elev);
		/* the chip is a pill, so its corner is empty: pull the dot in onto the curve */
		--pin-inset: 2px;
	}
	.srvname {
		min-width: 0;
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.layout {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		border-top: 1px solid var(--border);
	}
	.phead {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.phead h3 {
		margin: 0;
		font-size: var(--fs-xl);
	}
	.phead p {
		margin: 0;
		font-size: var(--fs-sm);
		color: var(--text-faint);
	}
	.body {
		min-width: 0;
		padding: 22px 28px 28px;
		overflow-y: auto;
		overflow-x: clip; /* the incoming pane starts a few px to the side */
		scroll-padding-block: 12px; /* Tab scrolls the focused control in with its focus ring, not flush with the edge */
	}
	.pane {
		display: flex;
		flex-direction: column;
		gap: 22px;
		max-width: 680px;
	}
	@media (max-width: 760px) {

		.searchbar {
			padding: 0 16px 10px;
		}

		.srvbar {
			padding: 8px 16px 10px;
		}

		.layout {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
		}
		.body {
			padding: 16px 16px 24px;
		}
		.phead {
			display: none;
		}
		.pane {
			gap: 18px;
		}
	}
</style>
