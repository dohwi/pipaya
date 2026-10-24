<script lang="ts">
	import type { Snippet } from "svelte";
	import { collapseIn, collapseOut } from "../../lib/motion";

	/**
	 * The question under a card's "delete" button. It takes focus on its safe choice (the element marked `data-cancel`)
	 * the moment it opens, and Esc dismisses it without closing the window around it. `labelledby` is the id of the
	 * question text inside `children`.
	 */
	let { labelledby, oncancel, children }: { labelledby: string; oncancel: () => void; children: Snippet } = $props();

	function focusConfirm(node: HTMLElement) {
		node.querySelector<HTMLElement>("[data-cancel]")?.focus();
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			oncancel();
		};
		node.addEventListener("keydown", key);
		return { destroy: () => node.removeEventListener("keydown", key) };
	}
</script>

<div class="confirm" in:collapseIn out:collapseOut role="group" aria-labelledby={labelledby} tabindex="-1" use:focusConfirm>
	{@render children()}
</div>

<style>
	.confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--danger-soft); font-size: var(--fs-sm); }
	.confirm :global(p) { margin: 0; }
	.confirm :global(.row) { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
</style>
