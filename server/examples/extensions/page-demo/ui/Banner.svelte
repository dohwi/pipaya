<script>
	import { Notice } from "pipaya";
	// Mounted above the page's sections (`extension.page.top`); `call` reaches this extension's own methods on the server of the page.
	let { call, settings, disabled } = $props();
	let busy = $state(false);
	async function run() { busy = true; try { await call("run", {}); } finally { busy = false; } }
</script>

<Notice tone="info" size="sm" role="status">
	Svelte banner: interval {settings.interval ?? 5} min
	{#snippet action()}<button type="button" disabled={disabled || busy} onclick={run}>Run (call)</button>{/snippet}
</Notice>
