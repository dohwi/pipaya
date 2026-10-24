<script lang="ts">
	import type { Snippet } from "svelte";

	/** Small pill with a leading dot: `ok` (green) for "up to date", `warn` (amber) for "something to do / wait for". */
	let { tone, children }: { tone: "ok" | "warn"; children: Snippet } = $props();
</script>

<span class="chip {tone}"><i></i>{@render children()}</span>

<style>
	.chip { flex: 0 1 auto; font-weight: 600; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: var(--radius-pill); font-size: var(--fs-xs); line-height: 1.5; text-align: right; }
	i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
	.ok { background: var(--ok-soft); color: var(--ok); }
	.warn { background: var(--warn-soft); color: var(--warn); }
</style>
