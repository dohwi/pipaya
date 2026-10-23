<script lang="ts">
	import type { ApprovalMode } from "../lib/types";
	import { approvalMode } from "../lib/store-model";
	import { collapseIn, collapseOut, fadeIn, paneIn } from "../lib/motion";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { ACTIONS, formatCombo } from "../lib/keys";
	import { rovingKeys } from "../lib/roving";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import ModalHeader from "./ModalHeader.svelte";
	import Shortcuts from "./Shortcuts.svelte";
	import Extensions from "./Extensions.svelte";
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
	import { getLangPref, languageName, languages, msg, setLangPref, systemLang, t, tc } from "../lib/i18n";

	// What each tool lets the agent do. Names without a case show as-is (tools added by extensions).
	function toolLabel(name: string): string {
		switch (name) {
			case "ask_user": return t("사용자에게 질문하고 답을 기다림 (ask_user)");
			case "delegate": return t("하위 에이전트에게 조사 위임 (delegate)");
			case "peer_send": return t("다른 대화에 메시지 보내기 (peer_send)");
			case "peer_read": return t("다른 대화의 최근 내용 읽기 (peer_read)");
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
		{ id: "tools", label: msg("도구 승인"), icon: "shield", sub: "", server: true },
		{ id: "agents", label: msg("에이전트"), icon: "brain", sub: "", server: true },
		{ id: "sessions", label: msg("대화"), icon: "chat", sub: "", server: true },
		{ id: "devices", label: msg("기기"), icon: "phone", sub: "", server: true },
		{ id: "extensions", label: msg("확장"), icon: "bolt", sub: msg("가져오기와 관리"), server: false },
		{ id: "backup", label: msg("백업"), icon: "download", sub: msg("설정 내보내기 · 가져오기"), server: false },
	] as const;
	type TabId = (typeof tabs)[number]["id"];
	/** Which side the next pane enters from, so content follows the selection. */
	let dir = $state(1);
	function go(next: TabId) {
		if (next === tab) return;
		dir = tabs.findIndex((x) => x.id === next) > tabs.findIndex((x) => x.id === tab) ? 1 : -1;
		tab = next;
	}
	const current = $derived(tabs.find((x) => x.id === tab) ?? tabs[0]);
	/** The chips above split the sections: "공통" shows the app-wide ones, a server chip shows that server's own. */
	const scoped = $derived(tabs.filter((x) => x.server === current.server));
	function showCommon() {
		if (current.server) go("general");
	}
	function showServer(id: string) {
		if (id !== app.serverId) app.openServer(id);
		if (!current.server) go("info");
	}
	const server = $derived(app.servers.find((s) => s.id === app.serverId) ?? null);
	// without a server there is nothing server-specific left to show
	$effect(() => {
		if (!server && current.server) tab = "general";
	});

	const approvals: { id: ApprovalMode; label: string; hint: string; tone?: "danger" | "warn" }[] = [
		{ id: "ask", label: msg("프로젝트 밖만 확인", "approval"), hint: msg("프로젝트 폴더 밖의 파일을 고치거나, 밖의 경로를 건드리는 명령을 실행할 때만 확인합니다.") },
		{ id: "auto", label: msg("자동", "approval"), hint: msg("묻지 않고 모두 실행합니다."), tone: "danger" },
	];
	const approval = $derived(approvalMode(app.draft.approval));
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
		{ tab: "tools", label: msg("도구 승인"), words: "approval auto ask permission 승인 자동 확인" },
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
		<FilterChip on={!current.server} title={t("모든 서버에 공통인 설정")} onclick={showCommon}>{t("공통")}</FilterChip>
		{#each app.servers as s (s.id)}
			<FilterChip on={current.server && s.id === app.serverId} title={app.serverLabel(s)} onclick={() => showServer(s.id)}><span class="srvname">{app.serverLabel(s)}</span></FilterChip>
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
					<button role="tab" class:srvtab={x.server} aria-selected={tab === x.id} tabindex={tab === x.id ? 0 : -1} class:on={tab === x.id} onclick={() => go(x.id)}>
						<Icon name={x.icon} />
						<span class="nt">
							<span class="nl">{t(x.label)}</span>
							{#if x.sub}<span class="ns">{t(x.sub)}</span>{/if}
						</span>
					</button>
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
			{#key tab + (current.server ? app.serverId : "")}
			<div class="pane" role="tabpanel" in:paneIn={{ x: dir * 18 }}>
			<div class="phead">
				<h3>{t(current.label)}</h3>
				{#if current.sub}<p>{t(current.sub)}</p>{/if}
			</div>
			{#if tab === "extensions"}
				<Extensions />
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
			<div class="mono-label">{t("도구 승인")}</div>
			<Segmented variant="cards" label={t("도구 승인")} value={approval} onchange={(id) => app.setApprovalMode(id)} options={approvals.map((a) => ({ id: a.id, label: tc("approval", a.label), tone: a.tone }))} />
			<span class="hint" class:danger={approvals.find((a) => a.id === approval)?.tone === "danger"}>
				{t(approvals.find((a) => a.id === approval)?.hint ?? "")}
				{t("서버에 저장되어 앞으로 시작할 모든 새 대화에 적용됩니다.")}
			</span>
		</section>

		<section>
			<div class="mono-label">{t("에이전트 도구")}</div>
			{#if app.toolsInfo}
				{#each app.toolsInfo.toggleable as name (name)}
					<SettingRow label={toolLabel(name)}>
						<Switch checked={!app.toolsInfo.disabled.includes(name)} label={name} onchange={(on) => app.setToolEnabled(name, on)} />
					</SettingRow>
				{/each}
				{#each app.toolsInfo.locked as name (name)}
					<SettingRow label={toolLabel(name)} dim>
						<Switch checked disabled label={name} onchange={() => {}} />
					</SettingRow>
				{/each}
			{:else}
				<SettingRow label={t("에이전트가 진행 중에 사용자에게 질문하고 답을 기다립니다")}>
					<Switch checked={app.askUserEnabled} label={t("질문 허용")} onchange={(on) => app.setAskUser(on)} />
				</SettingRow>
			{/if}
			<span class="hint">{t("끄면 해당 도구를 에이전트에게 주지 않습니다. 질문을 끄면 묻지 않고 가정하고 진행합니다. 서버에 저장되어 모든 대화에 적용됩니다. 잠긴 도구는 끌 수 없습니다.")}</span>
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
		margin-top: -4px;
		padding: 4px 22px 12px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.srvbar::-webkit-scrollbar {
		display: none;
	}
	.srvname {
		min-width: 0;
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	@media (max-width: 760px) {
		.srvbar {
			padding: 4px 14px 10px;
		}
	}
	.nav button.addsrv {
		gap: 8px;
		padding: 7px 12px;
		font-size: var(--fs-sm);
		color: var(--text-faint);
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
		.body {
			padding: 16px 16px 24px;
		}
		.phead {
			display: none;
		}
	}
</style>
