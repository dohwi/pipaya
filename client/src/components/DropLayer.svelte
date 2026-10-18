<script lang="ts">
	import { msg, t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { drag, dropTarget, type Point } from "../lib/dnd.svelte";
	import { zoneAt, type Zone } from "../lib/layout";

	/** Covers a pane while a session is being dragged: where it is let go decides how the layout changes. */
	let { target }: { target: string } = $props();

	let zone = $state<Zone | null>(null);
	let el: HTMLDivElement | undefined = $state();

	function at(pt: Point): Zone {
		const r = el!.getBoundingClientRect();
		return zoneAt((pt.x - r.left) / r.width, (pt.y - r.top) / r.height);
	}
	const target_ = {
		hover: (pt: Point | null) => (zone = pt ? at(pt) : null),
		drop: (id: string, pt: Point) => {
			const z = at(pt);
			zone = null;
			void app.dropSession(id, target, z);
		},
	};

	const LABEL: Record<Zone, string> = { left: msg("왼쪽에 놓기"), right: msg("오른쪽에 놓기"), top: msg("위에 놓기"), bottom: msg("아래에 놓기") };
</script>

{#if drag.id && drag.id !== target && app.shows(drag.id)}
	<div class="drop" bind:this={el} role="presentation" use:dropTarget={target_}>
		{#if zone}
			<div class="hint {zone}"><span>{t(LABEL[zone])}</span></div>
		{/if}
	</div>
{/if}

<style>
	.drop {
		position: absolute;
		inset: 0;
		z-index: 30;
	}
	.hint {
		position: absolute;
		display: grid;
		place-items: center;
		background: var(--accent-soft);
		border: 2px solid var(--accent);
		border-radius: var(--radius-sm);
		pointer-events: none;
		transition: inset var(--motion-fast) var(--ease-std), opacity var(--motion-fast) var(--ease-std);
	}
	.hint span {
		padding: 3px 10px;
		border-radius: var(--radius-pill);
		background: var(--bg);
		border: 1px solid var(--border-strong);
		font-size: var(--fs-xs);
		font-weight: 600;
	}
	.left {
		inset: 0 50% 0 0;
	}
	.right {
		inset: 0 0 0 50%;
	}
	.top {
		inset: 0 0 50% 0;
	}
	.bottom {
		inset: 50% 0 0 0;
	}
</style>
