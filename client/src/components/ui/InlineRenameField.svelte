<script lang="ts">
	import type { ClassValue } from "svelte/elements";

	/**
	 * Shared in-place rename text field: focuses with everything selected on mount, commits on Enter or blur,
	 * and cancels on Escape.
	 *
	 *  variant  inline (sidebar row title, 24px soft border)
	 *         | heading (sidebar folder/project header, 24px semibold)
	 *         | tab (tab bar strip, 22px compact)
	 *         | bar (pane/header/strip title bar, 28px)
	 */
	let {
		value,
		oninput,
		oncommit,
		oncancel,
		maxlength,
		ariaLabel,
		variant = "bar",
		class: cls = "",
		stopClick = false,
		stopPointer = false,
		stopKeys = false,
	}: {
		value: string;
		oninput: (v: string) => void;
		oncommit: () => void;
		oncancel: () => void;
		maxlength?: number;
		ariaLabel?: string;
		variant?: "inline" | "heading" | "tab" | "bar";
		class?: ClassValue;
		stopClick?: boolean;
		stopPointer?: boolean;
		stopKeys?: boolean;
	} = $props();

	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
</script>

<input
	class={["inline-rename", variant, cls]}
	{value}
	{maxlength}
	aria-label={ariaLabel}
	use:focusSelect
	oninput={(e) => oninput(e.currentTarget.value)}
	onblur={oncommit}
	onclick={stopClick ? (e) => e.stopPropagation() : undefined}
	onpointerdown={stopPointer ? (e) => e.stopPropagation() : undefined}
	onkeydown={(e) => {
		if (stopKeys) e.stopPropagation();
		if (e.key === "Enter") oncommit();
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			oncancel();
		}
	}}
/>

<style>
	.inline-rename {
		min-width: 0;
		border: 1px solid var(--accent);
		background: var(--bg);
		color: var(--text);
		outline: 0;
		font-size: var(--fs-sm);
	}
	/* in a sidebar row, in the title's place: a 24px field in the 32px row (4px above and below), so nothing moves */
	.inline-rename.inline {
		flex: 1;
		margin: 0;
		height: 24px;
		padding: 0 4px;
		border-radius: var(--radius-xs); /* 8px on a 24px field reads as a pill; a row's name field is a quiet text box */
		border-color: color-mix(in srgb, var(--accent) 45%, transparent); /* softer than the full accent: it is the only field on screen, focus is obvious */
		line-height: 20px;
	}
	.inline-rename.heading {
		flex: 1;
		height: 24px;
		padding: 0 4px;
		border-radius: var(--radius-sm);
		font-weight: 600;
	}
	.inline-rename.tab {
		flex: 1 1 auto;
		width: 0;
		height: 22px;
		padding: 0 4px;
		border-radius: var(--radius-xs);
	}
	.inline-rename.bar {
		flex: 1;
		height: 28px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
	}
</style>
