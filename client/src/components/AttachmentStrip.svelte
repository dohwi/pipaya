<script lang="ts">
	import { t } from "../lib/i18n";
	import { chipIn, chipOut, reflow, surfaceIn, surfaceOut } from "../lib/motion";
	import { app } from "../lib/store.svelte";
	import type { Attachment } from "../lib/images";
	import Icon from "./Icon.svelte";

	/** Images attached to the message being written: a tap opens them full-size, the x removes one. */
	let { attachments, onremove }: { attachments: Attachment[]; onremove: (id: string) => void } = $props();

	const open = (id: string) =>
		app.openImage(
			attachments.map((m) => ({ src: m.preview, mimeType: m.mimeType })),
			attachments.findIndex((m) => m.id === id),
		);
</script>

<!-- |global: the {#if} that shows this strip is the composer's, not this component's (see tests/motion.test.ts) -->
<div class="thumbs" in:surfaceIn|global={{ y: 8 }} out:surfaceOut|global={{ y: 8 }}>
	{#each attachments as a (a.id)}
		<div class="thumb" animate:reflow in:chipIn out:chipOut>
			<button class="open" onclick={() => open(a.id)} aria-label={t("{name} 크게 보기", { name: a.name })}>
				<img src={a.preview} alt={a.name} />
			</button>
			<button class="rm" onclick={() => onremove(a.id)} aria-label={t("{name} 제거", { name: a.name })}>
				<Icon name="x" />
			</button>
		</div>
	{/each}
</div>

<style>
	.thumbs {
		display: flex;
		gap: 8px;
		padding: 12px 14px 0;
		overflow-x: auto;
	}
	.thumb {
		position: relative;
		flex: none;
	}
	.open {
		display: block;
		padding: 0;
		cursor: zoom-in;
		border-radius: var(--radius);
	}
	.thumb img {
		display: block;
		height: 64px;
		width: 64px;
		object-fit: cover;
		border-radius: var(--radius);
		border: 1px solid var(--border);
	}
	.rm {
		position: absolute;
		top: -6px;
		right: -6px;
		width: 22px;
		height: 22px;
		border-radius: var(--radius);
		display: grid;
		place-items: center;
		background: var(--text);
		color: var(--bg);
	}
	.rm :global(svg) {
		width: 12px;
		height: 12px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2.6;
		stroke-linecap: round;
	}
</style>
