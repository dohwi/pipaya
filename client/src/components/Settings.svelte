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
	import NotificationSettings from "./NotificationSettings.svelte";
	import UpdateSettings from "./UpdateSettings.svelte";
	import TerminalSettings from "./TerminalSettings.svelte";
	import { app, type ThemePref } from "../lib/store.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";
	import { Api, errorText } from "../lib/api";
	import type { ToolsInfo } from "../lib/types";
	import { getLangPref, languageName, languages, msg, setLangPref, systemLang, t, tc } from "../lib/i18n";

	// What each tool lets the agent do. Names without a case show as-is (tools added by extensions).
	function toolLabel(name: string): string {
		switch (name) {
			case "read": return t("파일 읽기 (read)");
			case "write": return t("파일 만들기 · 덮어쓰기 (write)");
			case "edit": return t("파일 일부 수정 (edit)");
			case "ls": return t("폴더 목록 (ls)");
			case "grep": return t("내용 검색 (grep)");
			case "bash": return t("셸 명령 실행 (bash)");
			default: return name;
		}
	}

	// App.svelte mounts this only while open, so the tab requested at open time is read once.
	// svelte-ignore state_referenced_locally
	let tab = $state<string>(app.settingsTab === "servers" ? "info" : app.settingsTab);

	/** Settings follow the open server: its own sections (`server: true`) sit between the app-wide ones. */
	const tabs = [
		{ id: "general", label: msg("일반"), icon: "settings", sub: msg("언어 · 테마 · 알림 · 터미널"), server: false },
		{ id: "keys", label: msg("단축키"), icon: "keyboard", sub: msg("키 지정과 초기화"), server: false },
		{ id: "info", label: msg("정보"), icon: "server", sub: "", server: true },
		{ id: "workdir", label: msg("기본 폴더"), icon: "folder", sub: "", server: true },
		{ id: "models", label: msg("모델 연결"), icon: "key", sub: "", server: true },
		{ id: "tools", label: msg("에이전트 도구"), icon: "shield", sub: "", server: true },
		{ id: "sessions", label: msg("대화"), icon: "chat", sub: "", server: true },
		{ id: "srvext", label: msg("서버 확장"), icon: "bolt", sub: msg("이 서버의 모든 기기가 함께 씁니다"), server: true },
		{ id: "devices", label: msg("기기"), icon: "phone", sub: "", server: true },
		{ id: "extensions", label: msg("클라이언트 확장"), icon: "bolt", sub: msg("이 기기의 확장 · 안전 모드"), server: false },
		{ id: "backup", label: msg("백업"), icon: "download", sub: msg("설정 내보내기 · 가져오기"), server: false },
	] as const;
	type TabId = (typeof tabs)[number]["id"];
	/** Which side the next pane enters from, so content follows the selection. */
	let dir = $state(1);
	/** The extension open in the "확장" panes; the sidebar lists them under their section. */
	let extId = $state<string | null>(null);
	/** Sections whose extensions the user folded away in the sidebar; everything starts unfolded. */
	let collapsed = $state<Record<string, boolean>>({});
	const extScope = (id: string) => (id === "extensions" ? "device" : id === "srvext" ? "server" : null);
	const extsOf = (id: string) => { const sc = extScope(id); return sc ? extensions.installed.filter((e) => e.scope === sc) : []; };
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

	/* ---------- agent tools: read from and saved to the chosen server only ---------- */
	let toolsCfg = $state<{ id: string; tools: ToolsInfo | null } | null>(null);
	let toolsError = $state("");
	const apiOf = (id: string) => {
		const s = app.servers.find((x) => x.id === id);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	};
	$effect(() => {
		void app.configTick;
		if (tab !== "tools" || !server) return;
		const id = server.id;
		toolsError = "";
		apiOf(id)
			?.configuration()
			.then((c) => (toolsCfg = { id, tools: c.tools ?? null }))
			.catch((e) => (toolsError = errorText(e)));
	});
	const shownCfg = $derived(toolsCfg && server && toolsCfg.id === server.id ? toolsCfg : null);
	async function saveTool(name: string, on: boolean) {
		if (!server || !shownCfg?.tools) return;
		const before = shownCfg;
		const disabled = on ? before.tools!.disabled.filter((n) => n !== name) : [...new Set([...before.tools!.disabled, name])];
		toolsCfg = { ...before, tools: { ...before.tools!, disabled } };
		try {
			toolsCfg = { ...before, tools: await apiOf(server.id)!.setDisabledTools(disabled) };
		} catch (e) {
			toolsCfg = before;
			toolsError = errorText(e);
		}
	}

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
	type Hit = { key: string; title: string; where: string; combo?: string; open(): void };
	/** Settings that are not a tab of their own; the words are what a person may type for them. */
	const items: { tab: TabId; label: string; words: string }[] = [
		{ tab: "general", label: msg("언어"), words: "language 한국어 english" },
		{ tab: "general", label: msg("테마"), words: "theme dark light 다크 라이트 어둡게 밝게" },
		{ tab: "tools", label: msg("에이전트 도구"), words: "tools agent permission 도구 에이전트" },
		{ tab: "general", label: msg("화면 배율"), words: "zoom scale size 배율 확대 축소 크기" },
		{ tab: "general", label: msg("알림음"), words: "sound volume notification 소리 볼륨 크기 알림" },
		{ tab: "general", label: msg("터미널"), words: "terminal font size 글꼴 폰트 글자 크기 maple mono" },
		{ tab: "general", label: msg("앱 단축키 우선"), words: "terminal shortcut priority keybinding 터미널 단축키 우선 먹히지" },
		{ tab: "general", label: msg("업데이트"), words: "update version 버전" },
	];
	const norm = (s: string) => s.toLowerCase();
	const words = $derived(norm(query).split(/\s+/).filter(Boolean));
	const hit = (text: string) => words.every((w) => norm(text).includes(w));
	const hits = $derived.by<Hit[]>(() => {
		if (!words.length) return [];
		const out: Hit[] = [];
		const tabName = (id: TabId) => t(tabs.find((x) => x.id === id)!.label);
		for (const x of tabs) {
			if (x.server && !server) continue;
			if (hit(`${t(x.label)} ${x.label} ${x.sub ? t(x.sub) : ""}`)) out.push({ key: `tab:${x.id}`, title: t(x.label), where: x.sub ? t(x.sub) : t("설정"), open: () => go(x.id) });
		}
		for (const x of items) {
			if (hit(`${t(x.label)} ${x.label} ${x.words}`)) out.push({ key: `item:${x.label}`, title: t(x.label), where: tabName(x.tab), open: () => go(x.tab) });
		}
		for (const a of ACTIONS) {
			const combo = app.prefs.bindings[a.id];
			if (hit(`${t(a.label)} ${a.label} ${a.hint ? t(a.hint) : ""} ${combo} ${formatCombo(combo)}`))
				out.push({ key: `key:${a.id}`, title: t(a.label), where: tabName("keys"), combo: formatCombo(combo), open: () => { keyFilter = t(a.label); go("keys"); } });
		}
		return out;
	});
	function pick(h: Hit) {
		h.open();
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
				{#if needsUpdate(s.id)}<span class="updot" role="img" aria-label={t("업데이트 필요")} title={t("업데이트 필요")}></span>{/if}
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
							<button type="button" class="fold" aria-expanded={open} aria-label={open ? t("하위 항목 접기") : t("하위 항목 펼치기")} onclick={() => (collapsed[x.id] = open)}><Icon name="chevron-down" /></button>
						{/if}
					</div>
					{#if open}
						<div class="tree" role="group" aria-label={t(x.label)}>
							{#each kids as e (e.package.manifest.id)}
								{@const eid = e.package.manifest.id}
								<button role="tab" class="sub" aria-selected={extId === eid} tabindex={extId === eid ? 0 : -1} class:on={extId === eid} onclick={() => openExt(x.id, eid)}>
									<span class="nl">{e.package.manifest.name}</span>
									<span class="dot" class:live={e.state === "active" || e.state === "starting"} role="img" aria-label={e.state === "active" || e.state === "starting" ? t("실행 중") : t("꺼짐")}></span>
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
			{:else if tab === "tools"}
		<section>
			<div class="mono-label">{t("에이전트 도구")}</div>
			{#if shownCfg?.tools}
				{@const info = shownCfg.tools}
				{#each info.toggleable as name (name)}
					<SettingRow label={toolLabel(name)}>
						<Switch checked={!info.disabled.includes(name)} label={name} onchange={(on) => saveTool(name, on)} />
					</SettingRow>
				{/each}
				{#each info.locked as name (name)}
					<SettingRow label={toolLabel(name)} dim>
						<Switch checked disabled label={name} onchange={() => {}} />
					</SettingRow>
				{/each}
			{/if}
			{#if toolsError}<span class="hint danger">{toolsError}</span>{/if}
			<span class="hint">{t("끄면 해당 도구를 에이전트에게 주지 않습니다. 서버에 저장되어 모든 대화에 적용됩니다. 잠긴 도구는 끌 수 없습니다.")}</span>
		</section>
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
	.hint {
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.hint.danger {
		color: var(--danger);
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
	}
	.updot {
		position: absolute;
		top: -3px;
		right: -2px;
		z-index: 1;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--warn);
		box-shadow: 0 0 0 2px var(--bg-elev, var(--bg));
		pointer-events: none;
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
	.nav button.fold[aria-expanded="false"] :global(svg) {
		transform: rotate(-90deg);
	}
	/* a thin trunk from the parent's icon, with a rounded elbow into each child */
	.nav .tree {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0 0 4px 21px;
		padding-left: 18px;
	}
	.nav .tree::before {
		content: "";
		position: absolute;
		left: 0;
		top: -2px;
		bottom: 18px;
		border-left: 1.5px solid var(--border-strong);
	}
	.nav button.sub {
		position: relative;
		justify-content: space-between;
		gap: 8px;
		padding: 7px 10px;
	}
	.nav button.sub::before {
		content: "";
		position: absolute;
		left: -18px;
		top: 0;
		width: 14px;
		height: 50%;
		border-left: 1.5px solid var(--border-strong);
		border-bottom: 1.5px solid var(--border-strong);
		border-bottom-left-radius: 8px;
		pointer-events: none;
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
		}
		.nav button {
			flex: 1 0 auto;
			justify-content: center;
			gap: 8px;
			padding: 9px 12px;
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
