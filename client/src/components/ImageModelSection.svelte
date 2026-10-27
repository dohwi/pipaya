<script lang="ts">
	import { untrack } from "svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import ModelField from "./ModelField.svelte";
	import type { ImageModelSettings, ModelInfo, ProviderInfo } from "../lib/types";

	/**
	 * The image model agents draw with. Image models never run a chat; picking one here gives every agent the
	 * `generate_image` tool (it can be switched off under the agent tools). Shown only when a connection has one.
	 */
	let { serverId, models, providers }: { serverId: string; models: ModelInfo[]; providers: ProviderInfo[] } = $props();

	const imageModels = $derived(models.filter((m) => m.imageGeneration));
	let settings = $state<ImageModelSettings | null>(null);
	let error = $state("");
	let busy = $state(false);
	let seq = 0;

	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	async function load(reset: boolean) {
		const mine = ++seq;
		if (reset) settings = null; // only when the server changes: unmounting the section would reset the scroll
		const a = api();
		if (!a) return;
		try {
			const r = await a.imageModelSettings();
			if (mine === seq) settings = r.settings;
		} catch {
			/* an older server: the section stays hidden */
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

	async function save(next: ImageModelSettings) {
		const a = api();
		if (!a || !settings) return;
		const before = settings;
		settings = next;
		busy = true;
		error = "";
		try {
			settings = (await a.setImageModelSettings(next)).settings;
		} catch (e) {
			settings = before;
			error = t("이미지 모델을 저장하지 못했습니다: {error}", { error: errorText(e) });
		} finally {
			busy = false;
		}
	}

	const info = $derived(settings?.model ? models.find((m) => m.provider === settings!.model!.provider && m.id === settings!.model!.model) : undefined);
	const own = $derived(serverId === app.serverId);
</script>

{#if settings && (imageModels.length || settings.model)}
	{@const s = settings}
	<section>
		<div class="section-label">{t("이미지 모델")}</div>
		<ModelField
			conn={server ? { baseUrl: server.baseUrl, token: server.token } : null}
			models={imageModels}
			{providers}
			value={s.model}
			favs={own ? app.favModels : []}
			onfav={own ? (p, id) => app.toggleFavModel(p, id) : undefined}
			allowUnset
			unsetLabel={t("사용 안 함")}
			placeholder={t("사용 안 함")}
			disabled={busy}
			label={t("이미지 모델")}
			onpick={(c) => void save({ model: c ? { provider: c.provider, model: c.model } : null })}
		/>
		<p class="hint note">
			{#if !s.model}
				{t("고른 모델로 에이전트가 그림을 그립니다.")}
			{:else if !info}
				{t("고른 모델을 더 이상 찾을 수 없어 이미지 생성이 꺼져 있습니다.")}
			{:else if !info.configured}
				{t("이 모델의 연결에 키가 없어 그림을 그릴 수 없습니다. 키를 설정하거나 다른 모델을 고르세요.")}
			{:else}
				{t("에이전트가 이 모델로 그림을 그립니다. 아래 에이전트 도구에서 끌 수 있습니다.")}
			{/if}
		</p>
		{#if error}<p class="hint note" role="alert">{error}</p>{/if}
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
	}
</style>
