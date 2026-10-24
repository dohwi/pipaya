<script lang="ts">
	import { collapseIn, collapseOut, fadeIn, paneIn } from "../lib/motion";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { ACTIONS, formatCombo } from "../lib/keys";
	import { rovingKeys } from "../lib/roving";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import ModalHeader from "./ModalHeader.svelte";
	import Shortcuts from "./Shortcuts.svelte";
	import Extensions from "./Extensions.svelte";
	import { extensions } from "../lib/extensions/host.svelte";
	import Backup from "./Backup.svelte";
	import ServerForm from "./ServerForm.svelte";
	import Switch from "./Switch.svelte";
	import SettingRow from "./SettingRow.svelte";
	import Segmented from "./Segmented.svelte";
	import FilterChip from "./FilterChip.svelte";
	import Pin from "./Pin.svelte";
	import NotificationSettings from "./NotificationSettings.svelte";
	import UpdateSettings from "./UpdateSettings.svelte";
	import ToolSettings from "./ToolSettings.svelte";
	import TerminalSettings from "./TerminalSettings.svelte";
	import { app, type ThemePref } from "../lib/store.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";
	import { Api } from "../lib/api";
	import { SETTINGS_TABS, queryWords, searchSettings, type Hit, type SettingsTabId } from "../lib/settings-search";
	import { getLangPref, languageName, languages, msg, setLangPref, systemLang, t } from "../lib/i18n";

	// App.svelte mounts this only while open, so the tab requested at open time is read once.
	// svelte-ignore state_referenced_locally
	let tab = $state<string>(app.settingsTab === "servers" ? "info" : app.settingsTab);

	/** Settings follow the open server: its own sections (`server: true`) sit between the app-wide ones. */
	const tabs = SETTINGS_TABS;
	type TabId = SettingsTabId;
	/** Which side the next pane enters from, so content follows the selection. */
	let dir = $state(1);
	/** The extension open in the "확장" panes; the sidebar lists them under their section. */
	let extId = $state<string | null>(null);
	/** Sections whose extensions the user folded away in the sidebar; everything starts unfolded. */
	let collapsed = $state<Record<string, boolean>>({});
	const extScope = (id: string) => (id === "extensions" ? "device" : id === "srvext" ? "server" : null);
	/** Extensions running inside the chosen server (read-only); the sidebar lists them under "서버 확장" like installed ones. */
	let serverSide = $state<{ id: string; names: { name: string; title?: string }[] } | null>(null);
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
		if (tabId !== tab) { dir = tabs.findIndex((x) => x.id === tabId) > tabs.findIndex((x) => x.id === tab) ? 1 : -1; tab = tabId; }
		extId = id;
	}
	function go(next: TabId) {
		if (next === tab) { extId = null; return; }
		extId = null;
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

	const apiOf = (id: string) => {
		const s = app.servers.find((x) => x.id === id);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	};

	const themes: { id: ThemePref; label: string; icon: "monitor" | "sun" | "moon" }[] = [
		{ id: "system", label: msg("시스템"), icon: "monitor" },
		{ id: "light", label: msg("라이트"), icon: "sun" },
		{ id: "dark", label: msg("다크"), icon: "moon" },
	];
	/** Language names stay in their own language so they can be found from any other. */
	const langOptions = $derived([{ tag: "system", name: t("시스템") }, ...languages()]);

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

	const close = () => (app.settingsOpen = false);
</script>

<Modal onclose={close} label={t("설정")} width="920px" height="700px" maxHeight="700px" gutter="48px" safeArea>
	<ModalHeader title={t("설정")} onclose={close} />
	<div class="srvbar" role="group" aria-label={t("설정 범위")}>
		<FilterChip on={!current.server} title={t("이 기기에만 적용되고 모든 서버에서 같은 설정")} onclick={showCommon}>{t("내 설정")}</FilterChip>
		{#each app.servers as s (s.id)}
			<span class="chipwrap">
				<FilterChip on={current.server && s.id === server?.id} title={app.serverLabel(s)} onclick={() => showServer(s.id)}><span class="srvname">{app.serverLabel(s)}</span></FilterChip>
				{#if needsUpdate(s.id)}<Pin tone="warn" label={t("업데이트 필요")} />{/if}
			</span>
		{/each}
	</div>

	<div class="searchbar">
		<Icon name="search" />
		<input type="search" placeholder={t("설정·단축키 검색")} aria-label={t("설정·단축키 검색")} bind:value={query} onkeydown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); query = ""; } else if (e.key === "Enter" && hits[0]) pick(hits[0]); }} />
	</div>

	<div class="layout">
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

		<div class="body">
			{#if words.length}
				<div class="pane" role="region" aria-label={t("검색 결과")} in:fadeIn>
					{#if !hits.length}<span class="hint">{t("검색 결과가 없습니다")}</span>{/if}
					<ul class="hits">
						{#each hits as h (h.key)}
							<li><button onclick={() => pick(h)}>
								<span class="ht">{h.title}</span>
								<span class="hw">{h.where}</span>
								{#if h.combo}<span class="hc">{h.combo}</span>{/if}
							</button></li>
						{/each}
					</ul>
				</div>
			{:else}
			{#key tab + (current.server ? (server?.id ?? "") : "")}
			<div class="pane" role="tabpanel" in:paneIn={{ x: dir * 18 }}>
			<div class="phead">
				<h3>{t(current.label)}</h3>
				{#if current.sub}<p>{t(current.sub)}</p>{/if}
			</div>
			{#if tab === "extensions"}
				<Extensions scope="device" bind:selected={extId} />
			{:else if tab === "srvext"}
				<Extensions scope="server" bind:selected={extId} />
			{:else if tab === "backup"}
				<Backup />
			{:else if tab === "keys"}
				<Shortcuts bind:filter={keyFilter} />
			{:else if tab === "general"}
				<section>
					<div class="mono-label">{t("언어")}</div>
					<Segmented variant="cards" columns={3} label={t("언어")} value={getLangPref()} onchange={setLangPref} options={langOptions.map((l) => ({ id: l.tag, label: l.name, lang: l.tag === "system" ? undefined : l.tag }))} />
					{#if getLangPref() === "system"}
						<span class="hint" in:collapseIn out:collapseOut>{t("기기 언어를 따릅니다: {name}", { name: languageName(systemLang(navigator.languages)) })}</span>
					{/if}
				</section>

				<section>
					<div class="mono-label">{t("테마")}</div>
					<Segmented variant="cards" label={t("테마")} value={app.prefs.theme} onchange={(id) => app.prefs.setTheme(id)} options={themes.map((th) => ({ id: th.id, label: t(th.label) }))}>
						{#snippet option(o)}<Icon name={themes.find((th) => th.id === o.id)!.icon} /> {o.label}{/snippet}
					</Segmented>
				</section>

				<section>
					<div class="mono-label">{t("화면 배율")}</div>
					<label class="volume">
						<span>{t("배율")}</span>
						<input type="range" min="50" max="200" step="10" value={app.prefs.uiScale} aria-label={t("화면 배율")} oninput={(e) => app.prefs.setUiScale(+e.currentTarget.value)} />
						<output>{app.prefs.uiScale}%</output>
						<button type="button" class="reset" disabled={app.prefs.uiScale === 100} onclick={() => app.prefs.setUiScale(100)}>{t("100%로")}</button>
					</label>
					<span class="hint">{t("앱 전체 크기를 조절합니다. 단축키: Ctrl/⌘ + / − / 0 (설정에서 바꿀 수 있습니다)")}</span>
				</section>

				<section>
					<div class="mono-label">{t("알림음")}</div>
					<SettingRow label={t("작업 완료 · 확인 필요 · 실패 때 소리 재생")}>
						<Switch checked={app.prefs.soundOn} label={t("알림음")} onchange={(on) => app.prefs.setSound(on)} />
					</SettingRow>
					<label class="volume" class:off={!app.prefs.soundOn}>
						<span>{t("크기")}</span>
						<input
							type="range"
							min="0"
							max="200"
							step="5"
							value={app.prefs.soundVolume}
							disabled={!app.prefs.soundOn}
							aria-label={t("알림음 크기")}
							oninput={(e) => app.prefs.setSoundVolume(+e.currentTarget.value)}
							onchange={() => app.prefs.previewSound()}
						/>
						<output>{app.prefs.soundVolume}%</output>
					</label>
					<span class="hint">{t("보고 있는 대화가 끝날 때는 울리지 않습니다. 승인 요청은 보고 있어도 울립니다.")}</span>
				</section>
				<section><NotificationSettings /></section>
				<section><TerminalSettings /></section>
				<section><UpdateSettings /></section>
			{:else if tab === "tools" && server}
				<ToolSettings serverId={server.id} />
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
	.searchbar :global(svg) {
		position: absolute;
		left: 34px;
		top: 9px;
		width: 16px;
		height: 16px;
		stroke: var(--text-faint);
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: none;
	}
	.searchbar input {
		width: 100%;
		height: 34px;
		padding: 0 12px 0 34px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-md);
	}
	.hits {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.hits button {
		width: 100%;
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 10px 8px;
		border-top: 1px solid var(--border);
		text-align: left;
		border-radius: 0;
	}
	.hits li:first-child button {
		border-top: 0;
	}
	.hits button:hover {
		background: var(--bg-hover);
	}
	.ht {
		font-size: var(--fs-md);
	}
	.hw {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hc {
		flex: none;
		font-family: var(--mono);
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	@media (max-width: 760px) {
		.searchbar {
			padding: 0 14px 10px;
		}
		.searchbar :global(svg) {
			left: 26px;
		}
	}
	.volume {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: var(--fs-md);
		line-height: 1.4;
		transition: opacity var(--motion-normal) var(--ease-std);
	}
	.volume span {
		flex: none;
	}
	.volume .reset {
		flex: none;
		font-size: var(--fs-sm, 12px);
		color: var(--text-dim);
	}
	.volume .reset:disabled {
		opacity: 0.4;
	}
	.volume.off {
		opacity: 0.45;
	}
	.volume input {
		flex: 1;
		min-width: 0;
		margin: 0;
		accent-color: var(--text);
	}
	.volume output {
		width: 48px;
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
	}
	/* The chips' focus ring (4px) needs room inside the scroller, which clips on both axes */
	.srvbar {
		flex: none;
		display: flex;
		gap: 6px;
		margin-top: -6px;
		padding: 8px 24px 14px;
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
	@media (max-width: 760px) {
		.srvbar {
			padding: 8px 16px 12px;
		}
	}
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
	.layout {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		border-top: 1px solid var(--border);
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
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
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
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	@media (max-width: 760px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
		}
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
			padding: 9px 12px;
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
		.body {
			padding: 16px 16px 24px;
		}
		.phead {
			display: none;
		}
	}
</style>
