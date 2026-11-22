<script lang="ts">
	import EmptyState from "../ui/EmptyState.svelte";
	import Notice from "../ui/Notice.svelte";
	import SettingRow from "../ui/SettingRow.svelte";
	import Switch from "../ui/Switch.svelte";
	import { Api, errorText } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import type { GuardInfo, GuardSettings } from "../../lib/types";

	/**
	 * Built-in bash command guard settings for one server: blocks destructive commands before `bash` runs (main agent
	 * and subagents alike). Toggles apply immediately without reloading.
	 */
	let { serverId }: { serverId: string } = $props();

	let info = $state<{ id: string; data: GuardInfo } | null>(null);
	let error = $state("");
	let busy = $state(false);
	let seq = 0;

	const apiOf = (id: string) => {
		const s = app.servers.find((x) => x.id === id);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	};

	$effect(() => {
		void app.configTick;
		const id = serverId;
		const mine = ++seq;
		error = "";
		apiOf(id)
			?.guard()
			.then((data) => {
				if (mine === seq) info = { id, data };
			})
			.catch((e) => {
				if (mine === seq) error = errorText(e);
			});
	});

	const shown = $derived(info && info.id === serverId ? info.data : null);

	async function save(key: keyof GuardSettings, on: boolean) {
		const a = apiOf(serverId);
		if (!a || !shown || busy) return;
		const before = info!;
		const next: GuardSettings = { ...shown.settings, [key]: on };
		info = { id: serverId, data: { ...shown, settings: next } };
		busy = true;
		error = "";
		try {
			info = { id: serverId, data: await a.setGuard(next) };
		} catch (e) {
			info = before;
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
</script>

<section class="set-group" data-focus="guard">
	<div class="section-label">{t("위험 명령 차단")}</div>
	{#if shown}
		{@const s = shown.settings}
		<SettingRow label={t("대규모 삭제 차단")} hint={t("루트(/), 홈(~, $HOME)을 지우는 rm -rf 또는 --no-preserve-root 명령을 막습니다.")}>
			<Switch checked={s.wipe} disabled={busy} label={t("대규모 삭제 차단")} onchange={(on) => void save("wipe", on)} />
		</SettingRow>
		<SettingRow label={t("디스크 덮어쓰기 차단")} hint={t("mkfs, 블록 장치 대상 dd(of=/dev/sd…), 디스크 장치로 향하는 리디렉션을 막습니다.")}>
			<Switch checked={s.disk} disabled={busy} label={t("디스크 덮어쓰기 차단")} onchange={(on) => void save("disk", on)} />
		</SettingRow>
		<SettingRow label={t("포크 폭탄 차단")} hint={t("시스템 프로세스를 고갈시키는 셸 포크 폭탄 구문을 막습니다.")}>
			<Switch checked={s.fork} disabled={busy} label={t("포크 폭탄 차단")} onchange={(on) => void save("fork", on)} />
		</SettingRow>
		<SettingRow label={t("루트 권한 변경 차단")} hint={t("루트(/)나 홈(~, $HOME) 전체에 대한 재귀적 chmod·chown 명령을 막습니다.")}>
			<Switch checked={s.permissions} disabled={busy} label={t("루트 권한 변경 차단")} onchange={(on) => void save("permissions", on)} />
		</SettingRow>
		<span class="hint">{t("에이전트와 서브에이전트가 bash 도구를 실행하기 전에 검사합니다. 바꾸면 바로 적용됩니다.")}</span>
	{:else if !error}
		<EmptyState loading />
	{/if}
	{#if error}<Notice tone="danger" size="sm">{error}</Notice>{/if}
</section>

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
