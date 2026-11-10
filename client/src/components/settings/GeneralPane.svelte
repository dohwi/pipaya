<script lang="ts">
	import { app, type ThemePref } from "../../lib/store.svelte";
	import { getLangPref, languageName, languages, msg, setLangPref, systemLang, t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import Button from "../Button.svelte";
	import Select from "../Select.svelte";
	import RangeField from "../RangeField.svelte";
	import Segmented from "../Segmented.svelte";
	import SettingRow from "../SettingRow.svelte";
	import Switch from "../Switch.svelte";
	import NotificationSettings from "../NotificationSettings.svelte";
	import FooterSettings from "../FooterSettings.svelte";
	import TerminalSettings from "../TerminalSettings.svelte";
	import UpdateSettings from "../UpdateSettings.svelte";

	/** The app-wide basics on this device: language, theme, zoom, notification sound, then the notification, terminal and update blocks. */
	const themes: { id: ThemePref; label: string; icon: "monitor" | "sun" | "moon" }[] = [
		{ id: "light", label: msg("라이트"), icon: "sun" },
		{ id: "system", label: msg("시스템"), icon: "monitor" },
		{ id: "dark", label: msg("다크"), icon: "moon" },
	];
	/** Language names stay in their own language so they can be found from any other. */
	const langOptions = $derived([{ tag: "system", name: t("시스템") }, ...languages()]);
</script>

<section class="set-group">
	<div class="section-label">{t("화면")}</div>
	<SettingRow label={t("언어")} for="lang-pref" hint={getLangPref() === "system" ? t("기기 언어를 따릅니다: {name}", { name: languageName(systemLang(navigator.languages)) }) : undefined}>
		<Select id="lang-pref" size="sm" width="160px" value={getLangPref()} onchange={setLangPref} options={langOptions.map((l) => ({ value: l.tag, label: l.name }))} />
	</SettingRow>
	<SettingRow label={t("테마")}>
		<Segmented size="sm" full={false} label={t("테마")} value={app.prefs.theme} onchange={(id) => app.prefs.setTheme(id)} options={themes.map((th) => ({ id: th.id, label: t(th.label) }))}>
			{#snippet option(o)}<Icon name={themes.find((th) => th.id === o.id)!.icon} /> {o.label}{/snippet}
		</Segmented>
	</SettingRow>
	<div class="zoom">
		<div class="ztext"><span>{t("화면 배율")}</span><small class="hint">{t("단축키 Ctrl/⌘ + · − · 0")}</small></div>
		<RangeField label="" ariaLabel={t("화면 배율")} min={50} max={200} step={10} value={app.prefs.uiScale} oninput={(v) => app.prefs.setUiScale(v)}>
			{#snippet trailing()}<Button size="sm" variant="ghost" disabled={app.prefs.uiScale === 100} onclick={() => app.prefs.setUiScale(100)}>{t("100%로")}</Button>{/snippet}
		</RangeField>
	</div>
</section>

<section class="set-group"><NotificationSettings /></section>
<section class="set-group">
	<div class="section-label">{t("알림음")}</div>
	<SettingRow label={t("소리 재생")} hint={t("작업 완료 · 확인 필요 · 실패 때. 보고 있는 대화는 승인 요청만 울립니다")}>
		<Switch checked={app.prefs.soundOn} label={t("알림음")} onchange={(on) => app.prefs.setSound(on)} />
	</SettingRow>
	<RangeField label={t("크기")} ariaLabel={t("알림음 크기")} min={0} max={200} step={5} value={app.prefs.soundVolume} disabled={!app.prefs.soundOn} oninput={(v) => app.prefs.setSoundVolume(v)} onchange={() => app.prefs.previewSound()} alignAction />
</section>
<section class="set-group"><FooterSettings /></section>
<section class="set-group"><TerminalSettings /></section>
<section class="set-group"><UpdateSettings /></section>


<style>
	.zoom {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: var(--fs-md);
		line-height: 20px;
	}
	/* the row's own label sits above, so the slider's empty name column (and its 12px gap) goes away: the track starts on the label's line */
	.zoom :global(.range .name) {
		display: none;
	}
	.ztext {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.ztext .hint {
		line-height: 16px;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 12px; /* rows with a hint line no longer touch the next row */
	}
	/* a block with nothing to show (app updates on the web) leaves no empty card */
	section:empty {
		display: none;
	}
	/* every block's title line is as tall as the ones that carry a button (34px), so the first row starts at the same distance in every card */
	section > :global(.section-label),
	section > :global(.head) {
		display: flex;
		align-items: center;
		min-height: var(--control-h-sm);
	}
	section > :global(.head) {
		justify-content: space-between;
	}
</style>
