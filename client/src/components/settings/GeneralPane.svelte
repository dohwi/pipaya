<script lang="ts">
	import { app, type ThemePref } from "../../lib/store.svelte";
	import { formatCombo, isMac } from "../../lib/keys";
	import { getLangPref, languageName, languages, msg, setLangPref, systemLang, t } from "../../lib/i18n";
	import type { ReducedMotionPref, RunningEnterMode, SendKeyMode, SessionOpenMode } from "../../lib/ux-prefs";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import Select from "../ui/Select.svelte";
	import RangeField from "../ui/RangeField.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import SettingRow from "../ui/SettingRow.svelte";
	import Switch from "../ui/Switch.svelte";
	import NotificationSettings from "./NotificationSettings.svelte";
	import FooterSettings from "./FooterSettings.svelte";
	import TerminalSettings from "../terminal/TerminalSettings.svelte";
	import UpdateSettings from "./UpdateSettings.svelte";

	/** The app-wide basics on this device: language, theme, zoom, notification sound, then the notification, terminal and update blocks. */
	const themes: { id: ThemePref; label: string; icon: "monitor" | "sun" | "moon" }[] = [
		{ id: "light", label: msg("라이트"), icon: "sun" },
		{ id: "system", label: msg("시스템"), icon: "monitor" },
		{ id: "dark", label: msg("다크"), icon: "moon" },
	];
	/** Language names stay in their own language so they can be found from any other. */
	const workKey = $derived(formatCombo(app.prefs.bindings.toggleWorkExpand));
	const workHint = $derived(
		workKey
			? t("답변 속 도구 호출을 한 줄 요약 대신 모두 펼쳐 보여 줍니다. 단축키 {key}", { key: workKey })
			: t("답변 속 도구 호출을 한 줄 요약 대신 모두 펼쳐 보여 줍니다"),
	);
	const langOptions = $derived([{ tag: "system", name: t("시스템") }, ...languages()]);
	const mod = isMac ? "⌘" : "Ctrl";
	const modEnterLabel = formatCombo("Mod+Enter");
	const sessionOpenOptions = $derived<{ id: SessionOpenMode; label: string }[]>([
		{ id: "peek", label: t("미리 보기") },
		{ id: "open", label: t("바로 이동") },
	]);
	const reducedMotionOptions = $derived<{ id: ReducedMotionPref; label: string }[]>([
		{ id: "system", label: t("시스템") },
		{ id: "on", label: t("항상") },
	]);
	const sendKeyOptions = $derived<{ id: SendKeyMode; label: string }[]>([
		{ id: "enter", label: "Enter" },
		{ id: "mod-enter", label: modEnterLabel },
	]);
	const runningEnterOptions = $derived<{ id: RunningEnterMode; label: string }[]>([
		{ id: "steer", label: t("끼워 넣기") },
		{ id: "queue", label: t("대기열") },
	]);
	const queueComboLabel = $derived(formatCombo(app.prefs.bindings.queueMessage ?? ""));
	const runningEnterHint = $derived.by(() => {
		const primary = app.prefs.sendKey === "mod-enter" ? modEnterLabel : "Enter";
		return queueComboLabel
			? t("작업 중 {key}를 눌렀을 때의 기본 동작입니다. 반대 동작은 {alt}(으)로 실행합니다", { key: primary, alt: queueComboLabel })
			: t("작업 중 {key}를 눌렀을 때의 기본 동작입니다", { key: primary });
	});
</script>

<section class="set-group">
	<div class="section-label">{t("화면")}</div>
	<SettingRow label={t("언어")} for="lang-pref" hint={getLangPref() === "system" ? t("기기 언어를 따릅니다: {name}", { name: languageName(systemLang(navigator.languages)) }) : undefined}>
		<Select id="lang-pref" size="sm" width="160px" value={getLangPref()} onchange={setLangPref} options={langOptions.map((l) => ({ value: l.tag, label: l.name }))} />
	</SettingRow>
	<SettingRow label={t("테마")}>
		<Segmented size="sm" full={false} label={t("테마")} value={app.prefs.theme} onchange={(id) => app.prefs.setTheme(id)} options={themes.map((th) => ({ id: th.id, label: t(th.label) }))}>
			{#snippet option(o)}<span class="topt"><Icon name={themes.find((th) => th.id === o.id)!.icon} />{o.label}</span>{/snippet}
		</Segmented>
	</SettingRow>
	<div class="zoom">
		<div class="ztext"><span>{t("화면 배율")}</span><small class="hint">{t("단축키 Ctrl/⌘ + · − · 0")}</small></div>
		<RangeField label="" ariaLabel={t("화면 배율")} min={50} max={200} step={10} value={app.prefs.uiScale} oninput={(v) => app.prefs.setUiScale(v)}>
			{#snippet trailing()}<Button size="sm" disabled={app.prefs.uiScale === 100} onclick={() => app.prefs.setUiScale(100)}>{t("100%로")}</Button>{/snippet}
		</RangeField>
	</div>
	<SettingRow label={t("작업 내역 펼쳐 두기")} hint={workHint}>
		<Switch checked={app.prefs.expandWork} label={t("작업 내역 펼쳐 두기")} onchange={(on) => app.prefs.setExpandWork(on)} />
	</SettingRow>
	<SettingRow label={t("동작 줄이기")} hint={t("그래프 흐름 애니메이션과 화면 전환 효과를 줄입니다")}>
		<Segmented size="sm" full={false} label={t("동작 줄이기")} value={app.prefs.reducedMotion} onchange={(id) => app.prefs.setReducedMotion(id)} options={reducedMotionOptions} />
	</SettingRow>
</section>

<section class="set-group">
	<div class="section-label">{t("세션 열기")}</div>
	<SettingRow label={t("@멘션 클릭")} hint={t("대화 속 @세션 태그를 눌렀을 때 동작입니다. 반대 동작은 {mod}+클릭, 닫힌 대화는 항상 기록 미리 보기로 열립니다", { mod })}>
		<Segmented size="sm" full={false} label={t("@멘션 클릭")} value={app.prefs.mentionClick} onchange={(id) => app.prefs.setMentionClick(id)} options={sessionOpenOptions} />
	</SettingRow>
	<SettingRow label={t("그래프에서 세션 클릭")} hint={t("그래프 뷰 카드나 상세 목록에서 세션을 눌렀을 때 동작입니다. 반대 동작은 {mod}+클릭(키보드는 Shift+Enter)", { mod })}>
		<Segmented size="sm" full={false} label={t("그래프에서 세션 클릭")} value={app.prefs.graphClick} onchange={(id) => app.prefs.setGraphClick(id)} options={sessionOpenOptions} />
	</SettingRow>
	<SettingRow label={t("완료 알림 클릭")} hint={t("화면 위 완료·실패 알림을 눌렀을 때 동작입니다. 반대 동작은 {mod}+클릭", { mod })}>
		<Segmented size="sm" full={false} label={t("완료 알림 클릭")} value={app.prefs.noticeClick} onchange={(id) => app.prefs.setNoticeClick(id)} options={sessionOpenOptions} />
	</SettingRow>
	<SettingRow label={t("멘션 미리 보기 카드")} hint={t("@세션 태그에 마우스를 올리면 상태와 최근 내용을 작은 카드로 보여 줍니다")}>
		<Switch checked={app.prefs.mentionHover} label={t("멘션 미리 보기 카드")} onchange={(on) => app.prefs.setMentionHover(on)} />
	</SettingRow>
</section>

<section class="set-group">
	<div class="section-label">{t("입력")}</div>
	<SettingRow label={t("보내기 키")} hint={app.prefs.sendKey === "mod-enter" ? t("데스크톱에서 {key}로 보내고, Enter는 줄바꿈으로 사용합니다", { key: modEnterLabel }) : t("데스크톱에서 Enter로 보내고, Shift+Enter로 줄바꿈합니다")}>
		<Segmented size="sm" full={false} label={t("보내기 키")} value={app.prefs.sendKey} onchange={(id) => app.prefs.setSendKey(id)} options={sendKeyOptions} />
	</SettingRow>
	<SettingRow label={t("실행 중 보내기")} hint={runningEnterHint}>
		<Segmented size="sm" full={false} label={t("실행 중 보내기")} value={app.prefs.runningEnter} onchange={(id) => app.prefs.setRunningEnter(id)} options={runningEnterOptions} />
	</SettingRow>
	<SettingRow label={t("길게 눌러 바로 대기열에 넣기")} hint={t("모바일에서 작업 중일 때 전송 버튼을 길게 누르면 선택 창 없이 바로 대기열에 넣습니다. 끄면 끼워 넣기·대기열 선택 창이 열립니다")}>
		<Switch checked={app.prefs.holdToQueue} label={t("길게 눌러 바로 대기열에 넣기")} onchange={(on) => app.prefs.setHoldToQueue(on)} />
	</SettingRow>
</section>

<section class="set-group"><NotificationSettings /></section>
<section class="set-group">
	<div class="section-label">{t("알림음")}</div>
	<SettingRow label={t("소리 재생")} hint={t("작업 완료 · 확인 필요 · 실패, 음성 녹음 시작·종료 때. 보고 있는 대화는 승인 요청만 울립니다")}>
		<Switch checked={app.prefs.soundOn} label={t("알림음")} onchange={(on) => app.prefs.setSound(on)} />
	</SettingRow>
	<RangeField label={t("크기")} ariaLabel={t("알림음 크기")} min={0} max={200} step={5} value={app.prefs.soundVolume} disabled={!app.prefs.soundOn} oninput={(v) => app.prefs.setSoundVolume(v)} onchange={() => app.prefs.previewSound()} alignAction />
</section>
<section class="set-group"><FooterSettings /></section>
<section class="set-group"><TerminalSettings /></section>
<section class="set-group"><UpdateSettings /></section>


<style>
	/* theme option: icon and label as one centred row (an inline svg sat on the text's baseline, its ink 1.5px above the
	   label's); the 4px is the icon-label gap inside a control */
	.topt {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
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
