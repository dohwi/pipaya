<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";

	/**
	 * The "pinned" mark: a small pin set into its host icon's bottom-right corner (the top-right corner is the status
	 * dot's, a `Pin`), so the pinned icon reads as one new icon. The icon is knocked out in a circle around the pin (a
	 * mask, no plate or halo: it works on any background), leaving a hair of air between the two.
	 * One look everywhere a pinned thing is shown: sidebar folders and tabs, and the tab strip.
	 *
	 *  The host must be `position: relative`; its other children are the icon and get the cutout.
	 *  The pin is a 9px glyph slanted 35deg, its box 1px past the icon glyph's corner (whole pixels, so it stays crisp at 1x
	 *  and barely pulls the icon off its row's centre); the cutout is a 5.3px circle round the pin's centre.
	 *  A host whose icon glyph is smaller than the box (a 14px glyph centred in 16px) sets `--pinmark-inset` to the gap (1px).
	 *  Its colour is `--pinmark-c` (default the icon's resting grey); a host showing an agent's state gets the same state
	 *  colour, so the pin follows the logo.
	 */
	let { label = t("고정됨") }: { label?: string } = $props();
</script>

<span class="pinmark" role="img" aria-label={label} title={label}><Icon name="pin" /></span>

<style>
	.pinmark {
		position: absolute;
		/* a 9px box ending 1px past the icon glyph's corner (whole pixels: crisp at 1x); a glyph smaller than its host box sits --pinmark-inset in from it */
		right: calc(var(--pinmark-inset, 0px) - 1px);
		bottom: calc(var(--pinmark-inset, 0px) - 1px);
		display: grid;
		place-items: center;
		width: 9px;
		height: 9px;
		color: var(--pinmark-c, var(--text-dim));
		pointer-events: none;
	}
	.pinmark :global(svg) {
		width: 9px;
		height: 9px;
		stroke-width: 2.3;
		transform: rotate(35deg);
	}
	/* the icon glyph beside the mark (not the status dot) is knocked out round the pin: centre on the pin's (3.5px inside the glyph's corner), radius 5.3 (pin 4.5 + 0.8 of air).
	   The glyph is its own mask box, so the centre is 1.5px inside the glyph's corner whatever the host's size */
	:global(:has(> .pinmark)) > :global(:not(.pinmark, .pin)) {
		--cut: 3.5px;
		-webkit-mask: radial-gradient(circle 5.3px at calc(100% - var(--cut)) calc(100% - var(--cut)), transparent 4.8px, #000 5.3px);
		mask: radial-gradient(circle 5.3px at calc(100% - var(--cut)) calc(100% - var(--cut)), transparent 4.8px, #000 5.3px);
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
