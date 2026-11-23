<script lang="ts">
	import type { IconName } from "../../lib/icons";
	import { surfaceIn, surfaceOut } from "../../lib/motion";
	import { app } from "../../lib/store.svelte";
	import { layoutToastStack, STACK_DEFAULT_HEIGHT } from "../../lib/toast-stack";
	import CountdownClose from "../ui/CountdownClose.svelte";
	import Icon from "../ui/Icon.svelte";
	import type { Toast } from "../../lib/feedback.svelte";

	const TONE_ICON: Record<Toast["tone"], IconName> = {
		info: "info",
		ok: "check",
		warn: "alert",
		error: "alert-circle",
	};

	/**
	 * Floating rounded toast deck, shared by the global tray (Toasts) and a pane's own (SessionToasts).
	 * Each card is at least as wide as the chat composer (`--content-w`, clamped to the pane/device width) and grows
	 * up to the available width for longer messages. Multiple toasts stack into a compact deck with 8px peeks; hovering
	 * (desktop), tapping once (touch), or focusing expands the deck, reveals clamped multi-line text in full, and pauses
	 * auto-dismiss countdowns while reading.
	 */
	let { toasts, compact = false, from = "top" }: { toasts: Toast[]; compact?: boolean; from?: "top" | "bottom" } = $props();

	const ordered = $derived([...toasts].reverse());
	const ids = $derived(ordered.map((t) => t.id));
	const dyIn = $derived(from === "bottom" ? 20 : -20);
	const dyOut = $derived(from === "bottom" ? 16 : -16);
	const defaultH = $derived(compact ? 40 : STACK_DEFAULT_HEIGHT);

	let stackEl = $state<HTMLDivElement | null>(null);
	let hovered = $state(false);
	let pinned = $state(false);
	let focused = $state(false);
	let heights = $state<Record<number, number>>({});
	let widths = $state<Record<number, number>>({});

	const revealFull = $derived(hovered || pinned || focused);
	const expanded = $derived(ordered.length > 1 && revealFull);
	const paused = $derived(ordered.length > 0 && revealFull);
	const layout = $derived(layoutToastStack(ids, heights, expanded, from, defaultH));
	const slotById = $derived(new Map(layout.items.map((item) => [item.id, item])));

	const frontId = $derived(ordered[0]?.id);
	const frontW = $derived(frontId !== undefined ? widths[frontId] : undefined);
	const frontH = $derived(frontId !== undefined ? heights[frontId] : undefined);
	const stackW = $derived.by(() => {
		if (!ordered.length) return 0;
		if (!expanded) return frontW ?? 0;
		let max = 0;
		for (const item of ordered) max = Math.max(max, widths[item.id] ?? 0);
		return max;
	});

	// Clear touch-pinned state once all toasts are dismissed.
	$effect(() => {
		if (ordered.length === 0 && pinned) pinned = false;
	});

	// Prune stale measurements for dismissed toasts.
	$effect(() => {
		const live = new Set(ids);
		for (const key of Object.keys(heights)) {
			const id = Number(key);
			if (!live.has(id)) {
				delete heights[id];
				delete widths[id];
			}
		}
	});

	// Pause auto-dismiss timers while the user is reading the stack, and always resume on leave or unmount.
	$effect(() => {
		if (!paused) return;
		const currentIds = [...ids];
		for (const id of currentIds) app.feedback.pauseToast(id);
		return () => {
			for (const id of currentIds) app.feedback.resumeToast(id);
		};
	});

	// Dismiss touch-expanded deck when tapping anywhere outside the stack.
	$effect(() => {
		if (!pinned) return;
		const onOutside = (e: PointerEvent) => {
			if (!stackEl?.contains(e.target as Node | null)) pinned = false;
		};
		window.addEventListener("pointerdown", onOutside, true);
		return () => window.removeEventListener("pointerdown", onOutside, true);
	});

	function measureCard(node: HTMLElement, id: number) {
		const update = () => {
			// .card wraps .inner with a 1px border on each side; include those 2px so stacked clipping and 8px gaps stay exact
			const h = Math.ceil(node.offsetHeight) + 2;
			const w = Math.ceil(node.offsetWidth) + 2;
			if (h > 2 && heights[id] !== h) heights[id] = h;
			if (w > 2 && widths[id] !== w) widths[id] = w;
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(node);
		return {
			destroy() {
				ro.disconnect();
			},
		};
	}

	function onPointerEnter(e: PointerEvent) {
		if (e.pointerType === "mouse") hovered = true;
	}
	function onPointerLeave(e: PointerEvent) {
		if (e.pointerType === "mouse") hovered = false;
	}
	function onFocusOut(e: FocusEvent) {
		if (!stackEl?.contains(e.relatedTarget as Node | null)) focused = false;
	}
	function onCardClick(e: MouseEvent) {
		if ((e.target as Element | null)?.closest("button")) return;
		if (ordered.length > 1 && !expanded) {
			pinned = true;
			return;
		}
		// Single toast whose message is clamped past 2 lines: tap reveals the full message.
		if (ordered.length === 1 && !pinned) {
			const msg = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(".msg");
			if (msg && msg.scrollHeight > msg.clientHeight + 1) pinned = true;
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="toast-stack"
	class:empty={ordered.length === 0}
	class:bottom={from === "bottom"}
	class:expanded
	class:stacked={ordered.length > 1 && !expanded}
	bind:this={stackEl}
	style:height="{layout.height}px"
	onpointerenter={onPointerEnter}
	onpointerleave={onPointerLeave}
	onfocusin={() => (focused = true)}
	onfocusout={onFocusOut}
>
	{#if expanded || ordered.length > 1}
		<div class="hit" style:width={stackW ? `${stackW}px` : null} aria-hidden="true"></div>
	{/if}
	{#each ordered as item (item.id)}
		{@const slot = slotById.get(item.id)}
		{#if slot}
			<div
				class="slot"
				class:hidden={slot.hidden}
				class:behind={slot.behind}
				style:z-index={slot.z}
				style:opacity={slot.opacity}
				style:transform="translate3d(0, {slot.y}px, 0) scale({slot.scale})"
			>
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
				<div
					class="card {item.tone}"
					class:compact
					class:behind={slot.behind}
					class:expandable={ordered.length > 1 && !expanded && !slot.behind}
					role={item.tone === "error" ? "alert" : "status"}
					style:width={slot.behind && frontW ? `${frontW}px` : null}
					style:min-width={slot.behind && frontW ? "0" : null}
					style:height={slot.behind && frontH ? `${frontH}px` : null}
					in:surfaceIn={{ y: dyIn }}
					out:surfaceOut={{ y: dyOut }}
					onclick={onCardClick}
				>
					<div class="inner" use:measureCard={item.id}>
						<span class="tone-ic" aria-hidden="true">
							<Icon name={item.icon ?? TONE_ICON[item.tone]} />
						</span>
						<div class="body">
							<span class="msg" class:clamped={!revealFull}>{item.text}</span>
							{#if item.action}
								{@const act = item.action}
								<button
									type="button"
									class="act"
									onclick={() => {
										act.run();
										app.feedback.dismissToast(item.id);
									}}
								>
									{act.label}
								</button>
							{/if}
						</div>
						<CountdownClose ms={item.ms} {paused} onclick={() => app.feedback.dismissToast(item.id)} />
					</div>
				</div>
			</div>
		{/if}
	{/each}
</div>

<style>
	.toast-stack {
		position: relative;
		width: 100%;
		margin-inline: auto;
		pointer-events: none;
		transition: height var(--motion-normal) var(--ease);
	}
	/* Bridges the 8px gaps between cards while expanded/stacked so moving the pointer down the list never drops hover. */
	.hit {
		position: absolute;
		top: 0;
		bottom: 0;
		inset-inline: 0;
		margin-inline: auto;
		max-width: 100%;
		z-index: 0;
		pointer-events: auto;
	}
	.slot {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		display: flex;
		justify-content: center;
		pointer-events: none;
		/* Pin scale to the bottom edge so cards peeking below a tall front card keep an exact 8px reveal regardless of height. */
		transform-origin: center bottom;
		transition:
			transform var(--motion-normal) var(--ease),
			opacity var(--motion-fast) var(--ease);
	}
	.toast-stack.bottom .slot {
		top: auto;
		bottom: 0;
		transform-origin: center top;
	}
	.slot.hidden {
		pointer-events: none;
	}
	.card {
		--tone: var(--text-faint);
		pointer-events: auto;
		/* At least composer width (--content-w) when space allows, growing up to the viewport/pane width for long messages. */
		width: fit-content;
		min-width: min(var(--content-w), 100%);
		max-width: 100%;
		border-radius: var(--radius-panel);
		/* elevated rounded card tinted subtly with its tone */
		background: color-mix(in srgb, var(--tone) 12%, var(--bg-lift));
		border: 1px solid color-mix(in srgb, var(--tone) 28%, var(--border-strong));
		box-shadow: var(--shadow-soft);
		color: var(--text);
		font-size: var(--fs-sm);
		line-height: 20px;
		transition:
			width var(--motion-normal) var(--ease),
			height var(--motion-normal) var(--ease),
			border-color var(--motion-fast) var(--ease);
	}
	.card.expandable {
		cursor: pointer;
	}
	.card.behind {
		overflow: hidden;
		pointer-events: none;
	}
	.card.behind .inner {
		opacity: 0;
	}
	.card.ok {
		--tone: var(--ok);
	}
	.card.warn {
		--tone: var(--warn);
	}
	.card.error {
		--tone: var(--danger);
	}
	.inner {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 4px 4px 4px 16px;
		max-width: 100%;
		transition: opacity var(--motion-fast) var(--ease);
	}
	.card.compact .inner {
		min-height: 40px;
	}
	.tone-ic {
		flex: none;
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		color: var(--tone);
	}
	.tone-ic :global(svg) {
		width: 16px;
		height: 16px;
	}
	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
	}
	.msg {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: keep-all;
	}
	.msg.clamped {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	.act {
		flex: none;
		padding: 4px 8px;
		border-radius: var(--radius-control);
		color: var(--text);
		font-weight: 600;
		line-height: 20px;
		white-space: nowrap;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	@media (hover: hover) {
		.act:hover {
			background: color-mix(in srgb, var(--tone) 16%, transparent);
		}
	}
	@media (max-width: 640px) {
		.body {
			flex-direction: column;
			align-items: flex-start;
			gap: 4px;
		}
		.act {
			padding: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.toast-stack,
		.slot,
		.card,
		.inner {
			transition-duration: 0.01ms !important;
		}
	}
</style>
