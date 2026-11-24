<script lang="ts">
	import { onDestroy, untrack } from "svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import QueueBadge from "./QueueBadge.svelte";
	import QueueText from "./QueueText.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import DialogBody from "../ui/DialogBody.svelte";
	import DialogFooter from "../ui/DialogFooter.svelte";
	import { orderQueued, queuedShown, type QueuedItem } from "../../lib/queue";
	import { CopyFlag } from "../../lib/copy-flag.svelte";
	import Modal from "../ui/Modal.svelte";

	/**
	 * The messages that were queued (follow_up) or steered but not delivered yet. ↑/↓ selects a row; Enter, Delete,
	 * Backspace or its ✕ takes it back to the input and closes the dialog. Clicking a row still opens its full text.
	 */
	const chat = $derived(app.chatOf(app.queueDialog));
	const items = $derived(orderQueued(chat?.waiting ?? []));
	const uid = $props.id();
	const optionId = (i: number) => `${uid}-queue-${i}`;
	let listEl = $state<HTMLElement | null>(null);
	let index = $state(0);
	let removing = $state(false);
	let pendingKey: { key: string; item: QueuedItem } | null = null;
	// The message shown in full (null = the list). Taken once from the composer row that opened the dialog.
	let detail = $state<QueuedItem | null>(untrack(() => app.queueItem));
	// Later requests (the dialog already open) switch to that message.
	$effect(() => {
		const it = app.queueItem;
		if (!it) return;
		app.queueItem = null;
		untrack(() => {
			detail = it;
			last = null;
		});
	});
	const same = (a: QueuedItem, b: QueuedItem) => a.mode === b.mode && a.text === b.text && !!a.deferred === !!b.deferred;
	// The live row of the detail (its number moves as earlier ones go); null once it was delivered or taken out elsewhere.
	const shown = $derived(detail ? (items.find((q) => same(q, detail!)) ?? null) : null);
	// What the detail keeps showing after its message left the queue, so the text does not vanish under the reader.
	let last = $state<(QueuedItem & { n: number }) | null>(null);
	$effect(() => {
		if (shown) last = shown;
	});
	const view = $derived(shown ?? last);
	const copied = new CopyFlag();
	onDestroy(() => copied.dispose());

	const close = () => (app.queueDialog = null);
	function back() {
		const i = shown ? items.indexOf(shown) : -1;
		detail = null;
		last = null;
		if (i >= 0) index = i;
		if (!items.length) close();
	}

	// Nothing left to manage: close (the detail of a message that just left stays until it is closed or left).
	$effect(() => {
		if (!removing && app.queueDialog && (!chat || (!items.length && !detail))) close();
	});

	// Keep the highlight inside the list as rows disappear.
	$effect(() => {
		if (index > items.length - 1) index = Math.max(0, items.length - 1);
	});

	$effect(() => {
		const id = optionId(index);
		listEl?.querySelector<HTMLElement>(`[id="${id}"]`)?.scrollIntoView({ block: "nearest" });
	});

	async function remove(item: QueuedItem) {
		const id = app.queueDialog;
		if (!id || removing) return;
		removing = true;
		try {
			if (await app.cancelQueued(item, id) && app.queueDialog === id) close();
		} finally {
			removing = false;
		}
	}
	function open(i: number) {
		const item = items[i];
		if (!item || removing) return;
		index = i;
		detail = item;
	}

	function onKey(e: KeyboardEvent) {
		if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.target !== listEl) return;
		const n = items.length;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (n && !removing && !pendingKey) index = (index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
		} else if (e.key === "Enter" || e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			const item = items[index];
			if (!e.repeat && !removing && !pendingKey && item) pendingKey = { key: e.key, item };
		}
	}

	function onKeyUp(e: KeyboardEvent) {
		const pending = pendingKey;
		if (e.key !== pending?.key) return;
		pendingKey = null;
		if (e.isComposing || e.target !== listEl) return;
		// Wait for release so a held Enter or Backspace cannot act on the returned draft after focus moves back.
		const item = items[index];
		if (item && same(item, pending.item)) void remove(item);
	}

	// Focus the list itself (not a button) so the highlighted row, not an x, is what shows.
	function focusList(node: HTMLElement) {
		queueMicrotask(() => node.focus({ preventScroll: true }));
	}
</script>

<!-- One dialog for both views, so switching between them does not animate a second panel in. In the detail, Esc and the
     back arrow return to the list and the ✕ closes the dialog. -->
<!-- The detail takes the full header (its back arrow and the copy button sit on the body's 24px gutter); the list keeps the compact one.
     Both views are as wide and tall as the other reading dialogs (SessionContext) so a long message is not a narrow
     column, and opening a row does not resize the dialog. -->
<Modal closeShortcut="cancelQueue" dismissible={!removing} onclose={close} onescape={detail ? back : undefined} onback={detail ? back : undefined} title={view && detail ? `${view.mode === "steer" ? t("끼워 넣기") : t("대기열")} ${view.n}` : t("대기열 관리")} sub={detail ? undefined : t("↑↓ 선택 · Enter로 빼기")} compact={!detail} headerActions={view && detail ? copyAction : undefined} width="xl" maxHeight="760px" layer={4} elevated portal safeArea>
	{#if view && detail}
		<DialogBody>
			<p class="when">
				<QueueBadge q={view} />
				<span>{view.mode === "steer" ? t("지금 답변 중에 전달") : t("현재 작업이 모두 끝난 뒤 실행")}</span>
			</p>
			<QueueText text={view.text} full />
		</DialogBody>
		<DialogFooter rule>
			{#if shown}
				<Button size="sm" variant="danger" title={t("빼면 내용이 입력창으로 돌아옵니다")} disabled={removing} onclick={() => { if (shown) void remove(shown); }}>{t("대기열에서 빼기")}</Button>
			{:else}
				<span class="gone" role="status">{t("이미 전달되었습니다")}</span>
			{/if}
		</DialogFooter>
	{:else}
		<ul bind:this={listEl} use:focusList tabindex="0" role="listbox" aria-label={t("대기열 관리")} aria-activedescendant={items.length ? optionId(index) : undefined} onkeydown={onKey} onkeyup={onKeyUp} onblur={() => (pendingKey = null)}>
			{#each items as q, i (q.mode + "\u0000" + q.text + "\u0000" + i)}
				<!-- Enter removes the highlighted row; a pointer click opens its details. -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					class:on={i === index}
					role="option"
					aria-selected={i === index}
					id={optionId(i)}
					onmousemove={() => { if (!removing && !pendingKey) index = i; }}
					onclick={() => open(i)}
				>
					<QueueBadge {q} />
					<QueueText text={q.text} />
					<button type="button" class="rm tap" tabindex="-1" disabled={removing} aria-label={t("{name} 취소", { name: queuedShown(q.text) })} title={t("대기열에서 빼기")} onclick={(e) => { e.stopPropagation(); index = i; void remove(q); }}><Icon name="x" /></button>
				</li>
			{:else}
				<EmptyState as="li" tone="plain" compact>{t("대기 중인 메시지가 없습니다")}</EmptyState>
			{/each}
		</ul>
	{/if}
</Modal>

{#snippet copyAction()}
	<IconButton icon={copied.done ? "check" : "copy"} label={copied.done ? t("복사됨") : t("복사")} tip onclick={() => view && void copied.copy(queuedShown(view.text), chat?.ownImages(view.text) ?? [])} />
{/snippet}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 8px 12px 12px;
		overflow-x: hidden;
		overflow-y: auto;
	}
	li {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 0 4px 0 12px;
		border-radius: var(--radius);
		font-size: var(--fs-sm);
		line-height: 20px;
	}
	ul:focus {
		outline: none;
	}
	li {
		cursor: pointer;
	}
	li.on {
		background: var(--bg-active);
	}
	.rm {
		flex: none;
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	li.on .rm {
		color: var(--text-dim);
	}
	@media (hover: hover) {
		.rm:hover {
			color: var(--text);
			background: var(--bg-hover);
		}
	}
	.rm :global(svg) {
		width: 16px;
		height: 16px;
	}
	.when {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 12px;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
	}
	.gone {
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-faint);
	}
</style>
