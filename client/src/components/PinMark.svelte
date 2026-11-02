<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";

	/**
	 * The "pinned" mark: a small pin set into its host icon's bottom-right corner (the top-right corner is the status
	 * dot's, a `Pin`), so the pinned icon reads as one new icon. The icon is knocked out in the pin's own shape (a
	 * mask, no plate or halo: it works on any background), leaving a hair of air between the two.
	 * One look everywhere a pinned thing is shown: sidebar folders and tabs, and the tab strip.
	 *
	 *  The host must be `position: relative`; its other children are the icon and get the cutout.
	 *  The pin is a 9px glyph slanted 35deg, its box 1px past the icon glyph's corner (whole pixels, so it stays crisp at 1x
	 *  and barely pulls the icon off its row's centre); the cutout follows the pin's own outline with 0.9px of air.
	 *  A host whose icon glyph is smaller than the box (a 14px glyph centred in 16px) sets `--pinmark-inset` to the gap (1px).
	 *  Its colour is always `--pinned` (white on dark, black on light), never the icon's or a state colour: the status dot already owns those.
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
		color: var(--pinned);
		pointer-events: none;
	}
	.pinmark :global(svg) {
		width: 9px;
		height: 9px;
		stroke-width: 2.3;
		transform: rotate(35deg);
	}
	/* the icon glyph beside the mark (not the status dot) is knocked out in the pin's own outline, 0.9px wider all round (a stroke
	   of 2.3 + 2 x 0.9 / 0.375 = 7.1 in the 24-unit pin space, scaled 0.375 to the 9px box, slanted the same 35deg). The 13px cut
	   image holds the 9px pin box at 2..11 with 2px of margin for that stroke; it sits so the pin box ends 1px past the glyph's
	   corner, exactly over the mark: 13px at right/bottom -3px. The glyph is its own mask box, so this holds for 14 and 16px icons.
	   Everything else of the glyph stays (the first layer, a plain fill, minus the cut) */
	/* The host list is spelled out: a bare `:has(> .pinmark)` has every element as its subject, so each DOM change anywhere
	   (a streamed reply, a row's state flip) made the browser re-test the whole page for it. The hosts are the icon boxes
	   of the sidebar rows (.lead, .dicon) and tab bar (.ico); a new host kind has to be added here. */
	:global(:where(.lead, .dicon, .ico):has(> .pinmark)) > :global(:not(.pinmark, .pin)) {
		--pinmark-cut: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 13 13'%3E%3Cpath transform='translate(2 2) scale(.375) rotate(35 12 12)' d='M9 3h6l-1 6 3 3v2H7v-2l3-3zM12 14v7' stroke='%23000' stroke-width='7.1' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
		-webkit-mask:
			linear-gradient(#000, #000),
			var(--pinmark-cut) right -3px bottom -3px / 13px 13px no-repeat;
		-webkit-mask-composite: xor;
		mask:
			linear-gradient(#000, #000),
			var(--pinmark-cut) right -3px bottom -3px / 13px 13px no-repeat;
		mask-composite: exclude;
	}
</style>
