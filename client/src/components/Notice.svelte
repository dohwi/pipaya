<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";

	/**
	 * The one boxed message: an error, a warning, or a plain note.
	 *
	 *  tone   danger = something failed (announced to screen readers), warn = take care, info = FYI
	 *  icon   leading alert icon (on by default for danger and warn)
	 *  action optional trailing control, e.g. a "retry" button
	 */
	let {
		tone = "info",
		icon,
		children,
		action,
	}: {
		tone?: "danger" | "warn" | "info";
		icon?: boolean;
		children: Snippet;
		action?: Snippet;
	} = $props();

	const showIcon = $derived(icon ?? tone !== "info");
</script>

<div class="notice {tone}" role={tone === "danger" ? "alert" : "note"}>
	{#if showIcon}<Icon name="alert" />{/if}
	<span class="text">{@render children()}</span>
	{#if action}<span class="action">{@render action()}</span>{/if}
</div>

<style>
	.notice {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		padding: 10px 12px;
		border-radius: var(--radius);
		background: var(--bg-elev);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
	.danger {
		background: var(--danger-soft);
		color: var(--danger);
		font-weight: 500;
	}
	.warn {
		background: var(--warn-soft);
		color: var(--warn);
		word-break: keep-all;
	}
	.notice :global(svg) {
		width: 17px;
		height: 17px;
		flex: none;
		margin-top: 1px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.text {
		flex: 1 1 auto;
		min-width: 0;
	}
	.action {
		flex: none;
	}
	.action :global(button) {
		color: inherit;
		text-decoration: underline;
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}
</style>
