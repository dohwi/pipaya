<script lang="ts">
	import type { ApprovalPolicy } from "../lib/types";
	import { paneIn } from "../lib/motion";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { rovingKeys } from "../lib/roving";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import ModalHeader from "./ModalHeader.svelte";
	import Shortcuts from "./Shortcuts.svelte";
	import Extensions from "./Extensions.svelte";
	import Backup from "./Backup.svelte";
	import ServerForm from "./ServerForm.svelte";
	import Switch from "./Switch.svelte";
	import NotificationSettings from "./NotificationSettings.svelte";
	import UpdateSettings from "./UpdateSettings.svelte";
	import { app, type ThemePref } from "../lib/store.svelte";
	import { getLangPref, languageName, languages, msg, setLangPref, systemLang, t, tc } from "../lib/i18n";

	// App.svelte mounts this only while open, so the tab requested at open time is read once.
	// svelte-ignore state_referenced_locally
	let tab = $state<string>(app.settingsTab === "servers" ? "info" : app.settingsTab);

	/** Settings follow the open server: its own sections (`server: true`) sit between the app-wide ones. */
	const tabs = [
		{ id: "general", label: msg("일반"), icon: "settings", sub: msg("언어 · 테마 · 도구 승인 · 알림음"), server: false },
		{ id: "keys", label: msg("단축키"), icon: "keyboard", sub: msg("키 지정과 초기화"), server: false },
		{ id: "info", label: msg("정보"), icon: "server", sub: "", server: true },
		{ id: "workdir", label: msg("기본 폴더"), icon: "folder", sub: "", server: true },
		{ id: "models", label: msg("모델 연결"), icon: "key", sub: "", server: true },
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
	const server = $derived(app.servers.find((s) => s.id === app.serverId) ?? null);
	const serverName = $derived(server ? app.serverLabel(server) : "");
	// without a server there is nothing server-specific left to show
	$effect(() => {
		if (!server && current.server) tab = "general";
	});

	const approvals: { id: ApprovalPolicy; label: string; hint: string }[] = [
		{ id: "ask", label: msg("확인", "approval"), hint: msg("파일 수정과 명령 실행 전에 확인합니다.") },
		{ id: "auto", label: msg("자동", "approval"), hint: msg("묻지 않고 모두 실행합니다.") },
		{ id: "readonly", label: msg("읽기 전용", "approval"), hint: msg("변경을 일으키는 작업을 모두 막습니다.") },
	];
	const themes: { id: ThemePref; label: string; icon: "monitor" | "sun" | "moon" }[] = [
		{ id: "system", label: msg("시스템"), icon: "monitor" },
		{ id: "light", label: msg("라이트"), icon: "sun" },
		{ id: "dark", label: msg("다크"), icon: "moon" },
	];
	/** Language names stay in their own language so they can be found from any other. */
	const langOptions = $derived([{ tag: "system", name: t("시스템") }, ...languages()]);

	const close = () => (app.settingsOpen = false);
</script>

<Modal onclose={close} label={t("설정")} width="920px" height="700px" maxHeight="700px" gutter="48px" safeArea>
	<ModalHeader title={t("설정")} onclose={close}>
		{#snippet titleExtra()}{#if serverName}<span class="hsrv"> · {serverName}</span>{/if}{/snippet}
	</ModalHeader>

	<div class="layout">
		<!-- desktop: a column on the left; phone: a row of tabs above the content -->
		<div
			class="nav"
			role="tablist"
			aria-label={t("설정 구역")}
			use:slidingIndicator={{ selector: "button.on", variant: "fill", radius: "var(--radius)" }}
			use:rovingKeys={{ item: '[role="tab"]', axis: "both" }}
		>
			{#each tabs as x, i (x.id)}
				{#if !x.server || server}
					{#if x.server && !tabs[i - 1].server}<div class="ngroup" role="presentation">{serverName}</div>{/if}
					{#if !x.server && tabs[i - 1]?.server}<div class="nsep" role="presentation"></div>{/if}
					<button role="tab" class:srv={x.server} aria-selected={tab === x.id} tabindex={tab === x.id ? 0 : -1} class:on={tab === x.id} onclick={() => go(x.id)}>
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
				<Shortcuts />
			{:else if tab === "general"}
				<section>
					<div class="label">{t("언어")}</div>
					<div class="themes" role="group" aria-label={t("언어")} use:slidingIndicator={{ selector: ".theme.on", variant: "outline", radius: "var(--radius)" }}>
						{#each langOptions as l (l.tag)}
							<button class="theme" class:on={getLangPref() === l.tag} aria-pressed={getLangPref() === l.tag} lang={l.tag === "system" ? undefined : l.tag} onclick={() => setLangPref(l.tag)}>
								{l.name}
							</button>
						{/each}
					</div>
					{#if getLangPref() === "system"}
						<span class="hint">{t("기기 언어를 따릅니다: {name}", { name: languageName(systemLang(navigator.languages)) })}</span>
					{/if}
				</section>

				<section>
					<div class="label">{t("테마")}</div>
					<div class="themes" role="group" aria-label={t("테마")} use:slidingIndicator={{ selector: ".theme.on", variant: "outline", radius: "var(--radius)" }}>
						{#each themes as th}
							<button class="theme" class:on={app.prefs.theme === th.id} aria-pressed={app.prefs.theme === th.id} onclick={() => app.prefs.setTheme(th.id)}>
								<Icon name={th.icon} /> {t(th.label)}
							</button>
						{/each}
					</div>
				</section>

				<section>
					<div class="label">{t("도구 승인")}</div>
					<div class="themes" role="group" aria-label={t("도구 승인")} use:slidingIndicator={{ selector: ".theme.on", variant: "outline", radius: "var(--radius)" }}>
						{#each approvals as a}
							<button class="theme" class:on={app.effective.approval === a.id} aria-pressed={app.effective.approval === a.id} onclick={() => app.configure({ approval: a.id })}>{tc("approval", a.label)}</button>
						{/each}
					</div>
					<span class="hint">
						{t(approvals.find((a) => a.id === app.effective.approval)?.hint ?? "")}
						{app.current ? t("열려 있는 대화에만 적용됩니다.") : t("앞으로 시작할 새 대화에 적용됩니다.")}
					</span>
				</section>

				<section>
					<div class="label">{t("알림음")}</div>
					<div class="switch">
						<span>{t("작업 완료 · 확인 필요 · 실패 때 소리 재생")}</span>
						<Switch checked={app.prefs.soundOn} label={t("알림음")} onchange={(on) => app.prefs.setSound(on)} />
					</div>
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
				<section><UpdateSettings /></section>
			{:else if current.server && server}
				{#key server.id}<ServerForm target={server.id} embedded section={current.id as "info"} />{/key}
			{/if}
			</div>
			{/key}
		</div>
	</div>
</Modal>

<style>
	.switch {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		font-size: var(--fs-md);
		line-height: 1.4;
	}
	.volume {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: var(--fs-md);
		line-height: 1.4;
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
	.hsrv {
		font-weight: 500;
		color: var(--text-dim);
	}
	.ngroup {
		padding: 10px 12px 4px;
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		letter-spacing: 0.04em;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nsep {
		height: 1px;
		margin: 8px 12px;
		background: var(--border);
	}
	.nav button.addsrv {
		gap: 8px;
		padding: 7px 12px;
		font-size: var(--fs-sm);
		color: var(--text-faint);
	}
	.nav button.srv {
		padding: 8px 12px;
	}
	@media (max-width: 760px) {
		.ngroup,
		.nsep {
			display: none;
		}
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
	.label {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 500;
		letter-spacing: 0.04em;
		color: var(--text-faint);
	}
	.themes {
		position: relative;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}
	.theme {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 44px;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		background: var(--bg-elev);
		transition:
			border-color var(--motion-fast) var(--ease-std),
			background var(--motion-fast) var(--ease-std);
	}
	.theme.on {
		border-color: var(--text);
		background: var(--bg-active);
		font-weight: 600;
	}
	/* the sliding ring (drawn over the card) replaces the card's own border; the fill still cross-fades */
	.themes:global([data-indicator-ready]) .theme.on {
		border-color: var(--border);
	}
	/* "Auto" runs everything unasked, so it is always tinted as a warning */
	.theme :global(svg) {
		width: 17px;
		height: 17px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.srv {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 8px 8px 14px;
		background: var(--bg-elev);
		border-bottom: 1px solid var(--border);
	}
	.srv:last-child {
		border-bottom: 0;
	}
	.srv > :global(svg) {
		flex: none;
		width: 17px;
		height: 17px;
		stroke: var(--text-dim);
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
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
