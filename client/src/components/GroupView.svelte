<script lang="ts">
	import { t } from "../lib/i18n";
	import Pane from "./Pane.svelte";
	import { app } from "../lib/store.svelte";
	import { detach, linkedDividers, measure, moveDividers, positionOf, snapPosition, type Divider, type Layout, type Path } from "../lib/layout";
	import type { Group } from "../lib/types";

	let { group }: { group: Group } = $props();

	const GAP = 3; // px kept between panes
	const geo = $derived(measure(group.layout));

	let box: HTMLDivElement | undefined = $state();
	let active = $state<string | null>(null);
	let live: Layout | null = null;
	let dragPath: Path = [];
	let moved = false;

	const key = (d: Divider) => d.path.join("") || "root";
	const find = (l: Layout, path: Path) => measure(l).dividers.find((x) => x.path.join("") === path.join(""));

	/** Where the pointer is along the divider's axis, as a 0..1 fraction of the whole group. */
	function posAt(e: PointerEvent, d: Divider): number {
		const r = box!.getBoundingClientRect();
		return d.dir === "row" ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
	}
	/** Shift moves every divider that continues the same line. */
	const linkedKey = (e: { shiftKey: boolean }) => e.shiftKey;
	/** Linked dividers being dragged together (just the grabbed one when empty). */
	let linked = $state<Path[]>([]);
	/** Shift held and the divider under the pointer: its whole continuing line lights up as one long line. */
	let linkKeyDown = $state(false);
	let hover = $state<Path | null>(null);
	const lit = $derived.by(() => {
		if (active) return new Set(linked.map((p) => p.join("") || "root"));
		if (!linkKeyDown || !hover) return new Set<string>();
		return new Set(linkedDividers(group.layout, hover).map((p) => p.join("") || "root"));
	});
	function modKeys(e: KeyboardEvent) {
		linkKeyDown = e.shiftKey;
	}
	/**
	 * In a 2x2 grid one line is a single node of the tree, so its two halves would move together. Grabbing one half
	 * turns the tree so that half stands alone (the other pair of lines then moves together).
	 * Shift instead drags every aligned segment of the line together; Ctrl (Cmd) snaps to guides
	 * (centre, thirds, quarters, other dividers).
	 */
	let grab: { path: Path; side: 0 | 1 | null } | null = null;
	function down(e: PointerEvent, d: Divider) {
		let side: 0 | 1 | null = null;
		const together = linkedKey(e);
		if (!together && box) {
			const r = box.getBoundingClientRect();
			const along = d.dir === "row" ? ((e.clientY - r.top) / r.height - d.area.y) / d.area.h : ((e.clientX - r.left) / r.width - d.area.x) / d.area.w;
			side = along < 0.5 ? 0 : 1;
		}
		grab = { path: d.path, side };
		linked = together ? linkedDividers(group.layout, d.path) : [];
		live = group.layout;
		dragPath = d.path;
		active = key(d);
		document.body.style.userSelect = "none";
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	}
	function move(e: PointerEvent) {
		if (!active || !live) return;
		// The tree is only turned once the pointer really drags, so a click or double click changes nothing.
		if (grab) {
			const split = grab.side === null ? null : detach(live, grab.path, grab.side);
			if (split) {
				live = split.layout;
				dragPath = split.path;
				active = split.path.join("") || "root";
			}
			grab = null;
			moved = true;
		}
		const d = find(live, dragPath);
		if (!d) return;
		const paths = linked.length ? linked : [dragPath];
		let pos = posAt(e, d);
		if (e.ctrlKey || e.metaKey) pos = snapPosition(live, paths, pos);
		live = moveDividers(live, paths, pos);
		void app.saveLayout(group.id, live, false);
	}
	/** The divider under the pointer, if any (enter/leave can't be trusted while a drag moves the divider). */
	function dividerAt(e: PointerEvent): Path | null {
		const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-divider]");
		const k = el?.dataset.divider;
		return k ? (geo.dividers.find((d) => key(d) === k)?.path ?? null) : null;
	}
	function up(e: PointerEvent) {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		window.removeEventListener("pointercancel", up);
		if (!active) return;
		active = null;
		grab = null;
		document.body.style.userSelect = "";
		if (live && moved) void app.saveLayout(group.id, live);
		moved = false;
		live = null;
		linked = [];
		// The pointer may have left the divider mid-drag, and no pointerenter follows the drop.
		hover = dividerAt(e);
		if (e.shiftKey) linkKeyDown = true;
	}
	// A drag in progress when the group goes away must not leave listeners on the window.
	$effect(() => () => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		window.removeEventListener("pointercancel", up);
		document.body.style.userSelect = "";
	});
	function nudge(e: KeyboardEvent, d: Divider) {
		const back = d.dir === "row" ? "ArrowLeft" : "ArrowUp";
		const fwd = d.dir === "row" ? "ArrowRight" : "ArrowDown";
		if (e.key !== back && e.key !== fwd) return;
		e.preventDefault();
		const step = 0.03 * (e.key === fwd ? 1 : -1);
		const paths = e.shiftKey ? linkedDividers(group.layout, d.path) : [d.path];
		void app.saveLayout(group.id, moveDividers(group.layout, paths, positionOf(d) + step * d.area[d.dir === "row" ? "w" : "h"]));
	}
	/** Double click: back to the middle of the divided area. Shift does it for the whole line. */
	function centre(e: MouseEvent, d: Divider) {
		const paths = linkedKey(e) ? linkedDividers(group.layout, d.path) : [d.path];
		const mid = d.dir === "row" ? d.area.x + d.area.w / 2 : d.area.y + d.area.h / 2;
		void app.saveLayout(group.id, moveDividers(group.layout, paths, mid));
	}

	const pct = (n: number) => `${(n * 100).toFixed(4)}%`;

	// Zoom: the chosen cell grows from where it is to fill the group; Esc (handled in lib/actions) shrinks it back.
	const zoomId = $derived(app.zoomId && geo.panes.some((p) => p.id === app.zoomId) ? app.zoomId : null);
	// Transitions only run around a zoom change, so dragging a divider stays instant.
	let animating = $state(false);
	let animTimer: ReturnType<typeof setTimeout> | undefined;
	let prevZoom: string | null = null;
	$effect.pre(() => {
		const z = zoomId;
		if (z === prevZoom) return;
		prevZoom = z;
		animating = true;
		clearTimeout(animTimer);
		animTimer = setTimeout(() => (animating = false), 500);
	});
	// A zoom never outlives its group or session.
	$effect(() => {
		if (app.zoomId && !zoomId) app.zoomId = null;
	});
	$effect(() => () => {
		clearTimeout(animTimer);
		app.zoomId = null;
	});
</script>

<svelte:window onkeydown={modKeys} onkeyup={modKeys} onblur={() => (linkKeyDown = false)} />

<div class="group" bind:this={box} aria-label={t("{name} 그룹", { name: group.name })}>
	{#each geo.panes as p (p.id)}
		{@const z = zoomId === p.id}
		<div
			class="cell"
			class:animating
			class:zoomed={z}
			class:behind={!!zoomId && !z}
			inert={!!zoomId && !z}
			style:left={z ? "0%" : pct(p.x)}
			style:top={z ? "0%" : pct(p.y)}
			style:width={z ? "100%" : pct(p.w)}
			style:height={z ? "100%" : pct(p.h)}
			style:--gap="{z ? 0 : GAP}px"
		>
			<Pane id={p.id} grouped />
		</div>
	{/each}

	{#each geo.dividers as d (key(d))}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="div {d.dir}"
			class:on={active === key(d) || lit.has(key(d))}
			data-divider={key(d)}
			onpointerenter={(e) => {
				hover = d.path;
				// Only ever turn Shift on here: the enter the browser fires after a layout change carries no modifiers.
				if (e.shiftKey) linkKeyDown = true;
			}}
			onpointermove={(e) => {
				if (active) return;
				hover = d.path;
				if (e.shiftKey) linkKeyDown = true;
			}}
			onpointerleave={() => {
				if (!active) hover = null;
			}}
			role="separator"
			aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
			aria-valuenow={Math.round(d.ratio * 100)}
			aria-valuemin="10"
			aria-valuemax="90"
			tabindex="0"
			title={t("끌어서 크기 조절 · Shift: 이어진 선 함께 · Ctrl: 가이드에 맞춤 · 더블 클릭으로 반반")}
			style:left={d.dir === "row" ? pct(d.area.x + d.area.w * d.ratio) : pct(d.area.x)}
			style:top={d.dir === "row" ? pct(d.area.y) : pct(d.area.y + d.area.h * d.ratio)}
			style:width={d.dir === "row" ? undefined : pct(d.area.w)}
			style:height={d.dir === "row" ? pct(d.area.h) : undefined}
			onpointerdown={(e) => down(e, d)}
			ondblclick={(e) => centre(e, d)}
			onkeydown={(e) => nudge(e, d)}
		></div>
	{/each}
</div>

<style>
	.group {
		flex: 1;
		min-height: 0;
		position: relative;
		background: var(--bg-side);
	}
	.cell {
		position: absolute;
		display: flex;
		padding: var(--gap);
		box-sizing: border-box;
		min-width: 0;
		min-height: 0;
	}
	.cell.animating {
		transition:
			left var(--motion-normal) var(--ease-std),
			top var(--motion-normal) var(--ease-std),
			width var(--motion-normal) var(--ease-std),
			height var(--motion-normal) var(--ease-std),
			padding var(--motion-normal) var(--ease-std);
	}
	.cell.zoomed {
		z-index: 10;
	}
	.cell.behind {
		z-index: 0;
	}
	@media (prefers-reduced-motion: reduce) {
		.cell.animating {
			transition: none;
		}
	}
	.div {
		position: absolute;
		z-index: 20;
		touch-action: none;
	}
	.div.row {
		width: 9px;
		margin-left: -4.5px;
		cursor: col-resize;
	}
	.div.col {
		height: 9px;
		margin-top: -4.5px;
		cursor: row-resize;
	}
	.div::after {
		content: "";
		position: absolute;
		background: var(--accent);
		opacity: 0;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.div.row::after {
		top: 0;
		bottom: 0;
		left: 3.5px;
		width: 2px;
	}
	.div.col::after {
		left: 0;
		right: 0;
		top: 3.5px;
		height: 2px;
	}
	.div:hover::after,
	.div:focus-visible::after,
	.div.on::after {
		opacity: 0.55;
	}
	.div:focus-visible {
		outline: none;
	}
</style>
