<script lang="ts">
	import type { Snippet } from "svelte";

	/** Small pill with a leading dot: `ok` (green) for "new, available to take", `warn` (amber) for "in progress / take care", `neutral` (grey) for "nothing to do". */
	let { tone, children }: { tone: "ok" | "warn" | "neutral"; children: Snippet } = $props();
</script>

<span class="chip {tone}"><i></i>{@render children()}</span>

<style>
	/* same box as the global .chip / Badge md (22px); a status reads as a short sentence, so one size up */
	.chip { flex: 0 1 auto; height: 24px; font-weight: 600; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border-radius: var(--radius-pill); font-size: var(--fs-xs); }
	i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
	.ok { background: var(--ok-soft); color: var(--ok); }
	.warn { background: var(--warn-soft); color: var(--warn); }
	.neutral { background: var(--bg-active); color: var(--text-dim); }
</style>
