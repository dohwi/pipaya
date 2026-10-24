<script lang="ts">
	import { t } from "../../lib/i18n";
	import type { Hit } from "../../lib/settings-search";

	/** What a search of settings and shortcuts found: one line per hit (where it lives, and its key if it is a shortcut). */
	let { hits, onpick }: { hits: Hit[]; onpick: (h: Hit) => void } = $props();
</script>

{#if !hits.length}<span class="hint">{t("검색 결과가 없습니다")}</span>{/if}
<ul class="hits">
	{#each hits as h (h.key)}
		<li><button onclick={() => onpick(h)}>
			<span class="ht">{h.title}</span>
			<span class="hw">{h.where}</span>
			{#if h.combo}<span class="hc">{h.combo}</span>{/if}
		</button></li>
	{/each}
</ul>

<style>
	.hits {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.hits button {
		width: 100%;
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 10px 8px;
		border-top: 1px solid var(--border);
		text-align: left;
		border-radius: 0;
	}
	.hits li:first-child button {
		border-top: 0;
	}
	.hits button:hover {
		background: var(--bg-hover);
	}
	.ht {
		font-size: var(--fs-md);
	}
	.hw {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hc {
		flex: none;
		font-family: var(--mono);
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
</style>
