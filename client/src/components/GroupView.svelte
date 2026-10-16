<script lang="ts">
	import { t } from "../lib/i18n";
	import Pane from "./Pane.svelte";
	import { app } from "../lib/store.svelte";
	import { alignPosition, isolate, linkedDividers, measure, moveDividers, positionOf, snapPosition, type Divider, type Layout, type Path } from "../lib/layout";
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
	/** Where the pointer is along the hovered divider's line (fraction of the group): picks the piece a plain drag grabs. */
	let hoverAt = $state(0);
	/** Where a point is along the divider's own line, as a fraction of the whole group. */
	function alongOf(e: { clientX: number; clientY: number }, d: Divider): number {
		if (!box) return 0;
		const r = box.getBoundingClientRect();
		return d.dir === "row" ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
	}
	/**
	 * A line crossed by other lines (grids of any size) moves only the piece under the pointer when dragged plainly;
	 * preview just that piece, as insets from the divider's ends.
	 */
	const pieceOf = (d: Divider): { from: string; to: string } | null => {
		if (active || linkKeyDown || !hover || key(d) !== (hover.join("") || "root")) return null;
		const r = isolate(group.layout, d.path, hoverAt);
		if (!r) return null;
		const [s, n] = d.dir === "row" ? [d.area.y, d.area.h] : [d.area.x, d.area.w];
		return { from: pct((r.span[0] - s) / n), to: pct((s + n - r.span[1]) / n) };
	};
	const lit = $derived.by(() => {
		if (active) return new Set(linked.map((p) => p.join("") || "root"));
		if (!linkKeyDown || !hover) return new Set<string>();
		return new Set(linkedDividers(group.layout, hover).map((p) => p.join("") || "root"));
	});
	function modKeys(e: KeyboardEvent) {
		linkKeyDown = e.shiftKey;
	}
	/**
	 * One node of the tree can draw a line that other lines cross (2x2, 3x2, ...), so all its pieces would move
	 * together. Grabbing one piece turns the tree so that piece stands alone; panes and other lines stay put.
	 * Shift instead drags every aligned segment of the line together; Ctrl (Cmd) snaps to guides
	 * (centre, thirds, quarters, other dividers).
	 */
	let grab: { path: Path; at: number | null } | null = null;
	function down(e: PointerEvent, d: Divider) {
		const together = linkedKey(e);
		grab = { path: d.path, at: together ? null : alongOf(e, d) };
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
			const split = grab.at === null ? null : isolate(live, grab.path, grab.at);
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
		if (live && moved) {
			// Line it up with a divider it nearly meets, so the pieces of that line stay separate.
			const paths = linked.length ? linked : [dragPath];
			const d = find(live, dragPath);
			if (d) live = moveDividers(live, paths, alignPosition(live, paths, positionOf(d)));
			void app.saveLayout(group.id, live);
		}
		moved = false;
		live = null;
		linked = [];
		// The pointer may have left the divider mid-drag, and no pointerenter follows the drop.
		hover = dividerAt(e);
		linkKeyDown = e.shiftKey;
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

	<!-- While a pane is zoomed it covers the group, so the dividers (z-index above it) must not be grabbable. -->
	{#each zoomId ? [] : geo.dividers as d (key(d))}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="div {d.dir}"
			class:on={active === key(d) || lit.has(key(d))}
			class:hot={hover !== null && !active && key(d) === (hover.join("") || "root")}
			style:--from={pieceOf(d)?.from ?? "0%"}
			style:--to={pieceOf(d)?.to ?? "0%"}
			data-divider={key(d)}
			onpointerenter={(e) => {
				hover = d.path;
				hoverAt = alongOf(e, d);
				// Only ever turn Shift on here: the enter the browser fires after a layout change carries no modifiers.
				if (e.shiftKey) linkKeyDown = true;
			}}
			onpointermove={(e) => {
				if (active) return;
				hover = d.path;
				hoverAt = alongOf(e, d);
				// A real pointer move carries the real modifiers, so a missed Shift release can't leave the long line lit.
				linkKeyDown = e.shiftKey;
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
		top: var(--from, 0%);
		bottom: var(--to, 0%);
		left: 3.5px;
		width: 2px;
	}
	.div.col::after {
		left: var(--from, 0%);
		right: var(--to, 0%);
		top: 3.5px;
		height: 2px;
	}
	.div.hot::after,
	.div:focus-visible::after,
	.div.on::after {
		opacity: 0.55;
	}
	.div:focus-visible {
		outline: none;
	}
</style>
