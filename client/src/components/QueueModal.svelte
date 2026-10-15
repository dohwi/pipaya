<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import Badge from "./Badge.svelte";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";

	/**
	 * Lists the messages that were queued (follow_up) or steered but not delivered yet, and removes them one at a
	 * time. Click the x, or press Delete / Backspace / Enter on a focused row.
	 */
	const chat = $derived(app.chatOf(app.queueDialog));
	const items = $derived(chat?.queued ?? []);
	let listEl = $state<HTMLElement | null>(null);

	const close = () => (app.queueDialog = null);

	// Nothing left to manage: close.
	$effect(() => {
		if (!chat || !items.length) close();
	});

	async function remove(i: number) {
		const item = items[i];
		if (!item) return;
		await app.cancelQueued({ mode: item.mode, text: item.text });
		// Keep the keyboard on the list: focus the row that took this one's place.
		queueMicrotask(() => {
			const rows = listEl?.querySelectorAll<HTMLElement>(".rm");
			rows?.[Math.min(i, rows.length - 1)]?.focus();
		});
	}

	function onKey(e: KeyboardEvent) {
		const rows = [...(listEl?.querySelectorAll<HTMLElement>(".rm") ?? [])];
		const at = rows.indexOf(document.activeElement as HTMLElement);
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (!rows.length) return;
			rows[(Math.max(at, 0) + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
		} else if ((e.key === "Delete" || e.key === "Backspace") && at >= 0) {
			e.preventDefault();
			void remove(at);
		}
	}

	function focusFirst(node: HTMLElement) {
		queueMicrotask(() => node.querySelector<HTMLElement>(".rm")?.focus());
	}
</script>

<Modal onclose={close} label={t("대기열 관리")} width="m" maxHeight="560px" layer={4} elevated portal safeArea>
	<!-- arrows move between rows from anywhere in the dialog, the close button included -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="keys" onkeydown={onKey}>
	<div class="head-row">
		<h2>{t("대기열 관리")}</h2>
		<button type="button" class="iconbtn" onclick={close} aria-label={t("닫기")}><Icon name="x" /></button>
	</div>
	<ul bind:this={listEl} use:focusFirst>
		{#each items as q, i (q.mode + "\u0000" + q.text + "\u0000" + i)}
			<li>
				<Badge variant="outline" size="sm" mono square tone={q.mode === "steer" ? "accent" : "neutral"}>{q.mode === "steer" ? t("끼워 넣기") : t("대기열")}</Badge>
				<span class="qt" title={q.text}>{q.text}</span>
				<button type="button" class="iconbtn sm rm" onclick={() => remove(i)} aria-label={t("{name} 취소", { name: q.text })} title={t("취소")}><Icon name="x" /></button>
			</li>
		{:else}
			<li class="empty">{t("대기 중인 메시지가 없습니다")}</li>
		{/each}
	</ul>
	</div>
</Modal>

<style>
	.keys {
		display: contents;
	}
	.head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 8px 4px 18px;
	}
	h2 {
		margin: 0;
		font-size: var(--fs-lg);
		font-weight: 600;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 6px 10px 12px;
		overflow-y: auto;
	}
	li {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 0 4px 0 8px;
		border-radius: var(--radius);
		font-size: var(--fs-sm);
	}
	li:hover {
		background: var(--bg-hover);
	}
	.qt {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		color: var(--text-faint);
		justify-content: center;
	}
</style>
