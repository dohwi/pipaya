<script lang="ts">
	import type { Snippet } from "svelte";
	import { t } from "../lib/i18n";
	import { sheetPull } from "../lib/sheet";
	import Icon from "./Icon.svelte";

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
	} = $props();
</script>

<header class="mh" class:divider class:compact use:sheetPull={{ onclose: () => onclose?.(), disabled: !pull || !onclose || closeDisabled }}>
	{#if onback}<button type="button" class="iconbtn" onclick={onback} aria-label={t("뒤로")}><Icon name="chevron-left" /></button>{/if}
	<div class="mh-title">
		<h2 {id}>{title}{@render titleExtra?.()}</h2>
		{#if sub}<span class="mh-sub" class:mono={subMono}>{sub}</span>{/if}
	</div>
	{@render actions?.()}
	{#if onclose}<button type="button" class="iconbtn" onclick={onclose} disabled={closeDisabled} aria-label={t("닫기")}><Icon name="x" /></button>{/if}
</header>

<style>
	.mh {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 14px 14px 10px 22px;
	}
	.mh:has(> .iconbtn:first-child) {
		padding-left: 12px;
	}
	.mh.divider {
		padding-bottom: 12px;
		border-bottom: 1px solid var(--border);
	}
	.mh.compact {
		padding: 10px 8px 4px 18px;
	}
	.mh-title {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	h2 {
		margin: 0;
		font-size: var(--fs-xl);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.compact h2 {
		font-size: var(--fs-lg);
		font-weight: 600;
	}
	.mh-sub {
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
