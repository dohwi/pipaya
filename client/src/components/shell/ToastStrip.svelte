<script lang="ts">
	import { surfaceIn, surfaceOut } from "../../lib/motion";
	import { app } from "../../lib/store.svelte";
	import { layoutToastStack, STACK_DEFAULT_HEIGHT } from "../../lib/toast-stack";
	import CountdownClose from "../ui/CountdownClose.svelte";
	import type { Toast } from "../../lib/feedback.svelte";

	/**
	 * Floating rounded toast deck, shared by the global tray (Toasts) and a pane's own (SessionToasts).
	 * Each toast sizes to its message and drops in from the anchor edge; when multiple toasts arrive at once they
	 * stack into a compact deck so they don't cover the screen, expanding on mouse hover (desktop), one tap (touch),
	 * or keyboard focus. While hovered/expanded, auto-dismiss countdowns pause so the user can read and act.
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

	const expanded = $derived(ordered.length > 1 && (hovered || pinned || focused));
	const paused = $derived(ordered.length > 0 && (hovered || pinned || focused));
	const layout = $derived(layoutToastStack(ids, heights, expanded, from, defaultH));
	const slotById = $derived(new Map(layout.items.map((item) => [item.id, item])));

	const frontId = $derived(ordered[0]?.id);
	const frontH = $derived(frontId !== undefined ? heights[frontId] : undefined);

	// Collapse touch-pinned state automatically once fewer than two toasts remain.
	$effect(() => {
		if (ordered.length <= 1 && pinned) pinned = false;
	});

	// Prune stale measurements for dismissed toasts.
	$effect(() => {
		const live = new Set(ids);
		for (const key of Object.keys(heights)) {
			const id = Number(key);
			if (!live.has(id)) delete heights[id];
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
			if (h > 2 && heights[id] !== h) heights[id] = h;
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
		if (expanded || ordered.length <= 1) return;
		if ((e.target as Element | null)?.closest("button")) return;
		pinned = true;
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
		<div class="hit" aria-hidden="true"></div>
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
					style:height={slot.behind && frontH ? `${frontH}px` : null}
					in:surfaceIn={{ y: dyIn }}
					out:surfaceOut={{ y: dyOut }}
					onclick={onCardClick}
				>
					<div class="inner" use:measureCard={item.id}>
						<span class="dot" aria-hidden="true"></span>
						<span class="msg">{item.text}</span>
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
		/* aligns left/right edges with the chat composer (--content-w) */
		max-width: var(--content-w);
		margin-inline: auto;
		pointer-events: none;
		transition: height var(--motion-normal) var(--ease);
	}
	/* Bridges the 8px gaps between cards while expanded/stacked so moving the pointer down the list never drops hover. */
	.hit {
		position: absolute;
		inset: 0;
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
		transform-origin: center top;
		transition:
			transform var(--motion-normal) var(--ease),
			opacity var(--motion-fast) var(--ease);
	}
	.toast-stack.bottom .slot {
		top: auto;
		bottom: 0;
		transform-origin: center bottom;
	}
	.slot.hidden {
		pointer-events: none;
	}
	.card {
		--tone: var(--text-faint);
		pointer-events: auto;
		width: 100%;
		border-radius: var(--radius-panel);
		/* elevated rounded card tinted subtly with its tone */
		background: color-mix(in srgb, var(--tone) 12%, var(--bg-lift));
		border: 1px solid color-mix(in srgb, var(--tone) 28%, var(--border-strong));
		box-shadow: var(--shadow-soft);
		color: var(--text);
		font-size: var(--fs-sm);
		line-height: 20px;
		transition:
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
	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: var(--radius-pill);
		background: var(--tone);
	}
	.msg {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: keep-all;
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
	@media (prefers-reduced-motion: reduce) {
		.toast-stack,
		.slot,
		.card,
		.inner {
			transition-duration: 0.01ms !important;
		}
	}
</style>
