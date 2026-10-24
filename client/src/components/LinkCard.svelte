<script lang="ts">
	import { isPlainHttpOnOpenNetwork } from "../lib/pairing";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import PipayaMark from "./PipayaMark.svelte";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";

	const link = $derived(app.linking);

	// a success needs no click: show it for a moment, then get out of the way
	$effect(() => {
		if (link?.state !== "done") return;
		const timer = setTimeout(() => app.closeLinking(), 1400);
		return () => clearTimeout(timer);
	});
</script>

{#if link}
	<Modal onclose={() => app.closeLinking()} dismissible={link.state !== "working"} label={t("서버 연결")} live="polite" width="360px" gutter="32px" layer={4} sheet={false}>
	<div class="card">
		<div class="mark" class:ok={link.state === "done"} class:bad={link.state === "failed"}>
			{#if link.state === "working"}<PipayaMark size={34} />
			{:else if link.state === "confirm"}<Icon name="alert" />
			{:else if link.state === "done"}<Icon name="check" />
			{:else}<Icon name="alert" />{/if}
		</div>
		<h2>
			{#if link.state === "confirm"}{t("이 서버에 연결할까요?")}
			{:else if link.state === "working"}{t("서버에 연결하는 중…")}
			{:else if link.state === "done"}{t("연결됐습니다")}
			{:else}{t("연결하지 못했습니다")}{/if}
		</h2>
		<p class="who"><b>{link.name}</b><span class="mono">{link.baseUrl}</span></p>
		{#if link.state === "confirm"}
			{#if isPlainHttpOnOpenNetwork(link.baseUrl)}<p class="warn">{t("암호화되지 않은 http 주소입니다. 인터넷을 거치면 토큰이 그대로 노출될 수 있습니다. Tailscale 주소를 쓰거나 https로 연결하세요.")}</p>{/if}
			<p class="warn">{t("링크를 보낸 사람이 믿을 수 있는지, 위 주소가 내 서버가 맞는지 확인하세요. 연결하면 이 서버가 목록에 추가됩니다.")}</p>
			<div class="actions">
				<button class="btn" onclick={() => app.closeLinking()}>{t("취소")}</button>
				<button class="btn primary" onclick={() => void app.confirmLinking()}>{t("연결")}</button>
			</div>
		{:else if link.state === "failed"}
			<p class="why" role="alert">{link.error}</p>
			<button class="btn primary" onclick={() => app.closeLinking()}>{t("닫기")}</button>
		{/if}
	</div>
	</Modal>
{/if}

<style>
	.card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 30px 24px 24px;
		text-align: center;
	}
	.mark {
		width: 64px;
		height: 64px;
		display: grid;
		place-items: center;
		border-radius: var(--radius);
		border: 1px solid var(--border-strong);
		background: var(--bg);
		color: var(--text);
	}
	.mark.ok {
		color: var(--ok);
		border-color: var(--ok);
	}
	.mark.bad {
		color: var(--danger);
		border-color: var(--danger);
	}
	.mark :global(svg:not(.logo)) {

		width: 28px;

		height: 28px;

		stroke-width: 2;

	}
	h2 {
		margin: 4px 0 0;
		font-size: var(--fs-xl);
	}
	.who {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
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
		margin: 6px 0 4px;
		padding: 10px 12px;
		border-radius: var(--radius);
		background: var(--warn-soft);
		color: var(--warn);
		font-size: var(--fs-sm);
		line-height: 1.55;
		word-break: keep-all;
	}
	.actions {
		display: flex;
		gap: 8px;
		justify-content: center;
	}
	.why {
		margin: 6px 0 4px;
		padding: 10px 12px;
		border-radius: var(--radius);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: var(--fs-sm);
		line-height: 1.55;
		word-break: keep-all;
	}
</style>
