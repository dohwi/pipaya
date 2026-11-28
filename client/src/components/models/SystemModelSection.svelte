<script lang="ts">
	import SettingRow from "../ui/SettingRow.svelte";
	import Switch from "../ui/Switch.svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { modelSetting } from "../../lib/model-setting.svelte";
	import ModelField from "./ModelField.svelte";
	import type { ModelInfo, ProviderInfo, SystemModelSettings, SystemModelTasks } from "../../lib/types";

	const FALLBACK_TASKS: SystemModelTasks = {
		sessionTitle: true,
		sessionPurpose: true,
		sessionName: false,
		groupName: true,
	};

	/**
	 * The light model the server uses for its own background jobs, plus per-task toggles deciding which jobs it runs
	 * (session title, session role, session `@name`, and split group name). Hidden when the settings cannot be read.
	 */
	let { serverId, models, providers }: { serverId: string; models: ModelInfo[]; providers: ProviderInfo[] } = $props();

	const server = $derived(app.servers.find((s) => s.id === serverId));
	const setting = modelSetting<SystemModelSettings>(
		() => server, (a) => a.systemModelSettings(), (a, next) => a.setSystemModelSettings(next),
		(error) => t("시스템 모델을 저장하지 못했습니다: {error}", { error }),
	);
	const settings = $derived(setting.settings);
	const supportsTasks = $derived(settings?.tasks !== undefined);
	const tasks = $derived<SystemModelTasks>({ ...FALLBACK_TASKS, ...(settings?.tasks ?? {}) });
	const anyTask = $derived(tasks.sessionTitle || tasks.sessionPurpose || tasks.sessionName || tasks.groupName);
	const info = $derived(settings?.model ? models.find((m) => m.provider === settings!.model!.provider && m.id === settings!.model!.model) : undefined);
	/** The saved model's connection exists but has no usable key (its models are then missing from the list). */
	const noKey = $derived(Boolean(settings?.model) && providers.some((p) => p.id === settings!.model!.provider && !p.configured));
	const own = $derived(serverId === app.serverId); // favourites are the open server's

	const toggleTask = (key: keyof SystemModelTasks, on: boolean) => {
		if (!settings) return;
		void setting.save({ model: settings.model, tasks: { ...tasks, [key]: on } });
	};
</script>

{#if settings}
	{@const s = settings}
	<section class="set-group">
		<div class="section-label">{t("시스템 모델")}</div>
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
			label={t("시스템 모델")}
			onpick={(c) => void setting.save(supportsTasks ? { model: c, tasks } : { model: c })}
		/>
		<p class="hint note">
			{#if !s.model}
				{t("지정하면 아래에서 켠 작업을 백그라운드에서 자동으로 처리합니다.")}
			{:else if noKey || (info && !info.configured)}
				<span class="bad">{t("이 모델의 연결에 키가 없어 시스템 모델 작업을 실행할 수 없습니다. 키를 설정하거나 다른 모델을 고르세요.")}</span>
			{:else if !info}
				<span class="bad">{t("이 모델을 찾을 수 없어 시스템 모델 작업을 실행할 수 없습니다. 연결이나 모델이 바뀌었는지 확인하고 다른 모델을 고르세요.")}</span>
			{:else if !anyTask}
				{t("켜진 작업이 없습니다. 아래에서 시스템 모델에 맡길 항목을 고르세요.")}
			{:else}
				{t("아래에서 켠 작업을 이 모델이 백그라운드에서 처리합니다. 가볍고 저렴한 모델을 권장합니다.")}
			{/if}
		</p>
		{#if supportsTasks}
			<div class="tasks">
				<SettingRow label={t("대화 제목")} hint={t("첫 메시지로 간결한 대화 제목을 짓습니다")} dim={!s.model}>
					<Switch checked={tasks.sessionTitle} label={t("대화 제목")} disabled={setting.busy || !s.model} onchange={(on) => toggleTask("sessionTitle", on)} />
				</SettingRow>
				<SettingRow label={t("대화 역할")} hint={t("멘션과 협업에 쓰이는 작업 요약을 적습니다")} dim={!s.model}>
					<Switch checked={tasks.sessionPurpose} label={t("대화 역할")} disabled={setting.busy || !s.model} onchange={(on) => toggleTask("sessionPurpose", on)} />
				</SettingRow>
				<SettingRow label={t("대화 @이름")} hint={t("새 대화의 기본 코드네임(@A1) 대신 주제에 맞는 @이름을 붙입니다")} dim={!s.model}>
					<Switch checked={tasks.sessionName} label={t("대화 @이름")} disabled={setting.busy || !s.model} onchange={(on) => toggleTask("sessionName", on)} />
				</SettingRow>
				<SettingRow label={t("그룹 이름")} hint={t("분할 창 그룹을 만들 때 어울리는 이름을 짓습니다")} dim={!s.model}>
					<Switch checked={tasks.groupName} label={t("그룹 이름")} disabled={setting.busy || !s.model} onchange={(on) => toggleTask("groupName", on)} />
				</SettingRow>
			</div>
		{/if}
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
	.tasks {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 4px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}
</style>
