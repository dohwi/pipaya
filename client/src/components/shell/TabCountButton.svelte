<script lang="ts">
	import { t } from "../../lib/i18n";
	import { tabCountText } from "../../lib/tab-overview";
	import { app } from "../../lib/store.svelte";

	/**
	 * The tab count in a small rounded square, a mobile browser's tab button: opens the tab overview. It sits in
	 * TabControls beside "+": `bar` is the 28px button pinned to the right end of the tab strip, `header` the 32 x 40 one
	 * of the phone header (where the strip is folded away for a lone tab).
	 */
	let { count, place = "bar" }: { count: number; place?: "bar" | "header" } = $props();
	const label = $derived(t("탭 {n}개 모두 보기", { n: count }));
</script>

<button
	class="count tap {place}"
	class:on={app.tabOverview}
	onclick={() => (app.tabOverview = true)}
	aria-label={label}
	aria-haspopup="dialog"
	aria-expanded={app.tabOverview}
	title={label}
	data-part="tab-count"
>
	<span class="box mono" class:wide={count > 99}>{tabCountText(count)}</span>
</button>

<style>
	.count {
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		color: var(--text-dim); /* the "+" beside it (TabControls) has the same ink */
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	/* the header's tool buttons: 32 wide, 40 tall, round (Header.svelte `.tool` on a phone) */
	.count.header {
		width: 28px; /* beside the 28px "+" (TabControls), so the pair sits tight */
		height: 40px;
		border-radius: 14px;
	}
	.count.header:focus-visible {
		outline-offset: -2px; /* 40px in a 44px bar, like the header's other buttons */
	}
	.count.on {
		background: var(--bg-hover);
		color: var(--text);
	}
	@media (hover: hover) {
		.count:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	/* the square: 18px with a 1.5px stroke like the line icons beside it, the number on a 16px line box (rule 3) */
	.box {
		box-sizing: border-box;
		min-width: 18px;
		height: 18px;
		padding: 0 2px; /* optical: a single digit keeps the 18px square, two digits widen it by their own ink only */
		border: 1.5px solid currentColor;
		border-radius: var(--radius-xs);
		font-size: var(--fs-2xs);
		font-weight: 700;
		line-height: 17px; /* the mono digits sit high in their em box: a 15px line (the inner box) left their ink 1px above the square's centre */
		text-align: center;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.02em;
	}
	/* "99+" in the same square: a size smaller so the box stays near the icons' width */
	.box.wide {
		font-size: 9px; /* off the type scale on purpose: three glyphs inside the 18px square */
	}
</style>
