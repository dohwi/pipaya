<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * The scrolling body of a dialog: the left/right gutter (`--dlg-px`), top/bottom padding and the line that separates it
	 * from the header. Every list dialog (skills, commands, MCP, context) used to repeat these four rules.
	 *  gap   puts `--dlg-gap` between direct children (a body made of stacked sections or fields)
	 *  rule  draws the line under the header (the context view has its own header rule)
	 */
	let { gap = false, rule = true, busy = false, children }: { gap?: boolean; rule?: boolean; busy?: boolean; children: Snippet } = $props();
</script>

<div class="dbody" class:gap class:rule aria-busy={busy}>{@render children()}</div>

<style>
	.dbody {
		overflow-y: auto;
		padding: var(--dlg-body-t) var(--dlg-px) var(--dlg-body-b);
		min-height: 80px;
	}
	.rule {
		border-top: 1px solid var(--border);
	}
	.gap {
		display: flex;
		flex-direction: column;
		gap: var(--dlg-gap);
	}
</style>
