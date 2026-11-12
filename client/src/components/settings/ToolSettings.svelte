<script lang="ts">
	import { t } from "../../lib/i18n";
	import { toolLabel } from "../../lib/settings-search";
	import { Api, errorText } from "../../lib/api";
	import { app } from "../../lib/store.svelte";
	import type { DelegateMode, DelegatePolicy, DelegateRoles, ModelInfo, ToolsInfo } from "../../lib/types";
	import SubagentsPanel from "../agent/SubagentsPanel.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import Select from "../ui/Select.svelte";
	import Switch from "../ui/Switch.svelte";
	import SettingRow from "../ui/SettingRow.svelte";

	/**
	 * Which agent tools are on for one server: read from and saved to that server only (not the open one, unless it is).
	 * Locked tools are shown but cannot be switched off.
	 */
	let { serverId }: { serverId: string } = $props();

	let cfg = $state<{ id: string; tools: ToolsInfo | null } | null>(null);
	let error = $state("");
	/** Delegate save errors show inside the delegate section, next to the switches that caused them. */
	let delegateError = $state("");

	const apiOf = (id: string) => {
		const s = app.servers.find((x) => x.id === id);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	};

	$effect(() => {
		void app.configTick;
		const id = serverId;
		error = "";
		apiOf(id)
			?.configuration()
			.then((c) => (cfg = { id, tools: c.tools }))
			.catch((e) => (error = errorText(e)));
	});

	/** A load that finished for another server is not this server's. */
	const shown = $derived(cfg && cfg.id === serverId ? cfg : null);

	let models = $state<{ id: string; list: ModelInfo[] } | null>(null);
	$effect(() => {
		const id = serverId;
		apiOf(id)?.models().then((list) => (models = { id, list: list.filter((m) => !m.imageGeneration) })).catch(() => {});
	});
	const modelList = $derived(models && models.id === serverId ? models.list : []);

	const modes: { id: DelegateMode; label: string }[] = [
		{ id: "defined", label: t("정의된 모델만") },
		{ id: "allowlist", label: t("허용 목록") },
		{ id: "any", label: t("자유") },
	];
	const modeHint: Record<DelegateMode, string> = {
		defined: t("도우미는 역할 파일에 적힌 모델만 씁니다. 에이전트가 모델을 고르려 하면 거절됩니다"),
		allowlist: t("에이전트는 아래에서 켠 모델 중에서만 고를 수 있습니다"),
		any: t("에이전트가 연결된 모델 중 아무거나 고를 수 있습니다"),
	};
	const roleModes: { id: DelegateRoles; label: string }[] = [
		{ id: "defined", label: t("정의된 역할만") },
		{ id: "any", label: t("자유") },
	];
	const roleHint: Record<DelegateRoles, string> = {
		defined: t("역할 파일로 정의된 역할만 씁니다. 다른 이름은 거절됩니다"),
		any: t("파일 없는 이름도 허용합니다. 그 도우미는 읽기 전용 도구만 쓰고 작업 내용이 곧 지침입니다"),
	};
	const nums = (xs: number[]) => xs.map((n) => ({ value: n, label: String(n) }));

	async function saveDelegate(patch: Partial<DelegatePolicy>) {
		const cur = shown?.tools?.delegate;
		if (!cur) return;
		const before = shown;
		const next = { ...cur, ...patch };
		// The server refuses this too (in English); say it in the UI language without the round trip.
		if (next.policy === "allowlist" && !next.models.length) {
			delegateError = t("허용 목록에는 모델이 하나 이상 필요합니다");
			return;
		}
		cfg = { ...before!, tools: { ...before!.tools!, delegate: next } };
		try {
			cfg = { ...before!, tools: await apiOf(serverId)!.setDelegatePolicy(next) };
			delegateError = "";
		} catch (e) {
			cfg = before;
			delegateError = errorText(e);
		}
	}
	const toggleModel = (key: string, on: boolean) => {
		const cur = shown?.tools?.delegate;
		if (cur) void saveDelegate({ models: on ? [...cur.models, key] : cur.models.filter((m) => m !== key) });
	};

	async function save(name: string, on: boolean) {
		if (!shown?.tools) return;
		const before = shown;
		const disabled = on ? before.tools!.disabled.filter((n) => n !== name) : [...new Set([...before.tools!.disabled, name])];
		cfg = { ...before, tools: { ...before.tools!, disabled } };
		try {
			cfg = { ...before, tools: await apiOf(serverId)!.setDisabledTools(disabled) };
		} catch (e) {
			cfg = before;
			error = errorText(e);
		}
	}
</script>

<section class="set-group">
	<div class="section-label">{t("에이전트 도구")}</div>
	{#if shown?.tools}
		{@const info = shown.tools}
		{#each info.toggleable as name (name)}
			<SettingRow label={toolLabel(name)}>
				<Switch checked={!info.disabled.includes(name)} label={name} onchange={(on) => save(name, on)} />
			</SettingRow>
		{/each}
		{#each info.locked as name (name)}
			<SettingRow label={toolLabel(name)} dim>
				<Switch checked disabled label={name} onchange={() => {}} />
			</SettingRow>
		{/each}
	{/if}
	{#if error}<span class="hint danger">{error}</span>{/if}
	<span class="hint">{t("끈 도구는 이 서버의 모든 대화에서 쓰지 않습니다")}{#if shown?.tools?.locked.length} · {t("흐린 도구는 끌 수 없습니다")}{/if}</span>
</section>

{#if shown?.tools?.delegate && shown.tools.toggleable.includes("delegate")}
	{@const d = shown.tools.delegate}
	<section class="set-group">
		<div class="section-label">{t("도우미 위임 (delegate)")}</div>
		<SettingRow label={t("도우미 역할")} hint={roleHint[d.roles]}>
			<Segmented size="sm" full={false} label={t("도우미 역할 선택")} value={d.roles} options={roleModes} onchange={(id) => saveDelegate({ roles: id })} />
		</SettingRow>
		<SettingRow label={t("도우미 모델")} hint={modeHint[d.policy]}>
			<Segmented size="sm" full={false} label={t("도우미 모델 선택")} value={d.policy} options={modes} onchange={(id) => saveDelegate({ policy: id, ...(id === "allowlist" && !d.models.length && modelList[0] ? { models: [`${modelList[0].provider}/${modelList[0].id}`] } : {}) })} />
		</SettingRow>
		{#if d.policy === "allowlist"}
			{#each modelList as m (`${m.provider}/${m.id}`)}
				{@const key = `${m.provider}/${m.id}`}
				<SettingRow label={m.name || m.id} hint={key}>
					<Switch checked={d.models.includes(key)} label={key} onchange={(on) => toggleModel(key, on)} />
				</SettingRow>
			{/each}
			{#each d.models.filter((k) => !modelList.some((m) => `${m.provider}/${m.id}` === k)) as key (key)}
				<SettingRow label={key} hint={t("연결에서 사라진 모델")} dim>
					<Switch checked label={key} onchange={(on) => toggleModel(key, on)} />
				</SettingRow>
			{/each}
		{/if}
		{#if delegateError}<span class="hint danger">{delegateError}</span>{/if}
		<SettingRow label={t("동시에 실행할 도우미")} hint={t("한 대화에서 동시에 돌 수 있는 수")}>
			<Select size="sm" width="96px" label={t("동시에 실행할 도우미")} value={d.maxConcurrent} options={nums([1, 2, 3, 4, 6, 8])} onchange={(n) => saveDelegate({ maxConcurrent: n })} />
		</SettingRow>
		<SettingRow label={t("실행당 위임 횟수")} hint={t("에이전트가 한 번 일하는 동안 부를 수 있는 횟수")}>
			<Select size="sm" width="96px" label={t("실행당 위임 횟수")} value={d.maxCalls} options={nums([4, 8, 12, 20, 30, 50])} onchange={(n) => saveDelegate({ maxCalls: n })} />
		</SettingRow>
		<SettingRow label={t("도우미 최대 모델 호출")} hint={t("역할 파일이 더 크게 적어도 이 값을 넘지 않습니다")}>
			<Select size="sm" width="96px" label={t("도우미 최대 모델 호출")} value={d.maxTurns} options={nums([5, 10, 15, 20, 30, 50])} onchange={(n) => saveDelegate({ maxTurns: n })} />
		</SettingRow>
	</section>
	<SubagentsPanel {serverId} models={modelList} globalOnly />
{/if}

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
