<script lang="ts">
	import type { Snippet } from "svelte";
	import { fadeIn, fadeOut, modalIn, modalOut } from "../lib/motion";
	import { modalLayer, portal as lift } from "../lib/dialog";
	import ModalHeader from "./ModalHeader.svelte";

	/**
	 * The one modal panel: scrim + panel, the same enter/exit, a bottom sheet on phones, the z-index layer for its
	 * nesting depth, and (lib/dialog.ts) Esc for the top modal only, Tab kept inside, focus returned to the opener,
	 * and the app's shortcuts muted while it is open. With `title` it draws the shared header (ModalHeader: title,
	 * subtitle, close, pull-to-dismiss); without, the caller draws its own. Body and footer are the caller's.
	 *
	 * Transitions are `|global`: a component whose root is this modal is shown by its parent's `{#if}`, and a local
	 * transition would only play for a block inside this file (see tests/motion.test.ts).
	 */
	type Width = "s" | "m" | "l" | "xl" | (string & {});
	let {
		onclose,
		onescape,
		label,
		labelledby,
		describedby,
		role = "dialog",
		live,
		width = "m",
		height,
		maxHeight = "640px",
		gutter = "var(--modal-gutter)",
		layer = 1,
		elevated = false,
		sheet = true,
		safeArea = false,
		portal = false,
		dismissible = true,
		class: cls = "",
		title,
		sub,
		subMono = false,
		divider = false,
		compact = false,
		onback,
		headerActions,
		children,
	}: {
		onclose: () => void;
		/** Esc when it should do less than closing (step back from a sub-page); defaults to `onclose` */
		onescape?: () => void;
		label?: string;
		labelledby?: string;
		describedby?: string;
		role?: "dialog" | "alertdialog";
		live?: "polite" | "assertive";
		/** a size token (`--modal-w-*`) or any CSS length; never wider than the viewport minus `gutter` */
		width?: Width;
		/** a fixed height (e.g. a window with tabs that must not jump); otherwise it grows up to `maxHeight` */
		height?: string;
		maxHeight?: string;
		gutter?: string;
		/** 1 for a modal over the page, +1 for each modal opened from another */
		layer?: 1 | 2 | 3 | 4 | 5;
		/** a raised surface, for pickers that open over another modal */
		elevated?: boolean;
		/** false: stays a centred card on phones instead of becoming a bottom sheet */
		sheet?: boolean;
		/** pad the bottom by the home-indicator inset when the sheet has no footer of its own doing it */
		safeArea?: boolean;
		/** lift to <body>: needed when opened from inside a transformed panel */
		portal?: boolean;
		/** false while closing must wait (saving, downloading); Esc and the scrim then do nothing */
		dismissible?: boolean;
		class?: string;
		/** draws the shared header (and labels the dialog with it when `label` is not given) */
		title?: string;
		sub?: string | null;
		subMono?: boolean;
		/** a hairline under the header */
		divider?: boolean;
		/** the smaller header of a picker stacked over another dialog */
		compact?: boolean;
		/** a back arrow before the title (a step inside the dialog) */
		onback?: () => void;
		/** icon buttons placed before the header's close button */
		headerActions?: Snippet;
		children: Snippet;
	} = $props();

	const tokens = ["s", "m", "l", "xl"];
	const w = $derived(tokens.includes(width) ? `var(--modal-w-${width})` : width);
	const dismiss = () => dismissible && onclose();
	// Before any child mounts and focuses itself: this is where focus goes back to on close.
	const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
</script>

{#snippet body()}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="scrim" style:z-index="var(--z-scrim-{layer})" onclick={dismiss} in:fadeIn|global out:fadeOut|global></div>
	<div
		class="modal {cls}"
		class:elevated
		class:sheet
		class:safe={safeArea}
		class:fixed={!!height}
		{role}
		aria-modal="true"
		aria-label={label ?? title}
		aria-labelledby={labelledby}
		aria-describedby={describedby}
		aria-live={live}
		style:z-index="var(--z-modal-{layer})"
		style:--modal-w={w}
		style:--modal-h={height}
		style:--modal-max-h={maxHeight}
		style:--modal-gut={gutter}
		use:modalLayer={{ onclose: onescape ?? onclose, dismissible, opener }}
		in:modalIn|global
		out:modalOut|global
	>
		{#if title}
			<ModalHeader {title} {sub} {subMono} {divider} {compact} {onback} {onclose} closeDisabled={!dismissible} actions={headerActions} />
		{/if}
		{@render children()}
	</div>
{/snippet}

{#if portal}
	<div use:lift>{@render body()}</div>
{:else}
	{@render body()}
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: var(--scrim);
	}
	.modal {
		position: fixed;
		left: 50%;
		top: 50%;
		translate: -50% -50%;
		width: min(var(--modal-w), calc(var(--vw) - var(--modal-gut)));
		max-height: min(var(--modal-max-h), calc(var(--dvh) - 24px));
		display: flex;
		flex-direction: column;
		background: var(--bg-side);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow);
		color: var(--text);
		overflow: hidden;
	}
	.modal.fixed {
		height: min(var(--modal-h), calc(var(--dvh) - var(--modal-gut)));
	}
	.modal.elevated {
		background: var(--bg-elev);
	}
	@media (max-width: 640px) {
		.modal.sheet {
			top: auto;
			bottom: 0;
			translate: -50% 0;
			width: var(--vw);
			max-height: calc(var(--dvh) * 0.9);
			border-bottom: 0;
			border-radius: var(--radius-panel) var(--radius-panel) 0 0;
		}
		.modal.sheet.fixed {
			height: calc(var(--dvh) * 0.9);
		}
		.modal.sheet.safe {
			padding-bottom: var(--sab);
		}
	}
</style>
