<script lang="ts">
	import { onMount, tick, untrack } from "svelte";
	import { t } from "../lib/i18n";
	import { findRanges, MAX_MATCHES } from "../lib/find";
	import { app } from "../lib/store.svelte";
	import Icon from "./Icon.svelte";

	/** Search inside one conversation (Ctrl+F). Highlights with the CSS Custom Highlight API, so the message DOM is never touched. */
	let { paneId, focused }: { paneId: string | null; focused: boolean } = $props();

	let open = $state(false);
	let query = $state("");
	let input: HTMLInputElement | undefined = $state();
	let bar: HTMLDivElement | undefined = $state();
	let ranges = $state.raw<Range[]>([]);
	let index = $state(0);

	const scroller = () => bar?.closest(".pane")?.querySelector<HTMLElement>(".scroller") ?? null;
	const supported = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
	const prefix = `find-${Math.random().toString(36).slice(2, 8)}`;
	const ALL = `${prefix}-all`;
	const CURRENT = `${prefix}-current`;

	function paint() {
		if (!supported) return;
		CSS.highlights.delete(ALL);
		CSS.highlights.delete(CURRENT);
		if (!open || !ranges.length) return;
		CSS.highlights.set(ALL, new Highlight(...ranges));
		const cur = ranges[index];
		if (cur) CSS.highlights.set(CURRENT, new Highlight(cur));
	}

	function reveal() {
		const r = ranges[index];
		const root = scroller();
		if (!r || !root) return;
		// Pinned to the bottom, the list would snap back to the end right after we scroll away.
		root.dispatchEvent(new CustomEvent("unpin"));
		const el = r.startContainer.parentElement;
		el?.scrollIntoView({ block: "center", inline: "nearest" });
	}

	function search(keep = false) {
		const root = scroller();
		const prev = ranges[index];
		ranges = root && query.trim() ? findRanges(root, query) : [];
		if (keep && prev) {
			const same = ranges.findIndex((r) => r.startContainer === prev.startContainer && r.startOffset === prev.startOffset);
			index = same >= 0 ? same : Math.min(index, Math.max(ranges.length - 1, 0));
		} else index = 0;
		paint();
		if (!keep) reveal();
	}

	function step(d: 1 | -1) {
		if (!ranges.length) return;
		index = (index + d + ranges.length) % ranges.length;
		paint();
		reveal();
	}

	function close() {
		open = false;
		ranges = [];
		paint();
		// give the keyboard back to the composer
		bar?.closest(".pane")?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
	}

	// Ctrl+F: the focused pane opens its bar (or refocuses it).
	let seen = untrack(() => app.findTick);
	$effect(() => {
		const n = app.findTick;
		if (n === seen) return;
		seen = n;
		if (!untrack(() => focused)) return;
		open = true;
		void tick().then(() => {
			input?.focus();
			input?.select();
			if (query) search();
		});
	});

	$effect(() => {
		query;
		if (open) untrack(() => search());
	});

	// New text arrives while the bar is open (streaming, expanded cards): refresh the matches, but do not move the view.
	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		if (!open) return;
		const root = scroller();
		if (!root) return;
		const mo = new MutationObserver(() => {
			clearTimeout(timer);
			timer = setTimeout(() => search(true), 250);
		});
		mo.observe(root, { childList: true, subtree: true, characterData: true });
		return () => {
			mo.disconnect();
			clearTimeout(timer);
		};
	});

	$effect(() => {
		paneId;
		return () => {
			if (supported) {
				CSS.highlights.delete(ALL);
				CSS.highlights.delete(CURRENT);
			}
		};
	});

	onMount(() => () => {
		clearTimeout(timer);
		if (supported) {
			CSS.highlights.delete(ALL);
			CSS.highlights.delete(CURRENT);
		}
	});

	function onKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (e.key === "Enter") {
			e.preventDefault();
			step(e.shiftKey ? -1 : 1);
		}
	}

	const count = $derived(ranges.length >= MAX_MATCHES ? `${MAX_MATCHES}+` : String(ranges.length));
</script>

<svelte:head>
	{#if supported}
		{@html `<style>::highlight(${ALL}){background:var(--warn-soft);color:inherit}::highlight(${CURRENT}){background:var(--warn);color:#000}</style>`}
	{/if}
</svelte:head>

<div bind:this={bar} class="slot">
	{#if open}
		<div class="find" role="search">
			<Icon name="search" />
			<input
				bind:this={input}
				bind:value={query}
				onkeydown={onKey}
				placeholder={t("대화에서 찾기")}
				aria-label={t("대화에서 찾기")}
				spellcheck="false"
				autocomplete="off"
			/>
			<span class="n mono" class:none={!!query.trim() && !ranges.length}>{query.trim() ? (ranges.length ? `${index + 1}/${count}` : "0") : ""}</span>
			<button class="b" onclick={() => step(-1)} disabled={!ranges.length} aria-label={t("이전 결과")} title={t("이전 결과 (Shift+Enter)")}>
				<Icon name="chevron-left" />
			</button>
			<button class="b" onclick={() => step(1)} disabled={!ranges.length} aria-label={t("다음 결과")} title={t("다음 결과 (Enter)")}>
				<Icon name="chevron-right" />
			</button>
			<button class="b" onclick={close} aria-label={t("닫기")} title={t("닫기 (Esc)")}><Icon name="x" /></button>
		</div>
	{/if}
</div>

<style>
	.slot {
		position: absolute;
		top: 8px;
		right: 14px;
		z-index: 6;
	}
	.find {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 4px 4px 10px;
		background: var(--bg-elev);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
	}
	.find :global(svg) {
		width: 15px;
		height: 15px;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		color: var(--text-dim);
	}
	input {
		width: min(220px, 40vw);
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: var(--fs-sm);
		padding: 4px 2px;
	}
	.n {
		min-width: 44px;
		text-align: right;
		font-size: var(--fs-xs, 12px);
		color: var(--text-dim);
	}
	.n.none {
		color: var(--danger);
	}
	.b {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: var(--radius-sm);
		color: var(--text);
	}
	.b:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	.b:disabled {
		opacity: 0.4;
	}
</style>
