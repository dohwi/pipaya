<script lang="ts">
	import { tick } from "svelte";
	import { app } from "../../lib/store.svelte";
	import { viewport } from "../../lib/viewport.svelte";
	import ToastStrip from "./ToastStrip.svelte";
	import VersionNotice from "./VersionNotice.svelte";

	/**
	 * Toasts are strips like the "done" notices: full width of the chat area (not of the window,
	 * so the sidebar does not push them off centre), right under the header. They stay above dialogs, so a toast raised
	 * from inside Settings is still seen. With no chat area on screen (no server yet) they span the window.
	 */
	let box = $state<{ left: number; width: number; top: number } | null>(null);
	/** A phone sheet that covers the whole screen (tab overview): a strip under the header would sit on its title and first
	 *  cards, so the strips drop to the bottom edge instead, where the sheet has nothing to cover. */
	let overSheet = $state(false);

	function measure() {
		overSheet = viewport.phone && !!document.querySelector(".modal.sheet.full");
		const stage = document.querySelector<HTMLElement>(".stage");
		if (!stage) return (box = null);
		// the stage's overlay column: the top of the chat area, or under the graph view's header while that is open
		const r = (stage.querySelector<HTMLElement>(".overlay") ?? stage).getBoundingClientRect();
		// the strips at the top of that column (the connection strip under the graph, "done" notices): ours go right below them
		const above = [...stage.querySelectorAll<HTMLElement>(".overlay > .banner, .overlay > .stack")].map((e) => e.getBoundingClientRect().bottom);
		box = { left: r.left, width: r.width, top: Math.max(r.top, ...above) };
	}

	$effect(() => {
		// re-attach when the layout around the stage changes shape
		void [app.servers.length, app.feedback.notices.length, app.globalToasts.length, app.tabOverview, app.sidebar.collapsed, app.sidebar.open, viewport.narrow, app.activeGroup?.id, app.graphOpen, app.net];
		let ro: ResizeObserver | undefined;
		let dead = false;
		tick().then(() => {
			if (dead) return;
			measure();
			ro = new ResizeObserver(measure);
			const stage = document.querySelector(".stage");
			if (stage) ro.observe(stage);
			for (const e of stage?.querySelectorAll(".overlay > .banner, .overlay > .stack") ?? []) ro.observe(e);
		});
		return () => {
			dead = true;
			ro?.disconnect();
		};
	});
</script>

<svelte:window onresize={measure} />

<div
	class="toasts"
	data-part="toasts"
	class:anchored={!!box && !overSheet}
	class:bottom={overSheet}
	style:left={box && !overSheet ? `${box.left}px` : null}
	style:width={box && !overSheet ? `${box.width}px` : null}
	style:top={box && !overSheet ? `${box.top}px` : null}
	aria-live="polite"
>
	<VersionNotice />
	<ToastStrip toasts={app.globalToasts} from={overSheet ? "bottom" : "top"} />
</div>

<style>
	.toasts {
		position: fixed;
		z-index: var(--z-toast); /* above every dialog: a toast raised from inside one (Settings, a graph quick look) is seen */
		left: 0;
		right: 0;
		top: var(--sat);
		display: flex;
		flex-direction: column;
		pointer-events: none;
		box-shadow: var(--shadow-soft);
	}
	.toasts.anchored {
		right: auto;
	}
	.toasts.bottom {
		top: auto;
		bottom: 0;
		padding-bottom: var(--sab);
		flex-direction: column-reverse;
	}
	.toasts.bottom :global(.strip) {
		border-bottom: 0;
		border-top: 1px solid color-mix(in srgb, var(--tone) 25%, var(--border-strong));
	}
</style>
