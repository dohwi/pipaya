<script lang="ts">
	import { collapseIn, collapseOut } from "../../lib/motion";
	import { app, type ThemePref } from "../../lib/store.svelte";
	import { getLangPref, languageName, languages, msg, setLangPref, systemLang, t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import Segmented from "../Segmented.svelte";
	import SettingRow from "../SettingRow.svelte";
	import Switch from "../Switch.svelte";
	import NotificationSettings from "../NotificationSettings.svelte";
	import TerminalSettings from "../TerminalSettings.svelte";
	import UpdateSettings from "../UpdateSettings.svelte";

	/** The app-wide basics on this device: language, theme, zoom, notification sound, then the notification, terminal and update blocks. */
	const themes: { id: ThemePref; label: string; icon: "monitor" | "sun" | "moon" }[] = [
		{ id: "system", label: msg("시스템"), icon: "monitor" },
		{ id: "light", label: msg("라이트"), icon: "sun" },
		{ id: "dark", label: msg("다크"), icon: "moon" },
	];
	/** Language names stay in their own language so they can be found from any other. */
	const langOptions = $derived([{ tag: "system", name: t("시스템") }, ...languages()]);
</script>

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
			

<style>
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
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
</style>
