<script lang="ts">
	import IconButton from "./IconButton.svelte";
	import type { Snippet } from "svelte";
	import { t } from "../../lib/i18n";
	import { sheetPull } from "../../lib/sheet";

	/**
	 * The one dialog header: optional back button, title (+ a muted subtitle), extra actions, close button.
	 * It is also the bottom sheet's pull handle on phones (lib/sheet.ts), so every modal can be dragged down the same way.
	 * `Modal` renders it for you when given a `title`; use it directly when the header needs more (actions, a back step).
	 */
	let {
		title,
		sub,
		subMono = false,
		id,
		onclose,
		onback,
		closeDisabled = false,
		pull = true,
		divider = false,
		compact = false,
		titleExtra,
		lead,
		actions,
	}: {
		title: string;
		sub?: string | null;
		subMono?: boolean;
		/** for `aria-labelledby` */
		id?: string;
		/** omit to hide the close button (e.g. an embedded page) */
		onclose?: () => void;
		/** shows a back arrow before the title */
		onback?: () => void;
		closeDisabled?: boolean;
		/** false: not a pull handle (embedded, or closing must wait) */
		pull?: boolean;
		/** a hairline under the header, for dialogs whose body scrolls right below it */
		divider?: boolean;
		/** smaller title and padding, for pickers stacked over another dialog */
		compact?: boolean;
		/** inline after the title (a count, a server name) */
		titleExtra?: Snippet;
		/** icon buttons before the close button */
		actions?: Snippet;
		/** a mark before the title (what the dialog is about: a chat's agent logo), centred on the title and subtitle */
		lead?: Snippet;
	} = $props();
</script>

<header class="mh" class:divider class:compact use:sheetPull={{ onclose: () => onclose?.(), disabled: !pull || !onclose || closeDisabled }}>
	{#if onback}<IconButton icon="chevron-left" label={t("뒤로")} onclick={onback} />{/if}
	{#if lead}<span class="mh-lead">{@render lead()}</span>{/if}
	<div class="mh-title">
		<h2 {id}>{title}{@render titleExtra?.()}</h2>
		{#if sub}<span class="mh-sub" class:mono={subMono}>{sub}</span>{/if}
	</div>
	{#if actions || onclose}
		<div class="mh-acts">
			{@render actions?.()}
			{#if onclose}<IconButton icon="x" label={t("닫기")} onclick={onclose} disabled={closeDisabled} />{/if}
		</div>
	{/if}
</header>

<style>
	.mh {
		flex: none;
		display: flex;
		align-items: center;
		gap: var(--dlg-gap-sm);
		padding: var(--dlg-head-t) calc(var(--dlg-px) - 9.5px) var(--dlg-head-b) var(--dlg-px); /* the 38px close button holds a 19px glyph, 9.5px from its edge: the glyph lands on the body's right line (DESIGN.md 5), like the back button on the left */
	}
	.mh:has(> :global(.iconbtn:first-child)) {
		padding-left: calc(var(--dlg-px) - 9.5px); /* the back button's 19px glyph sits 9.5px in: it lands on the body's left line (DESIGN.md 5) */
	}
	.mh.divider {
		padding-bottom: var(--dlg-head-b);
		border-bottom: 1px solid var(--border);
	}
	.mh.compact {
		padding: 12px calc(16px - 9.5px) 4px 16px; /* compact list popover: fixed 16px gutter (its rows start at 16); the 38px close button's 9.5px inset puts the glyph exactly on it */
	}
	.mh-acts {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px; /* adjacent header icon buttons sit 4px apart app-wide; the 8px title gap stays on .mh */
	}
	.mh-lead {
		flex: none;
		display: inline-grid;
		place-items: center;
		margin-right: 4px; /* 8 (the header's gap) + 4 = 12 from the title, as a list card's mark sits from its text */
	}
	.mh-title {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	/* Whole-pixel line boxes. The body's 1.55 made the title 27.9px and the subtitle 18.6px, so a dialog was 564.81px tall and, centred
	   with translate, sat on a fraction: its text blurred and the badges inside were rounded up in one row and down in the next
	   (measured: 0.5px jumps between rows of one list). 28 + 18 keeps the header, and the dialog around it, on whole pixels. */
	h2 {
		margin: 0;
		font-size: var(--fs-xl);
		line-height: 28px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.compact h2 {
		font-size: var(--fs-lg);
		line-height: 24px;
		font-weight: 600;
	}
	.mh-sub {
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* phones: the title lines up with the 16px gutter every dialog body uses there */
	@media (max-width: 640px) {
		.mh {
			padding: var(--dlg-head-t) calc(var(--dlg-px) - 9.5px) 8px var(--dlg-px); /* same glyph-on-the-edge rule as above; the top stays 16px so the sheet grabber (bottom: 10px) keeps 6px clear */
		}
		.mh.compact {
			padding: 12px calc(16px - 9.5px) 4px 16px; /* the same fixed 16px as on a desktop: it already is the phone gutter */
		}
	}
</style>
