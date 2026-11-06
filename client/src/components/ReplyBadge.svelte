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
	<button class="rx tap" onclick={oncancel} aria-label={t("답장 취소")} title={t("답장 취소")}><Icon name="x" /></button>
</div>

<style>
	.reply-badge {
		display: flex;
		align-items: center;
		gap: 8px;
		/* left = the composer's 16px text line; right = 8px, so the pill's ✕ (22px button, 4px padding) centres
		   23px from the edge: the same column as the queue's ✕ above it (14px glyph ending on the 16px line) */
		margin: 8px 8px 0 16px;
		padding: 4px 4px 4px 8px;
		min-width: 0;
		border-radius: var(--radius-pill);
		background: var(--accent-soft);
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.reply-badge :global(svg) { width: 13px; height: 13px; flex: none; stroke-width: 1.8; }
	.rwho { font-weight: 600; color: var(--text); flex: none; }
	.rtext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rx { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; padding: 0; color: inherit; }
	.rx :global(svg) { width: 14px; height: 14px; stroke-width: 2; }
	.rx:hover { background: var(--accent-soft); color: var(--text); }
	@container (max-width: 420px) {
		.reply-badge {
			margin-left: 12px;
		}
	}
</style>
