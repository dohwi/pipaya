<script lang="ts">
	import { onDestroy, untrack } from "svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import QueueBadge from "./QueueBadge.svelte";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import DialogBody from "../ui/DialogBody.svelte";
	import DialogFooter from "../ui/DialogFooter.svelte";
	import { orderQueued, type QueuedItem } from "../../lib/queue";
	import { CopyFlag } from "../../lib/copy-flag.svelte";
	import Modal from "../ui/Modal.svelte";

	/**
	 * The messages that were queued (follow_up) or steered but not delivered yet. The list is like the slash menu: ↑/↓ moves
	 * the highlight, Enter or a click opens the row in full (the composer shows one cut line), Delete / Backspace or the ✕
	 * takes it out. The detail view shows the whole text, copies it, and takes it out (the text goes back to the input).
	 */
	const chat = $derived(app.chatOf(app.queueDialog));
	const items = $derived(orderQueued(chat?.waiting ?? []));
	let listEl = $state<HTMLElement | null>(null);
	// The highlighted row, like the slash menu: arrows move it, Enter opens it, Delete removes it.
	let index = $state(0);
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
		if (!chat || (!items.length && !detail)) close();
	});

	// Keep the highlight inside the list as rows disappear.
	$effect(() => {
		if (index > items.length - 1) index = Math.max(0, items.length - 1);
	});

	$effect(() => {
		index;
		listEl?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
	});

	async function remove(item: QueuedItem) {
		await app.cancelQueued({ mode: item.mode, text: item.text });
	}
	async function removeShown() {
		if (!shown) return;
		await remove(shown);
		back();
	}
	function open(i: number) {
		const item = items[i];
		if (!item) return;
		index = i;
		detail = item;
	}

	function onKey(e: KeyboardEvent) {
		if (e.isComposing || detail) return;
		const n = items.length;
		if (!n || (e.target as HTMLElement).closest("button")) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			index = (index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
		} else if (e.key === "Enter") {
			e.preventDefault();
			open(index);
		} else if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			const item = items[index];
			if (item) void remove(item);
		}
	}

	// Focus the list itself (not a button) so the highlighted row, not an x, is what shows.
	function focusList(node: HTMLElement) {
		queueMicrotask(() => node.focus());
	}
</script>

<!-- One dialog for both views, so switching between them does not animate a second panel in. In the detail, Esc and the
     back arrow return to the list and the ✕ closes the dialog. -->
<!-- The detail takes the full header (its back arrow and the copy button sit on the body's 24px gutter); the list keeps the compact one. -->
<Modal onclose={close} onescape={detail ? back : undefined} onback={detail ? back : undefined} title={view && detail ? `${view.mode === "steer" ? t("끼워 넣기") : t("대기열")} ${view.n}` : t("대기열 관리")} compact={!detail} headerActions={view && detail ? copyAction : undefined} width="m" maxHeight="560px" layer={4} elevated portal safeArea>
	{#if view && detail}
		<DialogBody>
			<p class="when">
				<QueueBadge q={view} />
				<span>{view.mode === "steer" ? t("지금 답변 중에 전달") : t("현재 작업이 모두 끝난 뒤 실행")}</span>
			</p>
			<p class="full">{view.text}</p>
		</DialogBody>
		<DialogFooter rule>
			{#if shown}
				<Button size="sm" variant="danger" title={t("빼면 내용이 입력창으로 돌아옵니다")} onclick={removeShown}>{t("대기열에서 빼기")}</Button>
			{:else}
				<span class="gone" role="status">{t("이미 전달되었습니다")}</span>
			{/if}
		</DialogFooter>
	{:else}
		<!-- arrows move between rows from anywhere in the dialog, the close button included -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="keys" onkeydown={onKey}>
		<ul bind:this={listEl} use:focusList tabindex="-1" role="listbox" aria-label={t("대기열 관리")}>
			{#each items as q, i (q.mode + "\u0000" + q.text + "\u0000" + i)}
				<!-- Enter on the listbox (onKey above) opens the highlighted row; the click is for a pointer. -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					class:on={i === index}
					role="option"
					aria-selected={i === index}
					data-i={i}
					onmousemove={() => (index = i)}
					onclick={() => open(i)}
				>
					<QueueBadge {q} />
					<span class="qt">{q.text}</span>
					<button type="button" class="rm" tabindex="-1" aria-label={t("{name} 취소", { name: q.text })} title={t("대기열에서 빼기")} onclick={(e) => { e.stopPropagation(); index = i; void remove(q); }}><Icon name="x" /></button>
				</li>
			{:else}
				<li class="empty">{t("대기 중인 메시지가 없습니다")}</li>
			{/each}
		</ul>
		</div>
	{/if}
</Modal>

{#snippet copyAction()}
	<IconButton icon={copied.done ? "check" : "copy"} label={copied.done ? t("복사됨") : t("복사")} tip onclick={() => view && void copied.copy(view.text)} />
{/snippet}

<style>
	.keys {
		display: contents;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 8px 12px 12px;
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
	.rm:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.rm :global(svg) {
		width: 16px;
		height: 16px;
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
	.when {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 12px;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
	}
	/* The whole message as it will be sent: line breaks kept, long words and paths wrapped instead of widening the dialog. */
	.full {
		margin: 0;
		font-size: var(--fs-md);
		line-height: 20px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		user-select: text;
	}
	.gone {
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-faint);
	}
</style>
