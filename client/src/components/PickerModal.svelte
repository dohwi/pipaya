<script lang="ts">
	import Button from "./Button.svelte";
	import type { Snippet } from "svelte";
	import { t } from "../lib/i18n";
	import { isPhone } from "../lib/motion";
	import Modal from "./Modal.svelte";

	/**
	 * The shell every "search, then pick one from a grouped list" dialog shares (model picker, OpenRouter match, ...):
	 * the shared header, a search field, a scrolling list, an optional block under it, and a footer with Close.
	 *
	 * Keys: ↓ from the search field enters the list, ↑/↓ move between options (PickerOption), ↑ on the first goes back
	 * to the search field, Home/End jump, Enter/Space pick (they are buttons). A pick is applied at once by the
	 * caller's own `onclick` and the dialog stays open (try another, compare), so the footer only closes it.
	 */
	let {
		title,
		onclose,
		query = $bindable(""),
		placeholder,
		width = "m",
		layer = 4,
		minList = "120px",
		list,
		after,
		footerStart,
	}: {
		title: string;
		onclose: () => void;
		query?: string;
		placeholder?: string;
		width?: string;
		layer?: 1 | 2 | 3 | 4;
		/** the list never shrinks below this, so a filter with few hits does not collapse the dialog */
		minList?: string;
		list: Snippet;
		/** below the list, above the footer (e.g. the reasoning strength row) */
		after?: Snippet;
		/** the footer's left side (e.g. "manage connections") */
		footerStart?: Snippet;
	} = $props();

	const phone = isPhone();
	let search = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLElement | null>(null);

	const options = () => Array.from(listEl?.querySelectorAll<HTMLElement>(".pk-opt:not([aria-disabled='true'])") ?? []);
	function move(to: HTMLElement | undefined) {
		if (!to) return;
		to.focus();
		to.scrollIntoView({ block: "nearest" });
	}
	function searchKeys(e: KeyboardEvent) {
		if (e.key !== "ArrowDown") return;
		e.preventDefault();
		const opts = options();
		move(opts.find((o) => o.getAttribute("aria-pressed") === "true") ?? opts[0]);
	}
	function listKeys(e: KeyboardEvent) {
		const opts = options();
		const i = opts.indexOf(document.activeElement as HTMLElement);
		if (i < 0) return;
		if (e.key === "ArrowDown") move(opts[Math.min(i + 1, opts.length - 1)]);
		else if (e.key === "ArrowUp") i === 0 ? search?.focus() : move(opts[i - 1]);
		else if (e.key === "Home") move(opts[0]);
		else if (e.key === "End") move(opts[opts.length - 1]);
		else return;
		e.preventDefault();
	}
	function focusFirst(node: HTMLInputElement) {
		if (!phone) node.focus();
	}
</script>

<Modal {onclose} {title} compact {width} {layer} elevated portal>
	<div class="pk-body">
		<input bind:this={search} class="field pk-search" placeholder={placeholder ?? t("검색")} aria-label={placeholder ?? t("검색")} bind:value={query} onkeydown={searchKeys} use:focusFirst autocomplete="off" spellcheck="false" />
		<!-- Arrow keys typed in the search field or the list move the highlight (searchKeys / listKeys); the rows are buttons. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="pk-list" bind:this={listEl} style:min-height={minList} onkeydown={listKeys}>
			{@render list()}
		</div>
		{@render after?.()}
	</div>
	<footer class="pk-foot">
		{@render footerStart?.()}
		<span class="grow"></span>
		<Button size="sm" onclick={onclose}>{t("닫기")}</Button>
	</footer>
</Modal>

<style>
	.pk-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 4px 12px 12px;
	}
	.pk-search {
		flex: none;
		height: 38px;
	}
	.pk-list {
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow-y: auto;
		margin: 0 -4px;
		padding: 0 4px;
	}
	/* group labels and the empty line are plain markup from the caller */
	.pk-list :global(.pk-group) {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 8px 4px;
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: lowercase;
		color: var(--text-faint);
	}
	.pk-list :global(.pk-empty) {
		padding: 16px;
		text-align: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
	.pk-foot {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px calc(8px + var(--sab));
		border-top: 1px solid var(--border);
	}
	.grow {
		flex: 1;
	}
	@media (max-width: 640px) {
		.pk-search {
			font-size: var(--fs-lg); /* below 16px iOS zooms the page when the field is focused */
		}
	}
</style>
