<script lang="ts">
	import { t } from "../../lib/i18n";
	import Icon from "./Icon.svelte";

	/**
	 * The corner mark: a small glyph set into its host icon's bottom-right corner (the top-right corner is the status dot's,
	 * a `Pin`), so the marked icon reads as one new icon. The icon is knocked out in the mark's own outline (a mask, no plate
	 * or halo: it works on any background), leaving a hair of air between the two. One look for every such mark:
	 *
	 *  kind   pin  = the tab or folder is pinned (sidebar folders and tabs, the tab strip, tab overview)
	 *         goal = the conversation has a goal (AgentBadge, wherever the agent's logo is drawn)
	 *  tone   matches the host icon's activity hue (info / warn / ok / danger) when active, mixed 28% toward `--pinned` so
	 *         the 9px mark stays unified with the logo and `@name` yet crisper/deeper than the logo in both themes.
	 *         `neutral` (idle icons, folders, terminals, groups) uses `--pinned`.
	 *  quiet  the thing it marks is resting (a paused or achieved goal): steps down to `--text-dim` so it stays calm.
	 *
	 *  The host must be `position: relative`; its other children are the icon and get the cutout.
	 *  The mark is a 9px box ending `--pinmark-out` (1px on line icons whose 24-unit glyph sits inside 3..21; 2px on
	 *  full-bleed brand logos whose glyph fills 1..23) past the icon glyph's corner, whole pixels so it stays crisp at 1x.
	 *  A host whose icon glyph is smaller than its box (a 14px glyph centred in 16px) sets `--pinmark-inset` to the gap (1px).
	 *  Only one mark per icon: a pinned conversation with a goal shows the goal's (the caller leaves the pin out).
	 */
	let {
		kind = "pin",
		tone = "neutral",
		quiet = false,
		label,
	}: {
		kind?: "pin" | "goal";
		tone?: "neutral" | "info" | "warn" | "ok" | "danger" | "accent";
		quiet?: boolean;
		label?: string;
	} = $props();
	const name = $derived(label ?? (kind === "goal" ? t("목표") : t("고정됨")));
</script>

<span class="pinmark k-{kind} t-{tone}" class:quiet role="img" aria-label={name} title={name}>
	{#if kind === "goal"}
		<!-- a ring with a filled centre, sized to match the pin's painted footprint (~6.4px inside 9px) -->
		<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.4" class="ring" /><circle cx="12" cy="12" r="2.6" class="dot" /></svg>
	{:else}
		<Icon name="pin" />
	{/if}
</span>

<style>
	.pinmark {
		position: absolute;
		/* 9px box ending --pinmark-out (1px line icons, 2px full-bleed brand logos) past the glyph corner; whole pixels for 1x crispness */
		right: calc(var(--pinmark-inset, 0px) - var(--pinmark-out, 1px));
		bottom: calc(var(--pinmark-inset, 0px) - var(--pinmark-out, 1px));
		display: grid;
		place-items: center;
		width: 9px;
		height: 9px;
		color: var(--pinned);
		pointer-events: none;
		transition: color var(--motion-fast) var(--ease-std);
	}
	/* Active state hue: unified with the logo and @name, lifted 28% toward --pinned (brighter on dark, deeper on light)
	   so the small mark reads slightly bolder than the logo and never fades when the logo pulses. */
	.t-info {
		color: color-mix(in srgb, var(--info) 72%, var(--pinned));
	}
	.t-warn {
		color: color-mix(in srgb, var(--warn) 72%, var(--pinned));
	}
	.t-ok {
		color: color-mix(in srgb, var(--ok) 72%, var(--pinned));
	}
	.t-danger {
		color: color-mix(in srgb, var(--danger) 72%, var(--pinned));
	}
	.quiet {
		color: var(--text-dim);
	}
	.pinmark :global(svg) {
		width: 9px;
		height: 9px;
	}
	.k-pin :global(svg) {
		stroke-width: 2.3;
		transform: rotate(35deg);
	}
	/* the goal: the ring at the pin's 2.3 stroke and a filled 2.6-unit centre, matching the pin's visual weight at 9px */
	.k-goal .ring {
		fill: none;
		stroke: currentColor;
		stroke-width: 2.3;
	}
	.k-goal .dot {
		fill: currentColor;
		stroke: none;
	}
	/* Full-bleed brand logos (.agent: 1..23 of 24u) have ~1px less internal margin than line icons (3..21), so their mark
	   steps 1px further out (2px past the box) to sit on the same visual corner without eating into the logo's centre. */
	:global(:where(.agent, .lead:has(> .agent), .ico:has(> .agent)):has(> .pinmark)) {
		--pinmark-out: 2px;
	}
	/* The icon glyph beside the mark (not the status dot) is knocked out in the mark's own outline, 0.9px wider all round. Each cut
	   image is 13px and holds the 9px mark box at 2..11 with 2px of margin for the widened outline; it sits so the mark box ends
	   --pinmark-out past the glyph's corner, exactly over the mark: 13px at right/bottom (-2px - --pinmark-out). The glyph is its
	   own mask box, so this holds for 14, 16 and 24px icons. Everything else of the glyph stays (plain fill minus the cut).
	    pin   the pin's path stroked at 2.3 + 2 x 0.9 / 0.375 = 7.1 in the 24-unit space (scaled 0.375 to 9px), slanted 35deg
	    goal  the ring's outer edge (r 7.4 + 2.3 / 2 = 8.55) widened by 0.9px: a disc of 8.55 + 2.4 = 10.95 units, 4.11px at 9px
	   The host list is spelled out: a bare `:has(> .pinmark)` has every element as its subject, so each DOM change anywhere
	   (a streamed reply, a row's state flip) made the browser re-test the whole page for it. The hosts are the icon boxes of
	   the sidebar rows (.lead, .dicon), the tab bar / overview (.ico) and the agent badge (.agent); a new host kind has to be
	   added here (and to PIN_HOSTS in scripts/ui-lint.py). */
	:global(:where(.lead, .dicon, .ico, .agent):has(> .pinmark)) > :global(:not(.pinmark, .pin)) {
		--pinmark-pos: calc(-2px - var(--pinmark-out, 1px));
		-webkit-mask:
			linear-gradient(#000, #000),
			var(--pinmark-cut) right var(--pinmark-pos) bottom var(--pinmark-pos) / 13px 13px no-repeat;
		-webkit-mask-composite: xor;
		mask:
			linear-gradient(#000, #000),
			var(--pinmark-cut) right var(--pinmark-pos) bottom var(--pinmark-pos) / 13px 13px no-repeat;
		mask-composite: exclude;
	}
	:global(:where(.lead, .dicon, .ico, .agent):has(> .pinmark.k-pin)) > :global(:not(.pinmark, .pin)) {
		--pinmark-cut: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 13 13'%3E%3Cpath transform='translate(2 2) scale(.375) rotate(35 12 12)' d='M9 3h6l-1 6 3 3v2H7v-2l3-3zM12 14v7' stroke='%23000' stroke-width='7.1' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
	}
	:global(:where(.lead, .dicon, .ico, .agent):has(> .pinmark.k-goal)) > :global(:not(.pinmark, .pin)) {
		--pinmark-cut: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 13 13'%3E%3Ccircle cx='6.5' cy='6.5' r='4.11'/%3E%3C/svg%3E");
	}
</style>
