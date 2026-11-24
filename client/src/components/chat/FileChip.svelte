<script lang="ts">
	import { t } from "../../lib/i18n";
	import { extOf, sizeLabel } from "../../lib/files";
	import RemoveBadge from "./RemoveBadge.svelte";

	/** A file as a small card: a thumbnail (images) or the extension, the name and the size. A press opens the preview. */
	let { name, size, preview, onopen, onremove }: { name: string; size?: number; preview?: string; onopen?: () => void; onremove?: () => void } = $props();
</script>

<span class="filechip">
	<button type="button" class="open" onclick={() => onopen?.()} disabled={!onopen} aria-label={t("{name} 미리보기", { name })}>
		{#if preview}
			<img src={preview} alt="" />
		{:else}
			<span class="ext mono">{extOf(name)}</span>
		{/if}
		<span class="meta">
			<span class="nm">{name}</span>
			{#if size !== undefined}<span class="sz mono">{sizeLabel(size)}</span>{/if}
		</span>
	</button>
	{#if onremove}
		<RemoveBadge label={t("{name} 제거", { name })} onclick={() => onremove?.()} />
	{/if}
</span>

<style>
	.filechip {
		position: relative;
		display: flex;
		flex: none;
		max-width: min(260px, 100%);
	}
	.open {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		max-width: 100%;
		height: 48px;
		padding: 0 12px 0 4px;
		text-align: left;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		color: var(--text);
		cursor: pointer;
	}
	.open:disabled {
		cursor: default;
	}
	@media (hover: hover) {
		.open:hover:not(:disabled) {
			border-color: var(--border-strong);
		}
	}
	.open img,
	.ext {
		flex: none;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		object-fit: cover;
	}
	.ext {
		display: grid;
		place-items: center;
		font-size: var(--fs-2xs);
		color: var(--text-dim);
		background: var(--bg-hover);
	}
	.meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.nm {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
	}
	.sz {
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
</style>
