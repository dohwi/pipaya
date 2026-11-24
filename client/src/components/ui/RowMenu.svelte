<script lang="ts" module>
	import type { IconName } from "./Icon.svelte";
	export interface RowMenuItem {
		icon: IconName;
		label: string;
		/** Tooltip; "" for none */
		title: string;
		/** Turn the icon by this many degrees (a pin shown leaning one way or the other) */
		tilt?: number;
		run: () => void;
	}
</script>

<script lang="ts">
	import Icon from "./Icon.svelte";
	import { portal } from "../../lib/dialog";
	import { surfaceIn, surfaceOut } from "../../lib/motion";
	import { anchorShifted, hoverMenuZone } from "../../lib/row-menu";

	/**
	 * The small "more" menu next to a sidebar row. Hover opens it with a mouse (and a short grace period lets the pointer
	 * travel into it); touch and keyboard open it with a click. `openAt` opens it as a context menu (right click / long
	 * press) where the pointer is. Lives on <body> because the list scrolls and clips.
	 * `open`: the id the menu is open for, so the row can highlight its button.
	 */
	let { open = $bindable(null) }: { open?: string | null } = $props();

	/** `sticky`: opened as a context menu (or via touch / keyboard), so the pointer leaving it does not close it (a click elsewhere or Esc does). */
	let shown = $state<{ id: string; items: RowMenuItem[]; top: number; left: number; sticky: boolean } | null>(null);
	let el = $state<HTMLElement | null>(null);
	let anchor: HTMLElement | null = null;
	let anchorOrigin: { top: number; left: number } | null = null;
	let leaveTimer: ReturnType<typeof setTimeout> | undefined;

	const WIDTH = 196;
	const GAP = 6;
	const ROW = 36;
	const LEAVE_MS = 160;

	function clearLeave() {
		if (leaveTimer !== undefined) {
			clearTimeout(leaveTimer);
			leaveTimer = undefined;
		}
	}
	function scheduleLeave() {
		clearLeave();
		leaveTimer = setTimeout(close, LEAVE_MS);
	}

	/** Beside the rectangle `r` (a button, or the point a right click / long press landed on). */
	function place(r: { left: number; right: number; top: number }, id: string, items: RowMenuItem[], sticky = false, trigger: HTMLElement | null = null) {
		clearLeave();
		const h = items.length * ROW + 10;
		// to the right; flips to the left when the screen edge is too close
		const left = r.right + GAP + WIDTH <= window.innerWidth - 8 ? r.right + GAP : Math.max(8, r.left - GAP - WIDTH);
		const top = Math.max(8, Math.min(r.top - 4, window.innerHeight - h - 8));
		anchor = trigger;
		anchorOrigin = trigger ? { top: r.top, left: r.left } : null;
		shown = { id, items, top, left, sticky };
		open = id;
	}
	const show = (btn: HTMLElement, id: string, items: RowMenuItem[], sticky = false) =>
		place(btn.getBoundingClientRect(), id, items, sticky, sticky ? null : btn);
	/**
	 * A context menu: right click or long press at `pt`. `key`: opened from the keyboard (the menu key / Shift+F10), so
	 * focus moves into it.
	 */
	export function openAt(pt: { x: number; y: number; key?: boolean }, id: string, items: RowMenuItem[]) {
		if (!items.length) return;
		place({ left: pt.x - GAP, right: pt.x - GAP, top: pt.y + 4 }, id, items, true);
		if (pt.key) queueMicrotask(() => el?.querySelector<HTMLElement>("button")?.focus());
	}
	export function close() {
		clearLeave();
		anchor = null;
		anchorOrigin = null;
		shown = null;
		open = null;
	}
	/** Mouse: hovering the button is enough. Touch has no hover, so it falls through to the click. */
	export function hover(e: PointerEvent, id: string, items: RowMenuItem[]) {
		if (e.pointerType === "mouse" && !(shown?.sticky && shown.id === id)) show(e.currentTarget as HTMLElement, id, items);
	}
	export function leave(e: PointerEvent) {
		if (!shown || e.pointerType !== "mouse" || shown.sticky) return;
		scheduleLeave();
	}
	export function click(e: MouseEvent, id: string, items: RowMenuItem[]) {
		const isMouse = (e as PointerEvent).pointerType === "mouse" && e.detail > 0;
		if (shown?.id === id) {
			// a mouse click lands on a menu that hover already opened: keep it; touch / keyboard toggles
			if (isMouse) return;
			return close();
		}
		show(e.currentTarget as HTMLElement, id, items, !isMouse);
		// keyboard (Enter/Space has no pointer): move into the menu
		if (e.detail === 0) queueMicrotask(() => el?.querySelector<HTMLElement>("button")?.focus());
	}

	/**
	 * Guard hover-opened menus against missed `pointerleave` events (e.g. pointer jumping to the main pane,
	 * a disappearing overlay or sidebar row, scroll, resize, or window blur).
	 */
	$effect(() => {
		const cur = shown;
		if (!cur || cur.sticky) return;
		const tracked = anchor;
		const origin = anchorOrigin;
		let checkRaf = 0;

		const verifyAnchor = () => {
			checkRaf = 0;
			if (!shown || shown.sticky || !tracked || !origin) return;
			if (!tracked.isConnected || anchorShifted(origin, tracked.getBoundingClientRect())) close();
		};
		const queueVerify = () => {
			if (!checkRaf && tracked) checkRaf = requestAnimationFrame(verifyAnchor);
		};
		const onMove = (e: PointerEvent) => {
			if (!shown || shown.sticky) return;
			if (e.pointerType !== "mouse") return close();
			if (tracked && (!tracked.isConnected || (origin && anchorShifted(origin, tracked.getBoundingClientRect())))) return close();
			const target = e.target as Node | null;
			if ((el && target && el.contains(target)) || (tracked && target && tracked.contains(target))) {
				clearLeave();
				return;
			}
			const aRect = tracked?.isConnected ? tracked.getBoundingClientRect() : null;
			const mRect = el?.isConnected ? el.getBoundingClientRect() : null;
			const zone = hoverMenuZone({ x: e.clientX, y: e.clientY }, aRect, mRect);
			if (zone === "inside") clearLeave();
			else if (zone === "corridor") {
				if (leaveTimer === undefined) scheduleLeave();
			} else close();
		};
		const onDismiss = () => close();
		const onVis = () => {
			if (document.hidden) close();
		};

		window.addEventListener("pointermove", onMove, { capture: true, passive: true });
		window.addEventListener("blur", onDismiss);
		window.addEventListener("resize", onDismiss, { passive: true });
		window.addEventListener("scroll", queueVerify, { capture: true, passive: true });
		document.addEventListener("visibilitychange", onVis);
		document.documentElement.addEventListener("pointerleave", onDismiss);
		document.documentElement.addEventListener("mouseleave", onDismiss);

		const container = tracked?.closest(".list") ?? tracked?.parentElement ?? null;
		const mo = typeof MutationObserver === "undefined" || !container ? null : new MutationObserver(queueVerify);
		if (mo && container) mo.observe(container, { childList: true, subtree: true });

		return () => {
			if (checkRaf) cancelAnimationFrame(checkRaf);
			mo?.disconnect();
			window.removeEventListener("pointermove", onMove, { capture: true });
			window.removeEventListener("blur", onDismiss);
			window.removeEventListener("resize", onDismiss);
			window.removeEventListener("scroll", queueVerify, { capture: true });
			document.removeEventListener("visibilitychange", onVis);
			document.documentElement.removeEventListener("pointerleave", onDismiss);
			document.documentElement.removeEventListener("mouseleave", onDismiss);
		};
	});

	$effect(() => () => clearLeave());

	function pick(run: () => void) {
		close();
		run();
	}
	/** Up/Down/Home/End move between the items (WAI-ARIA menu); moving does not run an item, Enter does. */
	function keys(e: KeyboardEvent) {
		const items = [...(el?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
		if (!items.length) return;
		const at = items.indexOf(document.activeElement as HTMLElement);
		const next =
			e.key === "ArrowDown" ? (at + 1) % items.length
			: e.key === "ArrowUp" ? (at - 1 + items.length) % items.length
			: e.key === "Home" ? 0
			: e.key === "End" ? items.length - 1
			: -1;
		if (next < 0) return;
		e.preventDefault();
		items[next]!.focus();
	}
	function outside(e: PointerEvent) {
		if (!shown) return;
		const target = e.target as Element | null;
		if (target?.closest(".sbmenu, .more, [data-menu-button]")) return;
		close();
	}
</script>

<svelte:window onpointerdown={outside} onkeydown={(e) => { if (e.key === "Escape" && shown) { e.preventDefault(); e.stopPropagation(); close(); } }} />

{#if shown}
	<!-- The menu container only routes keys to its items (arrows, Esc); the items are the interactive elements. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		use:portal
		bind:this={el}
		class="sbmenu"
		in:surfaceIn={{ y: -4 }}
		out:surfaceOut={{ y: -4 }}
		role="menu"
		tabindex="-1"
		style:top="{shown.top}px"
		style:left="{shown.left}px"
		style:width="{WIDTH}px"
		onpointerenter={(e) => { if (shown && !shown.sticky && e.pointerType === "mouse") clearLeave(); }}
		onpointerleave={leave}
		onkeydown={keys}
	>
		{#each shown.items as it (it.label)}
			<button class="mi wide" role="menuitem" title={it.title || undefined} style:--tilt={it.tilt ? `${it.tilt}deg` : undefined} onclick={() => pick(it.run)}><Icon name={it.icon} /><span>{it.label}</span></button>
		{/each}
	</div>
{/if}

<style>
	.sbmenu {
		position: fixed;
		z-index: var(--z-modal-3);
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg-elev);
		box-shadow: var(--shadow-overlay);
	}
	.mi {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 34px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		text-align: left;
		font-size: var(--fs-sm);
		line-height: 20px; /* whole-pixel label beside the icon (rule 3) */
		color: var(--text);
		white-space: nowrap;
	}
	.mi:focus-visible {
		background: var(--bg-hover);
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.mi > span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	@media (hover: hover) {
		.mi:hover {
			background: var(--bg-hover);
		}
	}
	.mi :global(svg) {
		width: 16px;
		height: 16px;
		flex: none;
		stroke: var(--text-dim);
		stroke-width: 1.9;
		transform: rotate(var(--tilt, 0deg));
	}
</style>
