<script lang="ts">
	import { flip } from "svelte/animate";
	import { surfaceIn, surfaceOut, ms } from "../lib/motion";
	import { app } from "../lib/store.svelte";
	import CountdownClose from "./CountdownClose.svelte";

	/**
	 * Messages about one session (a failed send, a queue that cannot be cancelled, ...) shown at the top of that
	 * session's own pane, so in a group it is clear which conversation they belong to. Toasts about nothing in
	 * particular, or about a session that is not on screen, stay in the global strip (Toasts.svelte).
	 */
	let { id }: { id: string } = $props();
	const list = $derived(app.toastsOf(id));
</script>

<div class="stack" aria-live="polite">
	{#each list as t (t.id)}
		<div class="strip {t.tone}" role={t.tone === "error" ? "alert" : "status"} in:surfaceIn={{ y: -10 }} out:surfaceOut={{ y: -10 }} animate:flip={{ duration: ms("fast") }}>
			<span class="msg">{t.text}</span>
			<CountdownClose ms={t.ms} onclick={() => app.feedback.dismissToast(t.id)} />
		</div>
	{/each}
</div>

<style>
	.stack {
		position: absolute;
		z-index: var(--z-notice);
		top: 0;
		left: 0;
		right: 0;
		display: flex;
		flex-direction: column;
		pointer-events: none;
		box-shadow: var(--shadow-soft);
	}
	.strip {
		--tone: var(--text-faint);
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 2px 8px 2px 14px;
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
