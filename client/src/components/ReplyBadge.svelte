<script lang="ts">
	import { t } from "../lib/i18n";
	import { surfaceIn, surfaceOut } from "../lib/motion";
	import Icon from "./Icon.svelte";

	/** The message being answered, shown above the input; the x drops the reply. */
	let { who, text, oncancel }: { who?: string; text: string; oncancel: () => void } = $props();
</script>

<!-- |global: the {#if} that shows this badge is the composer's, not this component's (see tests/motion.test.ts) -->
<div class="reply-badge" in:surfaceIn|global={{ y: 8 }} out:surfaceOut|global={{ y: 8 }}>
	<Icon name="reply" />
	<span class="rwho">{who ?? t("답장")}</span>
	<span class="rtext">{text}</span>
	<button class="rx" onclick={oncancel} aria-label={t("답장 취소")} title={t("답장 취소")}>×</button>
</div>

<style>
	.reply-badge {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 10px 14px 0;
		padding: 5px 6px 5px 10px;
		max-width: max-content;
		min-width: 0;
		border-radius: var(--radius-pill);
		background: var(--accent-soft);
		border-left: 3px solid var(--border-strong);
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.reply-badge :global(svg) { width: 13px; height: 13px; flex: none; stroke-width: 1.8; }
	.rwho { font-weight: 600; color: var(--text); flex: none; }
	.rtext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rx { flex: none; width: 18px; height: 18px; line-height: 16px; border-radius: 50%; padding: 0; color: inherit; }
	.rx:hover { background: var(--accent-soft); color: var(--text); }
</style>
