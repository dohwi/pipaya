<script lang="ts">
	import { app } from "../lib/store.svelte";
	import ToastStrip from "./ToastStrip.svelte";

	/**
	 * Messages about one session (a failed send, a queue that cannot be cancelled, ...) shown at the top of that
	 * session's own pane, so in a group it is clear which conversation they belong to. Toasts about nothing in
	 * particular, or about a session that is not on screen, stay in the global strip (Toasts.svelte).
	 */
	let { id }: { id: string } = $props();
	const list = $derived(app.toastsOf(id));
</script>

<div class="stack" aria-live="polite">
	<ToastStrip toasts={list} compact />
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
</style>
