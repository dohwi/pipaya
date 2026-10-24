<script lang="ts">
	import { t } from "../lib/i18n";
	import { toolLabel } from "../lib/settings-search";
	import { Api, errorText } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import type { ToolsInfo } from "../lib/types";
	import Switch from "./Switch.svelte";
	import SettingRow from "./SettingRow.svelte";

	/**
	 * Which agent tools are on for one server: read from and saved to that server only (not the open one, unless it is).
	 * Locked tools are shown but cannot be switched off.
	 */
	let { serverId }: { serverId: string } = $props();

	let cfg = $state<{ id: string; tools: ToolsInfo | null } | null>(null);
	let error = $state("");

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

<section>
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
	<span class="hint">{t("끄면 해당 도구를 에이전트에게 주지 않습니다. 서버에 저장되어 모든 대화에 적용됩니다. 잠긴 도구는 끌 수 없습니다.")}</span>
</section>

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
</style>
