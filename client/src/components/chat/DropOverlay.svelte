<script lang="ts">
	import { t } from "../../lib/i18n";
	import { fadeIn, fadeOut } from "../../lib/motion";
	import { portal } from "../../lib/dialog";

	/** Full-screen "drop files to attach" cover shown while a file is dragged over the window. Lifted to <body>: inside the
	 *  pane (isolation: isolate) its z-index stayed in the pane's stacking context and the top bar painted over it. */
</script>

<div class="drop" use:portal in:fadeIn|global out:fadeOut|global>{t("파일을 놓아서 첨부")}</div>

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
		pointer-events: none;
	}
	/* The dashed frame floats 16px inside the window with the panel radius: drawn on the window edge it was cut by the
	   rounded window corners, and --text-faint read as a dark grey dash on the light theme's scrim. */
	.drop::before {
		content: "";
		position: absolute;
		inset: calc(16px + var(--sat)) calc(16px + var(--sar)) calc(16px + var(--sab)) calc(16px + var(--sal));
		border: 2px dashed rgba(255, 255, 255, 0.6); /* on the dark scrim in both themes, like the text */
		border-radius: var(--radius-panel);
	}
</style>
