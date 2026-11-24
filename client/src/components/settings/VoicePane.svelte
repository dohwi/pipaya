<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Notice from "../ui/Notice.svelte";
	import SettingRow from "../ui/SettingRow.svelte";
	import Switch from "../ui/Switch.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import { t, getLang } from "../../lib/i18n";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { Api, type RealtimeVoiceSettings, type VoiceSettings } from "../../lib/api";
	import { voice, VoiceRemote } from "../../lib/voice.svelte";
	import { untrack } from "svelte";
	import { app } from "../../lib/store.svelte";
	import { settingsDrafts } from "../../lib/settings-drafts.svelte";

	/**
	 * Settings > Voice for one server (`serverId`). The connection lives on the server (so every device shares it) and
	 * the key is written once and never read back. The microphone button in the composer appears only when voice input
	 * is on and the connection test passed; this page is where the user turns it on, fixes it and tests it.
	 *
	 * The page reads in the order the setup happens: switch it on, fill the connection top to bottom (address, model,
	 * key, then the optional path and language), then check it. The status block at the bottom only reports.
	 */
	let { serverId }: { serverId: string } = $props();

	const isOpenServer = $derived(serverId === app.serverId);
	const remote = new VoiceRemote();
	const target = $derived(isOpenServer ? voice : remote);
	const apiOf = (id: string) => {
		const s = app.servers.find((x) => x.id === id);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	};

	$effect(() => {
		remote.availability = voice.availability;
	});

	// Always pull fresh settings when opening this pane (so a server upgrade or change on another device shows at once).
	$effect(() => {
		const id = serverId;
		void app.voiceTick;
		const t0 = untrack(() => (id === app.serverId ? voice : remote));
		void t0.load(apiOf(id), id);
	});

	const REALTIME_DEFAULTS: RealtimeVoiceSettings = { url: "", model: "gpt-realtime-2.1", transcribeModel: "gpt-live-transcribe", keywords: [], prompt: "" };
	let draft = $state<VoiceSettings>({ enabled: false, baseUrl: "", path: "", model: "", language: "", mode: "file", realtime: { ...REALTIME_DEFAULTS } });
	/** The keywords as the user types them, one per line; turned into the list when saved. */
	let keywordText = $state("");
	let key = $state("");
	let keyTouched = $state(false);
	let rtKey = $state("");
	let rtKeyTouched = $state(false);
	let saving = $state(false);
	let error = $state("");

	/**
	 * Unsaved input survives leaving this section (another tab, another server, closing Settings) and coming back: both
	 * modes' fields are one draft, so switching file <-> realtime never drops what was typed for the other.
	 */
	type Draft = { draft: VoiceSettings; keywordText: string; key: string; keyTouched: boolean; rtKey: string; rtKeyTouched: boolean };
	const draftKey = $derived(`voice:${serverId}`);
	let restored = false;

	// The server's settings arrive after the first render (and again when the server changes or another device saves).
	$effect(() => {
		if (!target.loaded) return;
		const kept = untrack(() => (!restored ? settingsDrafts.get<Draft>(draftKey) : undefined));
		if (kept) {
			({ draft, keywordText, key, keyTouched, rtKey, rtKeyTouched } = kept);
			restored = true;
			return;
		}
		// an unsaved edit is not overwritten by a reload from the server (the first load always fills the form)
		if (restored && untrack(() => dirty)) return;
		restored = true;
		draft = { ...target.settings, mode: target.settings.mode ?? "file", realtime: { ...REALTIME_DEFAULTS, ...target.settings.realtime } };
		keywordText = (target.settings.realtime?.keywords ?? []).join("\n");
		rtKey = "";
		rtKeyTouched = false;
		key = "";
		keyTouched = false;
	});

	// keep the draft while it differs from what is saved; once it matches again (saved, or typed back) it is dropped
	$effect(() => {
		if (!target.loaded || !restored) return;
		const snapshot: Draft = { draft, keywordText, key, keyTouched, rtKey, rtKeyTouched };
		if (dirty) settingsDrafts.set(draftKey, snapshot);
		else settingsDrafts.clear(draftKey);
	});

	/** Back to what the server has: the unsaved input of both modes is dropped. */
	function revert() {
		settingsDrafts.clear(draftKey);
		draft = { ...target.settings, mode: target.settings.mode ?? "file", realtime: { ...REALTIME_DEFAULTS, ...target.settings.realtime } };
		keywordText = (target.settings.realtime?.keywords ?? []).join("\n");
		key = rtKey = "";
		keyTouched = rtKeyTouched = false;
		error = "";
	}

	/** The old microphone extension, if it is installed: two microphones with two settings would confuse anyone. */
	const oldExtension = $derived(extensions.installed.find((e) => e.package.manifest.id === "voice-input") ?? null);

	/** Nothing set up yet: the placeholders then carry the whole example, so the first visit says what to type. */
	const firstRun = $derived(!target.settings.baseUrl && !target.settings.model && !target.hasKey);

	/** The language the UI is in, as the hint a person most likely wants ("ko" for Korean). Only a placeholder, never a value. */
	const uiLang = $derived(getLang().slice(0, 2));

	/** An older server knows only the file mode: the choice is not offered there. */
	const hasModes = $derived(target.settings.mode !== undefined);
	const realtime = $derived(draft.mode === "realtime");
	const rt = $derived(draft.realtime ?? REALTIME_DEFAULTS);
	const keywords = $derived([...new Set(keywordText.split("\n").map((k) => k.trim()).filter(Boolean))]);
	const setRt = (patch: Partial<RealtimeVoiceSettings>) => (draft = { ...draft, realtime: { ...rt, ...patch } });
	const savedRt = $derived({ ...REALTIME_DEFAULTS, ...target.settings.realtime });

	const dirty = $derived(
		keyTouched ||
			rtKeyTouched ||
			(draft.mode ?? "file") !== (target.settings.mode ?? "file") ||
			rt.url !== savedRt.url ||
			rt.model !== savedRt.model ||
			rt.transcribeModel !== savedRt.transcribeModel ||
			rt.prompt !== savedRt.prompt ||
			keywords.join("\n") !== savedRt.keywords.join("\n") ||
			draft.enabled !== target.settings.enabled ||
			draft.baseUrl !== target.settings.baseUrl ||
			draft.path !== target.settings.path ||
			draft.model !== target.settings.model ||
			draft.language !== target.settings.language,
	);

	async function save(silent = false): Promise<boolean> {
		saving = true;
		error = "";
		const next: VoiceSettings = hasModes ? { ...draft, realtime: { ...rt, keywords } } : { enabled: draft.enabled, baseUrl: draft.baseUrl, path: draft.path, model: draft.model, language: draft.language };
		const err = await target.save(next, keyTouched ? key : undefined, rtKeyTouched ? rtKey : undefined);
		saving = false;
		if (err) {
			error = err;
			return false;
		}
		// what the server stored (it trims and drops repeated keywords) becomes the form again
		revert();
		if (!silent) app.toast(t("저장했습니다"), "ok");
		return true;
	}

	async function test() {
		error = "";
		// A failed save is the answer; testing would only repeat it.
		if (dirty && !(await save(true))) return;
		const result = await target.test();
		if (result.ok) app.toast(result.message, "ok");
		else error = result.message;
	}
</script>

<section class="set-group">
	<div class="section-label">{t("음성 입력")}</div>
	<span class="hint">{t("말한 내용을 입력창에 글로 넣습니다. 녹음은 pipaya 서버를 거쳐 설정한 변환 서버로 보내고, 서버는 녹음을 저장하지 않습니다.")}</span>
	<SettingRow label={t("음성 입력 사용")} hint={t("켜면 입력창에 마이크가 나타납니다. 연결 확인은 키와 주소를 미리 점검합니다")}>
		<Switch checked={draft.enabled} label={t("음성 입력 사용")} onchange={(on) => (draft = { ...draft, enabled: on })} />
	</SettingRow>
	{#if oldExtension}
		<Notice tone="warn" size="sm" raised>
			{t("확장 voice-input이 설치되어 있습니다. 마이크가 두 개 보일 수 있으니 확장을 끄고 이 설정을 쓰세요.")}
			{#if oldExtension.enabled}<span class="hint">{t("지금 켜져 있습니다")}</span>{:else}<span class="hint">{t("지금 꺼져 있습니다")}</span>{/if}
		</Notice>
	{/if}
	{#if target.availability}
		<Notice tone="warn" size="sm" raised>{target.blockedReason}</Notice>
	{/if}
</section>

{#if hasModes}
	<section class="set-group">
		<div class="section-label">{t("변환 방식")}</div>
		<Segmented
			label={t("변환 방식")}
			value={draft.mode ?? "file"}
			options={[{ id: "file", label: t("녹음 후 변환") }, { id: "realtime", label: t("실시간") }]}
			onchange={(id) => { draft = { ...draft, mode: id }; error = ""; }}
		/>
		<span class="hint">{realtime ? t("말하는 동안 소리를 보내고, 들리는 단어를 입력창에 바로 넣습니다. 키워드로 이름 표기를 맞출 수 있습니다. 마이크를 켜 둔 시간만큼 연결의 사용량이 듭니다.") : t("녹음을 끝내면 한 번에 보내 글로 바꿉니다. OpenAI 호환 변환 서버면 어디든 됩니다.")}</span>
	</section>
{/if}

{#if realtime}
<section class="set-group">
	<div class="section-label">{t("실시간 변환")}</div>
	<span class="hint">{t("OpenAI Realtime API 형식이면 됩니다. 주소 · API 키만 있으면 되고, 모델은 비워 두면 기본값을 씁니다.")}</span>
	<label class="row">
		<span>{t("서버 주소")}</span>
		<input class="field" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="wss://api.openai.com/v1/realtime" value={rt.url} oninput={(e) => setRt({ url: e.currentTarget.value })} aria-label={t("실시간 변환 서버 주소")} />
	</label>
	<span class="hint">{t("/v1/realtime까지 씁니다. https://로 넣어도 됩니다. 주소에 ?model=이 없으면 아래 세션 모델을 붙입니다.")}</span>
	<label class="row">
		<span>{t("API 키")}</span>
		<input
			class="field"
			type="password"
			autocomplete="off"
			spellcheck="false"
			placeholder={target.hasRealtimeKey && !rtKeyTouched ? t("저장된 키 사용 중") : t("sk-… (키가 없는 로컬 서버면 비워 둡니다)")}
			bind:value={rtKey}
			oninput={() => (rtKeyTouched = true)}
			aria-label={t("실시간 변환 API 키")}
		/>
	</label>
	<span class="hint">{t("음성 입력의 다른 키와 따로 저장되고, 다시 표시되지 않습니다. 비우고 저장하면 키를 지웁니다.")}</span>
	<label class="row">
		<span>{t("세션 모델")}</span>
		<input class="field" type="text" autocomplete="off" spellcheck="false" placeholder={REALTIME_DEFAULTS.model} value={rt.model} oninput={(e) => setRt({ model: e.currentTarget.value })} aria-label={t("실시간 세션 모델")} />
	</label>
	<label class="row">
		<span>{t("변환 모델")}</span>
		<input class="field" type="text" autocomplete="off" spellcheck="false" placeholder={REALTIME_DEFAULTS.transcribeModel} value={rt.transcribeModel} oninput={(e) => setRt({ transcribeModel: e.currentTarget.value })} aria-label={t("실시간 변환 모델")} />
	</label>
	<label class="row">
		<span>{t("언어 (선택)")}</span>
		<input class="field" type="text" autocomplete="off" spellcheck="false" placeholder={uiLang} bind:value={draft.language} aria-label={t("변환 언어")} />
	</label>
	<label class="row">
		<span>{t("키워드 (선택)")}</span>
		<textarea class="field area" rows="4" spellcheck="false" placeholder={"Pipaya\nTailscale\nCLIProxyAPI"} bind:value={keywordText} aria-label={t("키워드")}></textarea>
	</label>
	<span class="hint" class:bad={keywords.length > 20}>{t("한 줄에 하나씩, 최대 20개. 제품·서비스 이름처럼 표기를 지켜야 하는 말을 넣습니다. ({n}/20)", { n: keywords.length })}</span>
	<label class="row">
		<span>{t("문맥 (선택)")}</span>
		<textarea class="field area" rows="2" maxlength="300" placeholder={t("예: 한국어로 말하는 개발 작업 지시")} value={rt.prompt} oninput={(e) => setRt({ prompt: e.currentTarget.value })} aria-label={t("문맥")}></textarea>
	</label>
	<div class="actions">
		<Button size="sm" variant="primary" disabled={!dirty || saving || keywords.length > 20} onclick={() => void save()}>{t("저장")}</Button>
		<Button size="sm" disabled={target.testing || target.loading} onclick={test}>{target.testing ? t("확인 중…") : t("연결 확인")}</Button>
		{#if dirty}<Button size="sm" variant="ghost" disabled={saving} onclick={revert}>{t("변경 취소")}</Button>{/if}
	</div>
	{#if dirty && !error}<span class="note" role="status">{t("저장하지 않은 변경이 있습니다. 다른 화면에 다녀와도 남아 있습니다.")}</span>{/if}
	{#if error}<Notice tone="danger" size="sm" raised animated>{error}</Notice>{/if}
</section>
{:else}
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
		<!-- Free text, no list: OpenAI, Mistral and gateways each take their own names, and a list would only age. -->
		<input class="field" type="text" autocomplete="off" spellcheck="false" placeholder={t("비우면 서버 기본 모델")} bind:value={draft.model} aria-label={t("변환 모델")} aria-describedby="voice-model-hint" />
	</label>
	<span class="hint" id="voice-model-hint">{t("변환 서버가 받는 모델 이름을 그대로 넣습니다.")}</span>
	<label class="row">
		<span>{t("API 키")}</span>
		<input
			class="field"
			type="password"
			autocomplete="off"
			spellcheck="false"
			placeholder={target.hasKey && !keyTouched ? t("저장된 키 사용 중") : t("sk-…")}
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
		<Button size="sm" variant="primary" disabled={!dirty || saving} onclick={() => void save()}>{t("저장")}</Button>
		<Button size="sm" disabled={target.testing || target.loading} onclick={test}>{target.testing ? t("확인 중…") : t("연결 확인")}</Button>
		{#if dirty}<Button size="sm" variant="ghost" disabled={saving} onclick={revert}>{t("변경 취소")}</Button>{/if}
	</div>
	{#if dirty && !error}<span class="note" role="status">{t("저장하지 않은 변경이 있습니다. 다른 화면에 다녀와도 남아 있습니다.")}</span>{/if}
	{#if error}<Notice tone="danger" size="sm" raised animated>{error}</Notice>{/if}
</section>
{/if}

<section class="set-group">
	<div class="section-label">{t("상태")}</div>
	<SettingRow label={t("입력창의 마이크")} hint={target.blockedReason ?? t("사용할 수 있습니다")}>
		<span class="state" class:on={target.state === "ready"} class:blocked={target.state === "unusable"}>{target.state === "ready" ? t("사용 가능") : target.state === "off" ? t("꺼짐") : t("사용 안 함")}</span>
	</SettingRow>
	{#if target.realtime ? target.realtimeEndpoint : target.endpoint}<span class="hint mono">{target.realtime ? target.realtimeEndpoint : target.endpoint}</span>{/if}
	{#if isOpenServer && voice.failure}<Notice tone="danger" size="sm" raised role="status">{t("마지막 오류")}: {t("녹음 또는 변환에 실패했습니다. 위의 연결 확인으로 상태를 다시 확인하세요.")}</Notice>{/if}
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
		flex-wrap: wrap;
		gap: 8px;
	}
	@media (max-width: 640px) {
		.actions > :global(.btn:not(.ghost)) {
			flex: 1 1 0;
		}
	}
	.note {
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.hint.bad {
		color: var(--danger);
	}
	/* the schedules form's text area: a field that grows, padded like the one-line field, whole-pixel lines */
	.area {
		height: auto;
		padding: 8px 12px;
		resize: vertical;
		line-height: 20px;
	}
	.state {
		font-size: var(--fs-sm);
		color: var(--text-faint);
	}
	.state.on {
		color: var(--ok);
	}
	.state.blocked {
		color: var(--danger);
	}
	.mono {
		font-family: var(--mono);
		word-break: break-all;
	}
</style>
