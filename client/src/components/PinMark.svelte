<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";

	/**
	 * The "pinned" mark: a small pin stuck in its host icon's bottom-right corner (the top-right corner is the status
	 * dot's, a `Pin`). One look everywhere a pinned thing is shown: sidebar folders and tabs, and the tab strip.
	 *
	 *  The host must be `position: relative`. It sits in the same spot whatever the title beside it.
	 *  The glyph is 10px, slanted 35deg (driven in), with a thin halo in `--pinmark-ring` (default the sidebar's colour) so it
	 *  reads over the icon without a plate. Its colour is `--pinmark-c` (default the icon's resting grey); a host showing an
	 *  agent's state sets it to the same state colour, so the pin follows the logo.
	 *  It overlaps the icon's corner a little (stuck into it). `--pinmark-x` / `--pinmark-y` move it (defaults fit a 16px
	 *  icon; a 14px one uses -2px / 0, so the mark sits at the same spot of the glyph).
	 */
	let { label = t("고정됨") }: { label?: string } = $props();
</script>

<span class="pinmark" role="img" aria-label={label} title={label}><Icon name="pin" /></span>

<style>
	.pinmark {
		position: absolute;
		right: var(--pinmark-x, -1px);
		bottom: var(--pinmark-y, -1px);
		display: grid;
		place-items: center;
		width: 10px;
		height: 10px;
		color: var(--pinmark-c, var(--text-dim));
		pointer-events: none;
	}
	.pinmark :global(svg) {
		width: 10px;
		height: 10px;
		stroke-width: 2.4;
		transform: rotate(35deg);
		filter: drop-shadow(0 0 1px var(--pinmark-ring, var(--bg-side))) drop-shadow(0 0 1px var(--pinmark-ring, var(--bg-side)));
	}
	/* an agent's logo carries its state colour: the pin takes the same one */
	:global(:has(> .agent.working)) > .pinmark {
		--pinmark-c: var(--info);
	}
	:global(:has(> .agent.asking)) > .pinmark {
		--pinmark-c: var(--warn);
	}
	:global(:has(> .agent.done)) > .pinmark {
		--pinmark-c: var(--ok);
	}
	:global(:has(> .agent.failed)) > .pinmark {
		--pinmark-c: var(--danger);
	}
</style>
