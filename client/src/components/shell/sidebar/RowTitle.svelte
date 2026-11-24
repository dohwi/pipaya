<script lang="ts">
	import { getContext } from "svelte";
	import { marquee } from "../../../lib/fit-text";
	import InlineRenameField from "../../ui/InlineRenameField.svelte";
	import { ROW_RENAME, type RowRename } from "./row-rename";

	/**
	 * A row's name. One that does not fit flows by while the row is hovered or focused, looping back to its start.
	 * While its row is renamed in place this is the field: the icon and the row stay, only the name becomes editable.
	 */
	let { text }: { text: string } = $props();
	const rn = getContext<RowRename | undefined>(ROW_RENAME);
</script>

{#if rn?.active}
	<InlineRenameField variant="inline" value={rn.draft} oninput={rn.ondraft} oncommit={rn.oncommit} oncancel={rn.oncancel} maxlength={rn.maxlength} />
{:else}
	<span class="title" use:marquee={text}><span class="track"><span class="mq">{text}</span><span class="dup" aria-hidden="true">{text}</span></span></span>
{/if}

<style>
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px; /* whole-pixel line box (DESIGN rule 3) */
	}
	/* a title that does not fit flows by while the row is hovered or focused, looping back to its start */
	.title .track {
		display: inline;
	}
	.title .dup {
		display: none;
	}
	:global(:where(.side) .item.active .title) {
		font-weight: 700;
		color: var(--text);
	}
	@media (hover: hover) {
		:global(:where(.side) .item:hover .title[data-over]),
	:global(:where(.side) .item:has(:focus-visible) .title[data-over]) {
			text-overflow: clip;
			-webkit-mask-image: var(--mq-mask);
			mask-image: var(--mq-mask);
		}
		:global(:where(.side) .item:hover .title[data-over] .track),
	:global(:where(.side) .item:has(:focus-visible) .title[data-over] .track) {
			display: flex;
			width: max-content;
			animation: mq var(--mq-d, 8s) linear infinite;
		}
		:global(:where(.side) .item:hover .title[data-over] .mq),
	:global(:where(.side) .item:has(:focus-visible) .title[data-over] .mq),
	:global(:where(.side) .item:hover .title[data-over] .dup),
	:global(:where(.side) .item:has(:focus-visible) .title[data-over] .dup) {
			display: block;
			flex: none;
			padding-right: 32px;
		}
	}
	/* touch has no hover, so the open session's long title flows by on its own; on desktop only hover/focus (above) does */
	@media (hover: none) {
		:global(:where(.side) .item.active .title[data-over]) {
			text-overflow: clip;
			-webkit-mask-image: var(--mq-mask);
			mask-image: var(--mq-mask);
		}
		:global(:where(.side) .item.active .title[data-over] .track) {
			display: flex;
			width: max-content;
			animation: mq var(--mq-d, 8s) linear infinite;
		}
		:global(:where(.side) .item.active .title[data-over] .mq),
	:global(:where(.side) .item.active .title[data-over] .dup) {
			display: block;
			flex: none;
			padding-right: 32px;
		}
	}
	@keyframes -global-mq {
		from {
			translate: 0;
		}
		to {
			translate: -50%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(:where(.side) .item .title[data-over] .track) {
			animation: none !important;
		}
	}
</style>
