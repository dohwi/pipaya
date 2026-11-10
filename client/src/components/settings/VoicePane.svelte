<script lang="ts">
	import Button from "../Button.svelte";
	import Notice from "../Notice.svelte";
	import SettingRow from "../SettingRow.svelte";
	import Switch from "../Switch.svelte";
	import { t, getLang } from "../../lib/i18n";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { voice } from "../../lib/voice.svelte";
	import type { VoiceSettings } from "../../lib/api";

	/**
	 * Settings > Voice. The connection lives on the server (so every device shares it) and the key is written once and
	 * never read back. The microphone button in the composer appears only when voice input is on and the connection test
	 * passed; this page is where the user turns it on, fixes it and tests it.
	 *
	 * The page reads in the order the setup happens: switch it on, fill the connection top to bottom (address, model,
	 * key, then the optional path and language), then check it. The status block at the bottom only reports.
	 */
	let draft = $state<VoiceSettings>({ enabled: false, baseUrl: "", path: "", model: "", language: "" });
	let key = $state("");
	let keyTouched = $state(false);
	let saving = $state(false);
	let message = $state<{ ok: boolean; text: string } | null>(null);

	// The server's settings arrive after the first render (and again when the server changes).
	$effect(() => {
		if (!voice.loaded) return;
		draft = { ...voice.settings };
		key = "";
		keyTouched = false;
	});

	/** The old microphone extension, if it is installed: two microphones with two settings would confuse anyone. */
	const oldExtension = $derived(extensions.installed.find((e) => e.package.manifest.id === "voice-input") ?? null);

	/** Nothing set up yet: the placeholders then carry the whole example, so the first visit says what to type. */
	const firstRun = $derived(!voice.settings.baseUrl && !voice.settings.model && !voice.hasKey);

	/** The language the UI is in, as the hint a person most likely wants ("ko" for Korean). Only a placeholder, never a value. */
	const uiLang = $derived(getLang().slice(0, 2));

	const dirty = $derived(
		keyTouched ||
			draft.enabled !== voice.settings.enabled ||
			draft.baseUrl !== voice.settings.baseUrl ||
			draft.path !== voice.settings.path ||
			draft.model !== voice.settings.model ||
			draft.language !== voice.settings.language,
	);

	async function save(): Promise<boolean> {
		saving = true;
		message = null;
		const error = await voice.save(draft, keyTouched ? key : undefined);
		saving = false;
		if (error) {
			message = { ok: false, text: error };
			return false;
		}
		key = "";
		keyTouched = false;
		message = { ok: true, text: t("저장했습니다") };
		return true;
	}

	async function test() {
		message = null;
		// A failed save is the answer; testing would only repeat it.
		if (dirty && !(await save())) return;
		const result = await voice.test();
		message = { ok: result.ok, text: result.message };
	}
</script>

<section class="set-group">
	<div class="section-label">{t("음성 입력")}</div>
	<span class="hint">{t("말한 내용을 입력창에 글로 넣습니다. 녹음은 pipaya 서버를 거쳐 설정한 변환 서버로 보내고, 서버는 녹음을 저장하지 않습니다.")}</span>
	<SettingRow label={t("음성 입력 사용")} hint={t("켜고 연결을 확인하면 입력창에 마이크가 나타납니다")}>
		<Switch checked={draft.enabled} label={t("음성 입력 사용")} onchange={(on) => (draft = { ...draft, enabled: on })} />
	</SettingRow>
	{#if oldExtension}
		<Notice tone="warn" size="sm" raised>
			{t("확장 voice-input이 설치되어 있습니다. 마이크가 두 개 보일 수 있으니 확장을 끄고 이 설정을 쓰세요.")}
			{#if oldExtension.enabled}<span class="hint">{t("지금 켜져 있습니다")}</span>{:else}<span class="hint">{t("지금 꺼져 있습니다")}</span>{/if}
		</Notice>
	{/if}
	{#if voice.availability}
		<Notice tone="warn" size="sm" raised>{t(voice.availability === "insecure" ? "마이크는 HTTPS 화면이나 앱에서만 켜집니다. pipaya를 https 주소로 열거나 앱에서 사용하세요." : "이 브라우저는 녹음을 지원하지 않습니다.")}</Notice>
	{/if}
</section>

<section class="set-group">
	<div class="section-label">{t("변환 서버")}</div>
	<span class="hint">{t("위에서부터 채웁니다: 주소 · 모델 · API 키만 있으면 되고, 경로와 언어는 비워 두어도 됩니다. 다 채운 뒤 연결을 확인하세요.")}</span>
	<label class="row">
		<span>{t("서버 주소")}</span>
		<input class="field" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder={firstRun ? "https://api.openai.com" : t("예: https://api.openai.com")} bind:value={draft.baseUrl} aria-label={t("변환 서버 주소")} />
	</label>
	<span class="hint">{t("OpenAI 호환이면 됩니다. 주소만 쓰고 경로는 아래에 따로 넣습니다.")}</span>
	<label class="row">
		<span>{t("모델")}</span>
		<input class="field" type="text" autocomplete="off" spellcheck="false" list="voice-models" placeholder={firstRun ? "whisper-1" : t("비우면 서버 기본 모델")} bind:value={draft.model} aria-label={t("변환 모델")} />
		<datalist id="voice-models">
			<option value="whisper-1"></option>
			<option value="gpt-4o-transcribe"></option>
			<option value="gpt-transcribe"></option>
			<option value="voxtral-mini-transcribe-3-0"></option>
		</datalist>
	</label>
	<label class="row">
		<span>{t("API 키")}</span>
		<input
			class="field"
			type="password"
			autocomplete="off"
			spellcheck="false"
			placeholder={voice.hasKey && !keyTouched ? t("저장된 키 사용 중") : t("sk-…")}
			bind:value={key}
			oninput={() => (keyTouched = true)}
			aria-label={t("변환 API 키")}
		/>
	</label>
	<span class="hint">{t("키는 서버에만 저장되고 다시 표시되지 않습니다. 비우고 저장하면 키를 지웁니다.")}</span>
	<label class="row">
		<span>{t("변환 경로 (선택)")}</span>
		<input class="field" type="text" autocomplete="off" spellcheck="false" placeholder={t("비우면 {path}", { path: "/v1/audio/transcriptions" })} bind:value={draft.path} aria-label={t("변환 경로")} />
	</label>
	<span class="hint">{t("게이트웨이가 변환을 다른 경로에 두었을 때만 넣습니다.")}</span>
	<label class="row">
		<span>{t("언어 (선택)")}</span>
		<input class="field" type="text" autocomplete="off" spellcheck="false" placeholder={uiLang} bind:value={draft.language} aria-label={t("변환 언어")} />
	</label>
	<span class="hint">{t("비우면 서버가 알아서 판단합니다. 두 글자 언어 코드를 넣으면 인식이 안정됩니다.")}</span>
	<div class="actions">
		<Button size="sm" disabled={!dirty || saving} onclick={save}>{t("저장")}</Button>
		<Button size="sm" variant="ghost" disabled={voice.testing || voice.loading} onclick={test}>{voice.testing ? t("확인 중…") : t("연결 확인")}</Button>
	</div>
	{#if message}<span class="note" class:bad={!message.ok} role="status">{message.text}</span>{/if}
</section>

<section class="set-group">
	<div class="section-label">{t("상태")}</div>
	<SettingRow label={t("입력창의 마이크")} hint={voice.blockedReason ?? t("사용할 수 있습니다")}>
		<span class="state" class:on={voice.state === "ready"}>{voice.state === "ready" ? t("표시됨") : voice.state === "off" ? t("꺼짐") : t("숨김")}</span>
	</SettingRow>
	{#if voice.endpoint}<span class="hint mono">{voice.endpoint}</span>{/if}
	{#if voice.failure}<span class="note bad" role="status">{t("마지막 오류")}: {t("녹음 또는 변환에 실패했습니다. 위의 연결 확인으로 상태를 다시 확인하세요.")}</span>{/if}
</section>

<style>
	/* Same rhythm as the other settings panes: label, hint, row and notice are 8px apart instead of touching. */
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	/* Label over field: one 20px label line, an 8px gap, then the 40px field (the dialog's own spacing). */
	.row {
		display: flex;
		flex-direction: column;
		gap: var(--dlg-gap-sm);
	}
	.row > span {
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-dim);
	}
	.actions {
		display: flex;
		gap: 8px;
	}
	.note {
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.note.bad {
		color: var(--danger);
	}
	.state {
		font-size: var(--fs-sm);
		color: var(--text-faint);
	}
	.state.on {
		color: var(--ok);
	}
	.mono {
		font-family: var(--mono);
		word-break: break-all;
	}
</style>
