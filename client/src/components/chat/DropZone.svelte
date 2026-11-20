<script lang="ts">
	import { t } from "../../lib/i18n";
	import { fadeIn, fadeOut } from "../../lib/motion";
	import Icon from "../ui/Icon.svelte";

	/** "Drop files to attach" over this chat pane while a file is dragged over the window: a dashed frame inset in the
	 *  pane with the label in its middle. Rendered from the composer but outside `.box`, so `position: absolute` resolves
	 *  to the pane (position: relative, isolation: isolate) and it covers the conversation and the input, not the app. */
</script>

<div class="zone" in:fadeIn|global out:fadeOut|global>
	<div class="label"><Icon name="attach" /><span>{t("파일을 놓아서 첨부")}</span></div>
</div>

<style>
	.zone {
		position: absolute;
		inset: 12px;
		z-index: var(--z-droplayer);
		display: grid;
		place-items: center;
		border: 2px dashed var(--text-faint);
		border-radius: var(--radius-panel);
		background: color-mix(in srgb, var(--bg) 94%, transparent);
		pointer-events: none;
	}
	.label {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 24px 32px;
		line-height: 24px;
		font-size: var(--fs-lg);
		font-weight: 600;
		color: var(--text);
	}
	.label :global(.ic) {
		width: 40px;
		height: 40px;
		stroke-width: 1.6;
		color: var(--text-dim);
	}
</style>
