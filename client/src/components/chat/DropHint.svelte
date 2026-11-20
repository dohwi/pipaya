<script lang="ts">
	import { t } from "../../lib/i18n";
	import { fadeIn, fadeOut } from "../../lib/motion";
	import Icon from "../ui/Icon.svelte";

	/** "Drop files to attach": a small card just above the composer box while a file is dragged over the window.
	 *  Sits inside `.box` (position: relative), like the slash menu, so it follows the input and never covers the page. */
</script>

<div class="drop" in:fadeIn|global out:fadeOut|global><Icon name="attach" />{t("파일을 놓아서 첨부")}</div>

<style>
	.drop {
		position: absolute;
		/* -1px / +9px: measured from .box's padding edge, these put the card on the box's outer border lines, 8px above it */
		left: -1px;
		right: -1px;
		bottom: calc(100% + 9px);
		z-index: var(--z-popover);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 12px 16px;
		line-height: 20px;
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
		background: var(--bg-elev);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		pointer-events: none;
	}
	.drop :global(.ic) {
		width: 16px;
		height: 16px;
	}
</style>
