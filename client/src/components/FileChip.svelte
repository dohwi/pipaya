<script lang="ts">
	import { t } from "../lib/i18n";
	import { extOf, sizeLabel } from "../lib/files";
	import Icon from "./Icon.svelte";

	/** A file as a small card: a thumbnail (images) or the extension, the name and the size. A press opens the preview. */
	let { name, size, preview, onopen, onremove }: { name: string; size?: number; preview?: string; onopen?: () => void; onremove?: () => void } = $props();
</script>

<span class="chip">
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
		<button type="button" class="rm" onclick={() => onremove?.()} aria-label={t("{name} 제거", { name })}><Icon name="x" /></button>
	{/if}
</span>

<style>
	.chip {
		position: relative;
		display: inline-flex;
		flex: none;
		max-width: 260px;
	}
	.open {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		height: 48px;
		padding: 0 12px 0 6px;
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
	.open:hover:not(:disabled) {
		border-color: var(--border-strong);
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
		font-size: 10px;
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
