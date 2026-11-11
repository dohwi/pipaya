<script lang="ts">
	import { untrack } from "svelte";
	import RangeField from "../ui/RangeField.svelte";
	import SettingRow from "../ui/SettingRow.svelte";
	import Switch from "../ui/Switch.svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { Api, errorText } from "../../lib/api";
	import ModelField from "./ModelField.svelte";
	import type { CompactionSettings, ModelInfo, ProviderInfo } from "../../lib/types";

	/**
	 * Which model writes the summary when a conversation is compacted, and whether that happens on its own when the
	 * context fills up. The section stays hidden when the settings cannot be read.
	 */
	let { serverId, models, providers }: { serverId: string; models: ModelInfo[]; providers: ProviderInfo[] } = $props();

	let settings = $state<CompactionSettings | null>(null);
	let defaults = $state<CompactionSettings | null>(null);
	let pct = $state<number | null>(null); // slider value while dragging
	let error = $state("");
	let busy = $state(false);
	let seq = 0;

	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	async function load(reset: boolean) {
		const mine = ++seq;
		if (reset) settings = null; // only when the server changes: unmounting the section would reset the scroll
		error = "";
		const a = api();
		if (!a) return;
		try {
			const r = await a.compactionSettings();
			if (mine === seq) { settings = r.settings; defaults = r.defaults; }
		} catch {
			/* unreachable: the section stays hidden */
		}
	}
	let loadedFor = "";
	$effect(() => {
		const id = serverId;
		untrack(() => {
			const changed = id !== loadedFor;
			loadedFor = id;
			void load(changed);
		});
	});

	async function save(next: CompactionSettings) {
		const a = api();
		if (!a || !settings) return;
		const before = settings;
		settings = next; // shown at once; put back if the server refuses
		busy = true;
		error = "";
		try {
			settings = (await a.setCompactionSettings(next)).settings;
		} catch (e) {
			settings = before;
			error = t("압축 설정을 저장하지 못했습니다: {error}", { error: errorText(e) });
		} finally {
			busy = false;
		}
	}

	const info = $derived(settings?.model ? models.find((m) => m.provider === settings!.model!.provider && m.id === settings!.model!.model) : undefined);
	/** The saved model's connection exists but has no usable key (its models are then missing from the list). */
	const noKey = $derived(Boolean(settings?.model) && providers.some((p) => p.id === settings!.model!.provider && !p.configured));
	const def = $derived(defaults);
	const own = $derived(serverId === app.serverId); // favourites are the open server's
</script>

{#if settings}
	{@const s = settings}
	<section class="set-group">
		<div class="section-label">{t("컨텍스트 압축 모델")}</div>
		<div class="crow">
			<div class="cfield">
				<ModelField
				conn={server ? { baseUrl: server.baseUrl, token: server.token } : null}
					{models}
					{providers}
					value={s.model}
					level={s.model?.thinkingLevel ?? null}
					favs={own ? app.favModels : []}
					onfav={own ? (p, id) => app.toggleFavModel(p, id) : undefined}
					allowUnset
					unsetLabel={t("세션 모델 그대로 사용")}
					placeholder={t("세션 모델 그대로 사용")}
					disabled={busy}
					invalid={Boolean(s.model) && (noKey || !info || !info.configured)}
					label={t("압축 모델")}
					onpick={(c) => void save({ ...s, model: c })}
				/>
			</div>
		</div>
		<p class="hint note">
			{#if !s.model}
				{t("대화에서 쓰는 모델이 요약합니다.")}
			{:else if noKey || (info && !info.configured)}
				<span class="bad">{t("이 모델의 연결에 키가 없어 압축이 실패합니다. 키를 설정하거나 다른 모델을 고르세요.")}</span>
			{:else if !info}
				<span class="bad">{t("이 모델을 찾을 수 없어 압축이 실패합니다. 연결이나 모델이 바뀌었는지 확인하고 다른 모델을 고르세요.")}</span>
			{:else}
				{t("이 모델이 요약합니다. 가볍고 저렴한 모델을 권장합니다.")}
			{/if}
		</p>
		<SettingRow label={t("자동 압축")} hint={t("컨텍스트가 가득 차면 자동으로 압축")}>
			<Switch checked={s.auto} label={t("자동 압축")} disabled={busy} onchange={(on) => void save({ ...s, auto: on })} />
		</SettingRow>
		<RangeField
			label={t("자동 압축 기준")}
			min={30}
			max={95}
			step={5}
			value={pct ?? s.thresholdPercent}
			disabled={busy || !s.auto}
			oninput={(v) => (pct = v)}
			onchange={(v) => { pct = null; void save({ ...s, thresholdPercent: v }); }}
		/>
		<p class="hint note">{t("컨텍스트가 {percent}%를 넘으면 다음 메시지 전에 압축합니다 (기본 {default}%)", { percent: pct ?? s.thresholdPercent, default: def?.thresholdPercent ?? 90 })}</p>
		{#if error}<p class="hint note" role="alert">{error}</p>{/if}
	</section>
{/if}

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.crow {
		display: flex;
		align-items: stretch;
		gap: 8px;
	}
	.cfield {
		flex: 1 1 0;
		min-width: 0;
	}
	.note {
		margin: 0;
	}
	.bad {
		color: var(--danger);
	}
</style>
