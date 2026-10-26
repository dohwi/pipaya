<script lang="ts">
	import { tick } from "svelte";
	import { app } from "../lib/store.svelte";
	import { viewport } from "../lib/viewport.svelte";
	import ToastStrip from "./ToastStrip.svelte";
	import VersionNotice from "./VersionNotice.svelte";

	/**
	 * Toasts are strips like the "done" notices: full width of the chat area (not of the window,
	 * so the sidebar does not push them off centre), right under the header. They stay above dialogs, so a toast raised
	 * from inside Settings is still seen. With no chat area on screen (no server yet) they span the window.
	 */
	let box = $state<{ left: number; width: number; top: number } | null>(null);

	function measure() {
		const stage = document.querySelector<HTMLElement>(".stage");
		if (!stage) return (box = null);
		const r = stage.getBoundingClientRect();
		// "done" strips occupy the top of the stage; ours go right below them
		const done = stage.querySelector<HTMLElement>(".overlay .stack")?.getBoundingClientRect();
		box = { left: r.left, width: r.width, top: done ? done.bottom : r.top };
	}

	$effect(() => {
		// re-attach when the layout around the stage changes shape
		void [app.servers.length, app.feedback.notices.length, app.sidebar.collapsed, app.sidebar.open, viewport.narrow, app.activeGroup?.id];
		let ro: ResizeObserver | undefined;
		let dead = false;
		tick().then(() => {
			if (dead) return;
			measure();
			ro = new ResizeObserver(measure);
			const stage = document.querySelector(".stage");
			if (stage) ro.observe(stage);
			const done = stage?.querySelector(".overlay .stack");
			if (done) ro.observe(done);
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
	class:anchored={!!box}
	style:left={box ? `${box.left}px` : null}
	style:width={box ? `${box.width}px` : null}
	style:top={box ? `${box.top}px` : null}
	aria-live="polite"
>
	<VersionNotice />
	<ToastStrip toasts={app.globalToasts} />
</div>

<style>
	.toasts {
		position: fixed;
		z-index: var(--z-notice);
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
</style>
