<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import ModelField from "./ModelField.svelte";
	import type { ModelInfo, ProviderInfo, SystemModelSettings } from "../lib/types";

	/**
	 * The light model the server uses for its own small jobs: naming each session and writing what it works on (its
	 * role). The section stays hidden when the settings cannot be read.
	 */
	let { serverId, models, providers }: { serverId: string; models: ModelInfo[]; providers: ProviderInfo[] } = $props();

	let settings = $state<SystemModelSettings | null>(null);
	let error = $state("");
	let busy = $state(false);
	let seq = 0;

	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	async function load() {
		const mine = ++seq;
		settings = null;
		error = "";
		const a = api();
		if (!a) return;
		try {
			const r = await a.systemModelSettings();
			if (mine === seq) settings = r.settings;
		} catch {
			/* unreachable: the section stays hidden */
		}
	}
	$effect(() => {
		void serverId;
		void load();
	});

	async function save(next: SystemModelSettings) {
		const a = api();
		if (!a || !settings) return;
		const before = settings;
		settings = next; // shown at once; put back if the server refuses
		busy = true;
		error = "";
		try {
			settings = (await a.setSystemModelSettings(next)).settings;
		} catch (e) {
			settings = before;
			error = t("시스템 모델을 저장하지 못했습니다: {error}", { error: errorText(e) });
		} finally {
			busy = false;
		}
	}

	const info = $derived(settings?.model ? models.find((m) => m.provider === settings!.model!.provider && m.id === settings!.model!.model) : undefined);
	const own = $derived(serverId === app.serverId); // favourites are the open server's
</script>

{#if settings}
	{@const s = settings}
	<section>
		<div class="mono-label">{t("시스템 모델")}</div>
		<ModelField
			{models}
			{providers}
			value={s.model}
			level={s.model?.thinkingLevel ?? null}
			favs={own ? app.favModels : []}
			onfav={own ? (p, id) => app.toggleFavModel(p, id) : undefined}
			allowUnset
			unsetLabel={t("사용 안 함")}
			placeholder={t("사용 안 함")}
			disabled={busy}
			label={t("시스템 모델")}
			onpick={(c) => void save({ model: c })}
		/>
		<p class="note">
			{#if !s.model}
				{t("세션 이름은 첫 메시지를 줄여 쓰고, 역할은 비워 둡니다.")}
			{:else if info && !info.configured}
				{t("이 모델의 연결에 키가 없어 세션 이름을 지을 수 없습니다. 키를 설정하거나 다른 모델을 고르세요.")}
			{:else}
				{t("세션 이름과 역할을 이 모델이 요약해 붙입니다. 가볍고 저렴한 모델을 권장합니다.")}
			{/if}
		</p>
		{#if error}<p class="note" role="alert">{error}</p>{/if}
	</section>
{/if}

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.note {
		margin: 0;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
</style>
