<script lang="ts">
	import { collapseIn, collapseOut } from "../../lib/motion";
	import { app, type ThemePref } from "../../lib/store.svelte";
	import { getLangPref, languageName, languages, msg, setLangPref, systemLang, t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import Button from "../Button.svelte";
	import RangeField from "../RangeField.svelte";
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
	<div class="section-label">{t("언어")}</div>
	<Segmented variant="cards" columns={3} label={t("언어")} value={getLangPref()} onchange={setLangPref} options={langOptions.map((l) => ({ id: l.tag, label: l.name, lang: l.tag === "system" ? undefined : l.tag }))} />
	{#if getLangPref() === "system"}
		<span class="hint" in:collapseIn out:collapseOut>{t("기기 언어를 따릅니다: {name}", { name: languageName(systemLang(navigator.languages)) })}</span>
	{/if}
</section>

<section>
	<div class="section-label">{t("테마")}</div>
	<Segmented variant="cards" label={t("테마")} value={app.prefs.theme} onchange={(id) => app.prefs.setTheme(id)} options={themes.map((th) => ({ id: th.id, label: t(th.label) }))}>
		{#snippet option(o)}<Icon name={themes.find((th) => th.id === o.id)!.icon} /> {o.label}{/snippet}
	</Segmented>
</section>

<section>
	<div class="section-label">{t("화면 배율")}</div>
	<RangeField label={t("배율")} ariaLabel={t("화면 배율")} min={50} max={200} step={10} value={app.prefs.uiScale} oninput={(v) => app.prefs.setUiScale(v)}>
		{#snippet trailing()}<Button size="sm" variant="ghost" disabled={app.prefs.uiScale === 100} onclick={() => app.prefs.setUiScale(100)}>{t("100%로")}</Button>{/snippet}
	</RangeField>
	<span class="hint">{t("단축키 Ctrl/⌘ + · − · 0")}</span>
</section>

<section>
	<div class="section-label">{t("알림음")}</div>
	<SettingRow label={t("소리 재생")} hint={t("작업 완료 · 확인 필요 · 실패 때. 보고 있는 대화는 승인 요청만 울립니다")}>
		<Switch checked={app.prefs.soundOn} label={t("알림음")} onchange={(on) => app.prefs.setSound(on)} />
	</SettingRow>
	<RangeField label={t("크기")} ariaLabel={t("알림음 크기")} min={0} max={200} step={5} value={app.prefs.soundVolume} disabled={!app.prefs.soundOn} oninput={(v) => app.prefs.setSoundVolume(v)} onchange={() => app.prefs.previewSound()} />
</section>
<section><NotificationSettings /></section>
<section><TerminalSettings /></section>
<section><UpdateSettings /></section>


<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
