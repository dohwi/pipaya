<script lang="ts">
	import Button from "./Button.svelte";
	import Select from "./Select.svelte";
	import SettingRow from "./SettingRow.svelte";
	import Switch from "./Switch.svelte";
	import { t } from "../lib/i18n";
	import { Api, errorText } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import type { RetentionInfo, RetentionSettings } from "../lib/types";

	/**
	 * Deleting chats not used for a while: the server checks once an hour. Running chats and chats waiting for an
	 * answer are never deleted. The section stays hidden when the server cannot tell (an older server).
	 */
	let { serverId, onrun }: { serverId: string; onrun?: () => void } = $props();

	const DAY_CHOICES = [7, 14, 30, 60, 90, 180, 365];

	let info = $state<RetentionInfo | null>(null);
	let error = $state("");
	let note = $state("");
	let busy = $state(false);
	let seq = 0;

	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	async function load() {
		const mine = ++seq;
		const a = api();
		if (!a) return;
		try {
			const r = await a.retention();
			if (mine === seq) info = r;
		} catch {
			/* an older server: the section stays hidden */
		}
	}
	$effect(() => {
		void serverId;
		info = null;
		void load();
	});

	async function save(next: RetentionSettings) {
		const a = api();
		if (!a || !info) return;
		const before = info;
		info = { ...info, settings: next };
		busy = true;
		error = note = "";
		try {
			info = await a.setRetention(next);
		} catch (e) {
			info = before;
			error = t("보관 설정을 저장하지 못했습니다: {error}", { error: errorText(e) });
		} finally {
			busy = false;
		}
	}

	async function runNow() {
		const a = api();
		if (!a) return;
		busy = true;
		error = note = "";
		try {
			const { deleted } = await a.runRetention();
			note = t("{n}개를 지웠습니다.", { n: deleted });
			await load();
			if (deleted) onrun?.();
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}

	const dayLabel = (d: number) => (d % 365 === 0 ? t("{n}년", { n: d / 365 }) : t("{n}일", { n: d }));
	const dayOptions = $derived.by(() => {
		const days = info ? [...new Set([...DAY_CHOICES, info.settings.days])].sort((a, b) => a - b) : DAY_CHOICES;
		return days.map((d) => ({ value: d, label: dayLabel(d) }));
	});
</script>

{#if info}
	{@const s = info.settings}
	<section class="retention">
		<div class="section-label">{t("자동 삭제")}</div>
		<SettingRow label={t("오래된 대화 자동 삭제")} hint={t("한 시간마다 확인합니다. 실행 중이거나 답을 기다리는 대화는 지우지 않습니다.")}>
			<Switch checked={s.enabled} disabled={busy} label={t("오래된 대화 자동 삭제")} onchange={(on) => void save({ ...s, enabled: on })} />
		</SettingRow>
		<SettingRow label={t("보관 기간")} dim={!s.enabled}>
			<Select size="sm" width="auto" label={t("보관 기간")} value={s.days} disabled={busy || !s.enabled} options={dayOptions} onchange={(d) => void save({ ...s, days: d })} />
		</SettingRow>
		<SettingRow label={t("닫은 대화만")} hint={t("끄면 열려 있는 대화도 오래되면 지웁니다.")} dim={!s.enabled}>
			<Switch checked={s.onlyClosed} disabled={busy || !s.enabled} label={t("닫은 대화만")} onchange={(on) => void save({ ...s, onlyClosed: on })} />
		</SettingRow>
		{#if s.enabled}
			<div class="status">
				<span class="hint">
					{t("지금 기준으로 {n}개가 대상입니다", { n: info.due })}{#if info.lastRun} · {t("마지막 정리 {when}", { when: new Date(info.lastRun).toLocaleString() })}{/if}
				</span>
				<Button size="sm" disabled={busy || info.due === 0} onclick={() => void runNow()}>{t("지금 정리")}</Button>
			</div>
		{/if}
		{#if note}<p class="hint" role="status">{note}</p>{/if}
		{#if error}<p class="hint danger" role="alert">{error}</p>{/if}
	</section>
{/if}

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.hint {
		margin: 0;
	}
	.danger {
		color: var(--danger);
	}
</style>
