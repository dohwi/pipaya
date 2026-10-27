<script lang="ts">
	import type { Snippet } from "svelte";
	import Modal from "./Modal.svelte";

	/**
	 * The small centred card for something that goes through states (checking → working → done/failed): a boxed mark, a title,
	 * and whatever the state needs below. The update card and the server-link card are both this, so they open, look and
	 * dismiss alike. For a plain question with answers use ConfirmDialog.
	 *
	 *  tone         colour of the mark's box: neutral (default), ok (green) or bad (red)
	 *  dismissible  false while something is running, so a stray click or Esc cannot hide it
	 */
	let {
		onclose,
		label,
		tone = "neutral",
		title,
		dismissible = true,
		mark,
		children,
	}: {
		onclose: () => void;
		label: string;
		tone?: "neutral" | "ok" | "bad";
		title: string;
		dismissible?: boolean;
		mark: Snippet;
		children?: Snippet;
	} = $props();
</script>

<Modal {onclose} {dismissible} {label} live="polite" width="360px" gutter="32px" layer={4} sheet={false}>
	<div class="card">
		<div class="mark {tone}">{@render mark()}</div>
		<h2>{title}</h2>
		{@render children?.()}
	</div>
</Modal>

<style>
	.card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 30px 24px 24px; text-align: center; }
	.mark { width: 64px; height: 64px; display: grid; place-items: center; border-radius: var(--radius); border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); }
	.mark.ok { color: var(--ok); border-color: var(--ok); }
	.mark.bad { color: var(--danger); border-color: var(--danger); }
	.mark :global(svg:not(.logo)) { width: 28px; height: 28px; stroke-width: 2; }
	h2 { margin: 4px 0 0; font-size: var(--fs-xl); }
	.card :global(.note) { margin: 2px 0 6px; font-size: var(--fs-sm); line-height: 1.55; color: var(--text-faint); word-break: keep-all; }
	.card :global(.actions) { display: flex; gap: 8px; justify-content: center; }
</style>
