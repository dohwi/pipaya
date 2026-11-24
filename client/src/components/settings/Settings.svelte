<script lang="ts">
	import { untrack } from "svelte";
	import SearchField from "../ui/SearchField.svelte";
	import { fadeIn, paneIn } from "../../lib/motion";
	import { ACTIONS, formatCombo } from "../../lib/keys";
	import Modal from "../ui/Modal.svelte";
	import GeneralPane from "./GeneralPane.svelte";
	import SearchHits from "./SearchHits.svelte";
	import SettingsNav from "./SettingsNav.svelte";
	import ModalHeader from "../ui/ModalHeader.svelte";
	import Shortcuts from "./Shortcuts.svelte";
	import VoicePane from "./VoicePane.svelte";
	import SchedulesPane from "./SchedulesPane.svelte";
	import GuardPane from "./GuardPane.svelte";
	import TemplatesPane from "./TemplatesPane.svelte";
	import Extensions from "../extensions/Extensions.svelte";
	import Backup from "../server/Backup.svelte";
	import ServerForm from "../server/ServerForm.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Pin from "../ui/Pin.svelte";
	import { connectionState, orderServers, unreachable } from "../../lib/sidebar-model";
	import { app } from "../../lib/store.svelte";
	import { serverUpdater } from "../../lib/server-update.svelte";
	import { SETTINGS_TABS, needsOnlineServer, queryWords, resolveSettingsTab, searchSettings, type Hit, type SettingsTabId } from "../../lib/settings-search";
	import { t } from "../../lib/i18n";
	import { backLayer } from "../../lib/dialog";
	import { viewport } from "../../lib/viewport.svelte";
	import { phoneBack, phoneStart, touchOnly } from "../../lib/settings-phone";
	import { afterMotion, flash, watchTarget } from "../../lib/settings-focus";

	// App.svelte mounts this only while open, so the tab requested at open time is read once.
	// svelte-ignore state_referenced_locally
	const initial = resolveSettingsTab(app.settingsTab);
	let tab = $state<string>(initial.tab);
	/** Sub-tabs inside grouped sections ("info": info|devices, "tools": tools|guard, "sessions": sessions|templates|voice). */
	let infoSub = $state<"info" | "devices">(initial.tab === "info" && initial.sub === "devices" ? "devices" : "info");
	let toolsSub = $state<"tools" | "guard">(initial.tab === "tools" && initial.sub === "guard" ? "guard" : "tools");
	let sessionsSub = $state<"sessions" | "templates" | "voice">(
		initial.tab === "sessions" && (initial.sub === "templates" || initial.sub === "voice") ? initial.sub : "sessions",
	);

	/**
	 * Phone (≤600px): two steps. "list" shows every section (and the search), "detail" one section under a back arrow.
	 * Wider screens are always "detail": the nav is a column beside the section. Opened for a given section → straight to it.
	 */
	// svelte-ignore state_referenced_locally
	let step = $state<"list" | "detail">(phoneStart(app.settingsDirect));
	const listing = $derived(viewport.phone && step === "list");
	const detailPhone = $derived(viewport.phone && step === "detail");
	const touch = touchOnly({ coarse: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches, hover: typeof matchMedia === "function" && matchMedia("(hover: hover)").matches });

	/** The nav lists the common sections (`server: false`, same for every server) first, then the chosen server's own. */
	const tabs = SETTINGS_TABS;
	type TabId = SettingsTabId;
	/** The extension open in the "확장" panes; the sidebar lists them under their section. */
	let extId = $state<string | null>(null);
	let dir = $state(1);
	/** A server extension to look up in the marketplace once the server tab opens (set from a client extension that needs it). */
	let marketFor = $state<string | null>(null);
	/** A client extension to download and preview for install as soon as the device tab opens (set from the clip of a server extension whose client half is missing). */
	let installFor = $state<string | null>(null);
	/**
	 * Opened on one row (the graph view's "설정 열기"): once its section has loaded the row, scroll to it and outline it.
	 * Moving to another section or server first drops the jump. The request is cleared when it is done (the model list
	 * reads it to fold its connection open).
	 */
	let layout = $state<HTMLElement>();
	let stopFocus: (() => void) | null = null;
	const dropFocus = () => {
		stopFocus?.();
		stopFocus = null;
		app.settingsFocus = null;
	};
	$effect(() => {
		const root = layout;
		const f = untrack(() => app.settingsFocus);
		if (!root || !f) return;
		stopFocus = watchTarget(root, f, (el) => {
			stopFocus = null;
			if (el) void afterMotion(root).then(() => el.isConnected && flash(el));
			app.settingsFocus = null;
		});
		return dropFocus;
	});
	function go(next: TabId) {
		if (next !== tab) dropFocus();
		extId = null;
		if (next === tab) return;
		dir = tabs.findIndex((x) => x.id === next) > tabs.findIndex((x) => x.id === tab) ? 1 : -1;
		tab = next;
	}
	const current = $derived(tabs.find((x) => x.id === tab) ?? tabs[0]);
	/**
	 * The server whose sections are shown. Picking one here only changes what this window shows: it never switches the
	 * open server, and nothing in here touches the open chat.
	 */
	// opened for a given server (the graph view's "설정 열기"): its sections; otherwise the open server's
	// svelte-ignore state_referenced_locally
	let sid = $state<string | null>(app.settingsServer && app.settingsServer !== "new" ? app.settingsServer : app.serverId);
	function showServer(id: string) {
		if (id !== sid) dropFocus();
		sid = id; // the section stays: a common one keeps showing, a server one now shows for this server
	}
	/** Update state is only known for the open server: a newer server build, or server and app out of step. */
	const needsUpdate = (id: string) => id === app.serverId && (serverUpdater.available || app.compat !== "ok");
	const server = $derived(app.servers.find((s) => s.id === sid) ?? app.servers.find((s) => s.id === app.serverId) ?? null);
	// without a server there is nothing server-specific left to show
	$effect(() => {
		if (!server && current.server) tab = "general";
	});
	/** Same order as the sidebar: up, checking, then unreachable (shown only; the saved order is untouched). */
	const chips = $derived(orderServers(app.servers.map((s) => ({ s, local: s.local, state: connectionState(app.links[s.id]?.net ?? "connecting") }))));
	const serverOnline = $derived(!server || app.links[server.id]?.net === "online");
	/** The shown server does not answer: its sections are off, only "정보" stays so the address or token can be fixed. */
	$effect(() => {
		if (!serverOnline && needsOnlineServer(tab)) { extId = null; tab = "info"; }
	});


	/* ---------- search: settings sections and shortcuts in one list ---------- */
	let query = $state("");
	/** Filter handed to the shortcut list when a shortcut result is opened. */
	let keyFilter = $state("");
	const words = $derived(queryWords(query));
	const hits = $derived(
		searchSettings(words, {
			hasServer: !!server,
			serverOnline,
			shortcuts: ACTIONS.map((a) => {
				const combo = app.prefs.bindings[a.id];
				return { id: a.id, label: a.label, hint: a.hint, combo, shown: formatCombo(combo) };
			}),
		}),
	);
	function pick(h: Hit) {
		if (h.target.keyFilter !== undefined) keyFilter = h.target.keyFilter;
		go(h.target.tab);
		step = "detail";
		query = "";
	}

	/** Tablet-narrow: an open extension page is one step inside the window, so back returns to the list before it closes the window. */
	$effect(() => {
		if (viewport.phone || !viewport.narrow || !extId || words.length) return;
		return backLayer({ onclose: () => (extId = null) });
	});
	/** Phone: a section page is a step too: back (arrow, hardware or browser) leaves an open extension, then the section, then the window. */
	function back() {
		const next = phoneBack({ step, extId });
		step = next.step;
		extId = next.extId;
	}
	$effect(() => {
		if (!detailPhone) return;
		return backLayer({ onclose: back });
	});

	const close = () => (app.settingsOpen = false);
</script>

<Modal closeShortcut="settings" onclose={close} label={t("설정")} width="2xl" height="700px" maxHeight="700px" gutter="48px" safeArea>
	<ModalHeader title={detailPhone ? t(current.label) : t("설정")} onclose={close} onback={detailPhone ? back : undefined} />
	{#if !detailPhone}
	<div class="srvbar">
		<div class="srvseg">
			<Segmented
				label={t("설정 범위")}
				size="sm"
				full={false}
				value={server?.id ?? ""}
				options={chips.map(({ s }) => ({ id: s.id, label: app.serverLabel(s), title: app.serverLabel(s) }))}
				onchange={showServer}
			>
				{#snippet option({ id, label })}
					{@const c = chips.find((x) => x.s.id === id)}
					<span class="srvopt" class:off={c ? unreachable(c.state) : false}>
						<span class="srvname">{label}</span>
						{#if c && app.problemsOf(id).length}<Pin tone="danger" label={t("설정 문제 {n}", { n: app.problemsOf(id).length })} />
						{:else if c && needsUpdate(id)}<Pin tone={app.compat === "ok" ? "ok" : "warn"} label={app.compat === "ok" ? t("서버 업데이트 있음") : t("업데이트 필요")} />{/if}
					</span>
				{/snippet}
			</Segmented>
		</div>
		<IconButton icon="plus" size="sm" label={t("서버 추가")} tip onclick={() => (app.serverForm = "new")} />
	</div>

	<div class="searchbar">
		<SearchField label={t("설정·단축키 검색")} bind:value={query} onkeydown={(e) => { if (e.key === "Enter" && hits[0]) pick(hits[0]); }} />
	</div>

	{/if}

	<div class="layout" class:phone={viewport.phone} bind:this={layout}>
		{#if !detailPhone && !(listing && words.length)}
		<SettingsNav bind:tab bind:extId bind:dir bind:installFor serverName={server ? app.serverLabel(server) : ""} {server} {serverOnline} phone={viewport.phone} {touch} onopen={() => (step = "detail")} />
		{/if}

		{#if !listing || words.length}
		<div class="body">
			{#if words.length}
				<div class="pane" role="region" aria-label={t("검색 결과")} in:fadeIn>
					<SearchHits {hits} onpick={pick} />
				</div>
			{:else}
			<!-- Switching server on the same section must not replay the pane fade (it blanked the content for a moment = flicker);
			     ServerForm is keyed by server id below and swaps in place. Only the extensions list reads the server from a prop. -->
			{#key tab + (tab === "srvext" ? (server?.id ?? "") : "")}
			<div class="pane" role="tabpanel" in:paneIn={{ x: dir * 18 }}>
			<div class="phead">
				<h3>{t(current.label)}</h3>
				{#if current.sub}<p>{t(current.sub)}</p>{/if}
			</div>
			{#if tab === "srvext"}
				<Extensions serverId={server?.id ?? null} bind:selected={extId} bind:marketFor bind:installFor />
			{:else if tab === "backup"}
				<Backup />
			{:else if tab === "schedules" && server}
				{#key server.id}<SchedulesPane serverId={server.id} />{/key}
			{:else if tab === "keys"}
				<Shortcuts bind:filter={keyFilter} />
			{:else if tab === "general"}
				<GeneralPane />
			{:else if tab === "info" && server}
				{#if serverOnline}
					<div class="subtabs">
						<Segmented
							tabs
							variant="underline"
							label={t("서버 세부 구역")}
							value={infoSub}
							onchange={(v) => (infoSub = v)}
							options={[{ id: "info" as const, label: t("연결 정보") }, { id: "devices" as const, label: t("접속 기기") }]}
						/>
					</div>
				{/if}
				{#key `${server.id}:${infoSub}`}
					<ServerForm target={server.id} embedded section={serverOnline ? infoSub : "info"} />
				{/key}
			{:else if tab === "tools" && server}
				<div class="subtabs">
					<Segmented
						tabs
						variant="underline"
						label={t("에이전트 세부 구역")}
						value={toolsSub}
						onchange={(v) => (toolsSub = v)}
						options={[{ id: "tools" as const, label: t("도구 · 위임") }, { id: "guard" as const, label: t("명령 보호") }]}
					/>
				</div>
				{#if toolsSub === "guard"}
					{#key server.id}<GuardPane serverId={server.id} />{/key}
				{:else}
					{#key server.id}<ServerForm target={server.id} embedded section="tools" />{/key}
				{/if}
			{:else if tab === "sessions" && server}
				<div class="subtabs">
					<Segmented
						tabs
						variant="underline"
						label={t("대화 세부 구역")}
						value={sessionsSub}
						onchange={(v) => (sessionsSub = v)}
						options={[
							{ id: "sessions" as const, label: t("기본 설정") },
							{ id: "templates" as const, label: t("프롬프트 템플릿") },
							{ id: "voice" as const, label: t("음성 입력") },
						]}
					/>
				</div>
				{#if sessionsSub === "templates"}
					{#key server.id}<TemplatesPane serverId={server.id} />{/key}
				{:else if sessionsSub === "voice"}
					{#key server.id}<VoicePane serverId={server.id} />{/key}
				{:else}
					{#key server.id}<ServerForm target={server.id} embedded section="sessions" />{/key}
				{/if}
			{:else if current.server && server}
				{#key server.id}<ServerForm target={server.id} embedded section={current.id as "models" | "mcp"} only={current.id === "mcp" && extId?.startsWith("mcp:") ? extId.slice(4) : null} onselectmcp={(name) => (extId = name ? `mcp:${name}` : null)} />{/key}
			{/if}
			</div>
			{/key}
			{/if}
		</div>
		{/if}
	</div>
</Modal>

<style>
	.searchbar {
		flex: none;
		position: relative;
		padding: 0 var(--dlg-px) var(--dlg-foot-t);
	}
		.srvbar {
		position: relative;
		flex: none;
		display: flex;
		align-items: center;
		gap: var(--dlg-gap-sm);
		padding: var(--dlg-gap-sm) var(--dlg-px) var(--dlg-foot-t);
	}
	.srvseg {
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	/* the strip scrolls (so it clips): draw the ring inside the button, not 4px outside it */
	.srvseg :global(.seg > button:focus-visible) {
		outline-offset: -2px;
	}
	.srvseg::-webkit-scrollbar {
		display: none;
	}
	.srvopt {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		--pin-ring: var(--bg-active);
	}
	/* unreachable: a quieter name (still pressable: its "정보" tab fixes the address or token) */
	.srvopt.off {
		color: var(--text-faint);
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
		gap: 4px;
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
		padding: var(--dlg-body-t) var(--dlg-px) var(--dlg-body-b);
		overflow-y: auto;
		overflow-x: clip; /* the incoming pane starts a few px to the side */
		scroll-padding-block: 12px; /* Tab scrolls the focused control in with its focus ring, not flush with the edge */
	}
	.pane {
		display: flex;
		flex-direction: column;
		gap: var(--dlg-gap);
		max-width: 680px;
	}
	@media (max-width: 600px) {
		.layout.phone {
			grid-template-rows: minmax(0, 1fr);
		}
	}
	@media (max-width: 760px) {


		.layout {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
		}
		.phead {
			display: none;
		}
		.pane {
			gap: var(--dlg-gap);
		}
	}
</style>
