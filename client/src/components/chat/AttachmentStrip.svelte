<script lang="ts">
	import { t } from "../../lib/i18n";
	import { chipIn, chipOut, reflow } from "../../lib/motion";
	import { app } from "../../lib/store.svelte";
	import type { Attachment } from "../../lib/images";
	import ComposerStrip from "./ComposerStrip.svelte";
	import RemoveBadge from "./RemoveBadge.svelte";

	/** Images attached to the message being written: a tap opens them full-size, the x removes one. */
	let { attachments, onremove }: { attachments: Attachment[]; onremove: (id: string) => void } = $props();

	const open = (id: string) =>
		app.openImage(
			attachments.map((m) => ({ src: m.preview, mimeType: m.mimeType })),
			attachments.findIndex((m) => m.id === id),
		);
</script>

<ComposerStrip>
	{#each attachments as a (a.id)}
		<div class="thumb" animate:reflow in:chipIn out:chipOut>
			<button class="open" onclick={() => open(a.id)} aria-label={t("{name} 크게 보기", { name: a.name })}>
				<img src={a.preview} alt={a.name} />
			</button>
			<RemoveBadge label={t("{name} 제거", { name: a.name })} onclick={() => onremove(a.id)} />
		</div>
	{/each}
</ComposerStrip>

<style>
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
	/* Keeps the image's own shape (within limits), so a wide screenshot is not cut down to its middle square */
	.thumb img {
		display: block;
		height: 64px;
		width: auto;
		min-width: 48px;
		max-width: 128px;
		object-fit: cover;
		border-radius: var(--radius);
		border: 1px solid var(--border);
	}
</style>
