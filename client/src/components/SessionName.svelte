<script lang="ts">
	import Badge from "./Badge.svelte";

	/** A session's name (`@서우`) as a small grey badge, the same in every state and on every row background. */
	let { name, title, inline = false }: { name: string; title?: string; inline?: boolean } = $props();
</script>

<span class="sn" class:inline {title}><Badge size="sm" mono>@{name}</Badge></span>

<style>
	.sn {
		flex: none;
		display: inline-flex;
		vertical-align: middle;
		/* tabs and sidebar rows already have a 6px flex gap: pull the title closer */
		margin-right: -2px;
	}
	/* inside running title text (not a flex row with its own gap) */
	.inline {
		margin-right: 3px;
	}
	/* a translucent grey reads on the plain, hovered and selected row alike */
	.sn :global(.badge) {
		--badge-bg: color-mix(in srgb, var(--text) 9%, transparent);
		--badge-fg: var(--text-dim);
		height: 17px;
		padding: 0 5px;
		font-weight: 500;
		line-height: 1;
		align-items: center;
		justify-content: center;
		text-align: center;
	}
</style>
