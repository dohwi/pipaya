<script lang="ts" module>
	import type { Component } from "svelte";

	/** One promise per loader, so a dialog that is opened again mounts in the same tick instead of awaiting a fresh import. */
	const loaded = new WeakMap<() => Promise<{ default: Component<any> }>, Promise<{ default: Component<any> }>>();
	export function preload(load: () => Promise<{ default: Component<any> }>) {
		let p = loaded.get(load);
		if (!p) {
			p = load();
			p.catch(() => loaded.delete(load)); // a failed chunk fetch can be retried on the next open
			loaded.set(load, p);
		}
		return p;
	}
</script>

<script lang="ts">
	/**
	 * Mounts a component from its own chunk. Used for dialogs and settings panels that most sessions never open,
	 * so they stay out of the start-up bundle. Every other prop is passed through.
	 */
	let { load, ...rest }: { load: () => Promise<{ default: Component<any> }>; [prop: string]: unknown } = $props();
</script>

{#await preload(load) then mod}
	<mod.default {...rest} />
{/await}
