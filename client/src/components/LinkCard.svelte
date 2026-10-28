<script lang="ts">
	import Button from "./Button.svelte";
	import { isPlainHttpOnOpenNetwork } from "../lib/pairing";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import PipayaMark from "./PipayaMark.svelte";
	import Icon from "./Icon.svelte";
	import StatusCard from "./StatusCard.svelte";

	const link = $derived(app.linking);

	// a success needs no click: show it for a moment, then get out of the way
	$effect(() => {
		if (link?.state !== "done") return;
		const timer = setTimeout(() => app.closeLinking(), 1400);
		return () => clearTimeout(timer);
	});
</script>

{#if link}
	<StatusCard
		onclose={() => app.closeLinking()}
		dismissible={link.state !== "working"}
		label={t("서버 연결")}
		tone={link.state === "done" ? "ok" : link.state === "failed" ? "bad" : "neutral"}
		title={link.state === "confirm" ? t("이 서버에 연결할까요?") : link.state === "working" ? t("서버에 연결하는 중…") : link.state === "done" ? t("연결됐습니다") : t("연결하지 못했습니다")}
	>
		{#snippet mark()}
			{#if link.state === "working"}<PipayaMark size={34} />
			{:else if link.state === "done"}<Icon name="check" />
			{:else}<Icon name="alert" />{/if}
		{/snippet}
		<p class="who"><b>{link.name}</b><span class="mono">{link.baseUrl}</span></p>
		{#if link.state === "confirm"}
			{#if isPlainHttpOnOpenNetwork(link.baseUrl)}<p class="warn">{t("암호화되지 않은 http 주소입니다. Tailscale 주소나 https를 권장합니다.")}</p>{/if}
			<p class="warn">{t("링크를 보낸 사람이 믿을 수 있는지, 위 주소가 내 서버가 맞는지 확인하세요. 연결하면 이 서버가 목록에 추가됩니다.")}</p>
			<div class="actions">
				<Button onclick={() => app.closeLinking()}>{t("취소")}</Button>
				<Button variant="primary" onclick={() => void app.confirmLinking()}>{t("연결")}</Button>
			</div>
		{:else if link.state === "failed"}
			<p class="why" role="alert">{link.error}</p>
			<Button variant="primary" onclick={() => app.closeLinking()}>{t("닫기")}</Button>
		{/if}
	</StatusCard>
{/if}

<style>
	.who {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-width: 100%;
	}
	.who b {
		font-size: var(--fs-md);
	}
	.who .mono {
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.warn {
		margin: 4px 0 4px;
		padding: 8px 12px;
		border-radius: var(--radius);
		background: var(--warn-soft);
		color: var(--warn);
		font-size: var(--fs-sm);
		line-height: 1.55;
		word-break: keep-all;
	}
	.why {
		margin: 4px 0 4px;
		padding: 8px 12px;
		border-radius: var(--radius);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: var(--fs-sm);
		line-height: 1.55;
		word-break: keep-all;
	}
</style>
