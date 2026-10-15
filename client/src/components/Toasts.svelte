<script lang="ts">
	import { tick } from "svelte";
	import { surfaceIn, surfaceOut, ms } from "../lib/motion";
	import { flip } from "svelte/animate";
	import { app } from "../lib/store.svelte";
	import { viewport } from "../lib/viewport.svelte";
	import CountdownClose from "./CountdownClose.svelte";

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
	class:anchored={!!box}
	style:left={box ? `${box.left}px` : null}
	style:width={box ? `${box.width}px` : null}
	style:top={box ? `${box.top}px` : null}
	aria-live="polite"
>
	{#each app.globalToasts as t (t.id)}
		<div class="strip {t.tone}" role={t.tone === "error" ? "alert" : "status"} in:surfaceIn={{ y: -10 }} out:surfaceOut={{ y: -10 }} animate:flip={{ duration: ms("fast") }}>
			<span class="msg">{t.text}</span>
			<CountdownClose ms={t.ms} onclick={() => app.feedback.dismissToast(t.id)} />
		</div>
	{/each}
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
	.strip {
		--tone: var(--text-faint);
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 4px 8px 4px 16px;
		/* tinted with the tone, like the "done" strips (neutral toasts get only a faint tint) */
		background: color-mix(in srgb, var(--tone) 16%, var(--bg-elev));
		border-bottom: 1px solid color-mix(in srgb, var(--tone) 25%, var(--border-strong));
		color: var(--text);
		font-size: var(--fs-sm);
		line-height: 1.4;
	}
	.strip.ok {
		--tone: var(--ok);
	}
	.strip.error {
		--tone: var(--danger);
	}
	.msg {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
</style>
