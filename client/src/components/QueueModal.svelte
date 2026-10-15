<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import Badge from "./Badge.svelte";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";

	/**
	 * Lists the messages that were queued (follow_up) or steered but not delivered yet, and removes them one at a
	 * time. Like the slash menu: ↑/↓ moves the highlight, Enter / Delete / Backspace or a click removes the row.
	 */
	const chat = $derived(app.chatOf(app.queueDialog));
	const items = $derived(chat?.queued ?? []);
	let listEl = $state<HTMLElement | null>(null);
	// The highlighted row, like the slash menu: arrows move it, Enter / Delete removes it.
	let index = $state(0);

	const close = () => (app.queueDialog = null);

	// Nothing left to manage: close.
	$effect(() => {
		if (!chat || !items.length) close();
	});

	// Keep the highlight inside the list as rows disappear.
	$effect(() => {
		if (index > items.length - 1) index = Math.max(0, items.length - 1);
	});

	$effect(() => {
		index;
		listEl?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
	});

	async function remove(i: number) {
		const item = items[i];
		if (!item) return;
		index = i;
		await app.cancelQueued({ mode: item.mode, text: item.text });
	}

	function onKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		const n = items.length;
		if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
			e.preventDefault();
			index = (index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
		} else if (n && !(e.target as HTMLElement).closest("button") && (e.key === "Enter" || e.key === "Delete" || e.key === "Backspace")) {
			e.preventDefault();
			void remove(index);
		}
	}

	// Focus the list itself (not a button) so the highlighted row, not an x, is what shows.
	function focusList(node: HTMLElement) {
		queueMicrotask(() => node.focus());
	}
</script>

<Modal onclose={close} title={t("대기열 관리")} compact width="m" maxHeight="560px" layer={4} elevated portal safeArea>
	<!-- arrows move between rows from anywhere in the dialog, the close button included -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="keys" onkeydown={onKey}>
	<ul bind:this={listEl} use:focusList tabindex="-1" role="listbox" aria-label={t("대기열 관리")}>
		{#each items as q, i (q.mode + "\u0000" + q.text + "\u0000" + i)}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<li
				class:on={i === index}
				role="option"
				aria-selected={i === index}
				data-i={i}
				title={q.text}
				onmousemove={() => (index = i)}
				onclick={() => remove(i)}
			>
				<Badge variant="outline" size="sm" mono square tone={q.mode === "steer" ? "accent" : "neutral"}>{q.mode === "steer" ? t("끼워 넣기") : t("대기열")}</Badge>
				<span class="qt">{q.text}</span>
				<span class="rm" aria-hidden="true"><Icon name="x" /></span>
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
	ul:focus {
		outline: none;
	}
	li:not(.empty) {
		cursor: pointer;
	}
	li.on {
		background: var(--bg-active);
	}
	.rm {
		flex: none;
		display: inline-flex;
		color: var(--text-faint);
	}
	li.on .rm {
		color: var(--text);
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
