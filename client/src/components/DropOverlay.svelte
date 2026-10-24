<script lang="ts">
	import { t } from "../lib/i18n";
	import { fadeIn, fadeOut } from "../lib/motion";

	/** Full-screen "drop files to attach" cover shown while a file is dragged over the window. */
</script>

<div class="drop" in:fadeIn|global out:fadeOut|global>{t("파일을 놓아서 첨부")}</div>

<style>
	.drop {
		position: fixed;
		inset: 0;
		z-index: var(--z-dropzone);
		display: grid;
		place-items: center;
		background: var(--scrim);
		color: #fff; /* sits on the dark scrim in both themes */
		font-size: var(--fs-2xl);
		font-weight: 600;
		border: 3px dashed var(--text-faint);
		pointer-events: none;
	}
</style>
