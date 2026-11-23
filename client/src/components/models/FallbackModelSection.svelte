<script lang="ts">
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { modelSetting } from "../../lib/model-setting.svelte";
	import ModelField from "./ModelField.svelte";
	import type { FallbackModelSettings, ModelInfo, ProviderInfo } from "../../lib/types";

	/**
	 * Automatic fallback model used when the primary model fails repeatedly with zero output.
	 * The section stays hidden when the server does not expose the setting.
	 */
	let { serverId, models, providers }: { serverId: string; models: ModelInfo[]; providers: ProviderInfo[] } = $props();

	const server = $derived(app.servers.find((s) => s.id === serverId));
	const setting = modelSetting<FallbackModelSettings>(
		() => server, (a) => a.fallbackModelSettings(), (a, next) => a.setFallbackModelSettings(next),
		(error) => t("폴백 모델을 저장하지 못했습니다: {error}", { error }),
	);
	const settings = $derived(setting.settings);
	const info = $derived(settings?.model ? models.find((m) => m.provider === settings!.model!.provider && m.id === settings!.model!.model) : undefined);
	/** The saved model's connection exists but has no usable key (its models are then missing from the list). */
	const noKey = $derived(Boolean(settings?.model) && providers.some((p) => p.id === settings!.model!.provider && !p.configured));
	const own = $derived(serverId === app.serverId); // favourites are the open server's
</script>

{#if settings}
	{@const s = settings}
	<section class="set-group">
		<div class="section-label">{t("폴백 모델")}</div>
		<ModelField
			conn={server ? { baseUrl: server.baseUrl, token: server.token } : null}
			{models}
			{providers}
			value={s.model}
			level={s.model?.thinkingLevel ?? null}
			favs={own ? app.favModels : []}
			onfav={own ? (p, id) => app.toggleFavModel(p, id) : undefined}
			allowUnset
			unsetLabel={t("사용 안 함")}
			placeholder={t("사용 안 함")}
			disabled={setting.busy}
			invalid={Boolean(s.model) && (noKey || !info || !info.configured)}
			label={t("폴백 모델")}
			onpick={(c) => void setting.save({ model: c })}
		/>
		<p class="hint note">
			{#if !s.model}
				{t("지정하지 않으면 응답 없이 끊겼을 때 같은 모델로만 재시도합니다.")}
			{:else if noKey || (info && !info.configured)}
				<span class="bad">{t("이 모델의 연결에 키가 없어 폴백으로 전환할 수 없습니다. 키를 설정하거나 다른 모델을 고르세요.")}</span>
			{:else if !info}
				<span class="bad">{t("이 모델을 찾을 수 없어 폴백으로 전환할 수 없습니다. 연결이나 모델이 바뀌었는지 확인하고 다른 모델을 고르세요.")}</span>
			{:else}
				{t("모델이 응답 없이 반복해서 끊기면 이 모델로 자동 전환해 이어갑니다.")}
			{/if}
		</p>
		{#if setting.error}<p class="hint note" role="alert">{setting.error}</p>{/if}
	</section>
{/if}

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.note {
		margin: 0;
	}
	.bad {
		color: var(--danger);
	}
</style>
