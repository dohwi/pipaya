<script lang="ts">
	import { tick } from "svelte";
	import { modalCount, onModalStackChange } from "../../lib/dialog";
	import { app } from "../../lib/store.svelte";
	import { stageToastBox } from "../../lib/toast-stack";
	import { viewport } from "../../lib/viewport.svelte";
	import ToastStrip from "./ToastStrip.svelte";

	/**
	 * Floating global toast tray. Over the normal workspace it aligns to the chat stage (right of the sidebar, below the
	 * header and any pinned stage banners). Whenever a modal is open, it detaches from the stage and moves to the bottom
	 * centre of the viewport so it never covers modal headers, close buttons, or hangs off-centre past narrow dialogs.
	 */
	const STAGE_STRIPS = ".overlay > .banner, .overlay > .stack, .overlay > .strip";
	let box = $state<{ left: number; width: number; top: number } | null>(null);
	let overModal = $state(modalCount() > 0);

	$effect(() => {
		overModal = modalCount() > 0;
		return onModalStackChange((count) => {
			overModal = count > 0;
		});
	});

	function measure() {
		const stage = document.querySelector<HTMLElement>(".stage");
		if (!stage) return (box = null);
		const zoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-zoom")) || 1;
		// the stage's overlay column: the top of the chat area, or under the graph view's header while that is open
		const r = (stage.querySelector<HTMLElement>(".overlay") ?? stage).getBoundingClientRect();
		// the strips at the top of that column (connection / version / "done" banners): toasts float right below them
		const above = [...stage.querySelectorAll<HTMLElement>(STAGE_STRIPS)].map((e) => e.getBoundingClientRect().bottom);
		box = stageToastBox(r, above, zoom);
	}

	$effect(() => {
		// re-attach when the layout around the stage or zoom scale changes shape
		void [app.servers.length, app.feedback.notices.length, app.globalToasts.length, app.compat, app.prefs.uiScale, overModal, app.sidebar.collapsed, app.sidebar.open, viewport.narrow, app.activeGroup?.id, app.graphOpen, app.net];
		if (overModal) return;
		let ro: ResizeObserver | undefined;
		let dead = false;
		tick().then(() => {
			if (dead) return;
			measure();
			ro = new ResizeObserver(measure);
			const stage = document.querySelector(".stage");
			const overlay = stage?.querySelector(".overlay");
			if (stage) ro.observe(stage);
			if (overlay) ro.observe(overlay);
			for (const e of stage?.querySelectorAll(STAGE_STRIPS) ?? []) ro.observe(e);
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
	class:anchored={!!box && !overModal}
	class:bottom={overModal}
	style:left={box && !overModal ? `${box.left}px` : null}
	style:width={box && !overModal ? `${box.width}px` : null}
	style:top={box && !overModal ? `${box.top}px` : null}
	aria-live="polite"
>
	<div class="tray" class:bottom={overModal}>
		<ToastStrip toasts={app.globalToasts} fit={overModal} from={overModal ? "bottom" : "top"} />
	</div>
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
	.tray {
		padding: 12px 16px 0;
		pointer-events: none;
	}
	.tray.bottom {
		padding: 0 16px 12px;
	}
</style>
