<script lang="ts" module>
	import type { IconName } from "./Icon.svelte";
	export interface RowMenuItem {
		icon: IconName;
		label: string;
		/** Tooltip; "" for none */
		title: string;
		run: () => void;
	}
</script>

<script lang="ts">
	import Icon from "./Icon.svelte";
	import { portal } from "../lib/dialog";
	import { surfaceIn, surfaceOut } from "../lib/motion";

	/**
	 * The small "more" menu next to a sidebar row. Hover opens it with a mouse (and a short grace period lets the pointer
	 * travel into it); touch and keyboard open it with a click. `openAt` opens it as a context menu (right click / long
	 * press) where the pointer is. Lives on <body> because the list scrolls and clips.
	 * `open`: the id the menu is open for, so the row can highlight its button.
	 */
	let { open = $bindable(null) }: { open?: string | null } = $props();

	/** `sticky`: opened as a context menu, so the pointer leaving it does not close it (a click elsewhere or Esc does). */
	let shown = $state<{ id: string; items: RowMenuItem[]; top: number; left: number; sticky: boolean } | null>(null);
	let el = $state<HTMLElement | null>(null);
	let leaveTimer: ReturnType<typeof setTimeout> | undefined;

	const WIDTH = 196;
	const GAP = 6;
	const ROW = 36;

	/** Beside the rectangle `r` (a button, or the point a right click / long press landed on). */
	function place(r: { left: number; right: number; top: number }, id: string, items: RowMenuItem[], sticky = false) {
		clearTimeout(leaveTimer);
		const h = items.length * ROW + 10;
		// to the right; flips to the left when the screen edge is too close
		const left = r.right + GAP + WIDTH <= window.innerWidth - 8 ? r.right + GAP : Math.max(8, r.left - GAP - WIDTH);
		const top = Math.max(8, Math.min(r.top - 4, window.innerHeight - h - 8));
		shown = { id, items, top, left, sticky };
		open = id;
	}
	const show = (btn: HTMLElement, id: string, items: RowMenuItem[]) => place(btn.getBoundingClientRect(), id, items);
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
		clearTimeout(leaveTimer);
		shown = null;
		open = null;
	}
	/** Mouse: hovering the button is enough. Touch has no hover, so it falls through to the click. */
	export function hover(e: PointerEvent, id: string, items: RowMenuItem[]) {
		if (e.pointerType === "mouse" && !(shown?.sticky && shown.id === id)) show(e.currentTarget as HTMLElement, id, items);
	}
	export function leave(e: PointerEvent) {
		if (e.pointerType !== "mouse" || shown?.sticky) return;
		clearTimeout(leaveTimer);
		leaveTimer = setTimeout(close, 160);
	}
	export function click(e: MouseEvent, id: string, items: RowMenuItem[]) {
		if (shown?.id === id) {
			// a mouse click lands on a menu that hover already opened: keep it; touch / keyboard toggles
			if ((e as PointerEvent).pointerType === "mouse") return;
			return close();
		}
		show(e.currentTarget as HTMLElement, id, items);
		// keyboard (Enter/Space has no pointer): move into the menu
		if (e.detail === 0) queueMicrotask(() => el?.querySelector<HTMLElement>("button")?.focus());
	}

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

<svelte:window onpointerdown={outside} onkeydown={(e) => e.key === "Escape" && shown && close()} />

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
		onpointerenter={() => clearTimeout(leaveTimer)}
		onpointerleave={leave}
		onkeydown={keys}
	>
		{#each shown.items as it (it.label)}
			<button class="mi wide" role="menuitem" title={it.title || undefined} onclick={() => pick(it.run)}><Icon name={it.icon} /><span>{it.label}</span></button>
		{/each}
	</div>
{/if}

<style>
	.sbmenu {
		position: fixed;
		z-index: var(--z-modal-3);
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 5px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg-elev);
		box-shadow: var(--shadow);
	}
	.mi {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 34px;
		padding: 0 10px;
		border-radius: var(--radius-sm);
		text-align: left;
		font-size: var(--fs-sm);
		color: var(--text);
		white-space: nowrap;
	}
	.mi:hover,
	.mi:focus-visible {
		background: var(--bg-hover);
	}
	.mi :global(svg) {
		width: 16px;
		height: 16px;
		flex: none;
		stroke: var(--text-dim);
		stroke-width: 1.9;
	}
</style>
