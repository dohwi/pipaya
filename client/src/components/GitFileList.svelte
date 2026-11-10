<script lang="ts">
	import SearchField from "./SearchField.svelte";
	import EmptyState from "./EmptyState.svelte";
	import { t } from "../lib/i18n";
	import { diffBar, baseOf, compact, dirOf, lineCounts, matchesFilter, windowRows } from "../lib/git-view";
	import type { GitCounts, GitFile } from "../lib/types";
	import { app } from "../lib/store.svelte";
	import type { Snippet } from "svelte";

	/**
	 * The changed files of the working tree, built for a list of any size: a filter box and kind tabs when there are many
	 * files, a +/- bar on every row, and only the rows on screen in the DOM (a 2,000-row list is ~30 nodes). The open file's
	 * diff is a row of its own under it, so every row keeps one height and the window maths stays exact.
	 */
	let {
		files,
		counts,
		truncated,
		cap,
		picked,
		onpick,
		diff,
	}: {
		files: GitFile[];
		counts: GitCounts;
		/** The server cut the list: `counts` says how many there really are. */
		truncated: boolean;
		cap: number;
		/** The open file, if any. */
		picked: { path: string; staged: boolean } | null;
		onpick: (f: GitFile) => void;
		/** The open file's diff, drawn under its row. */
		diff: Snippet;
	} = $props();

	type Kind = "all" | "staged" | "unstaged" | "untracked";
	let kind = $state<Kind>("all");
	let query = $state("");
	/** Searching earns its place once the list is longer than a screen. */
	const SEARCH_FROM = 12;

	const ROW = 32;
	const HEAD = 28;
	const MAX_H = 320;

	const kinds = $derived(
		([
			["all", t("전체"), counts.conflict + counts.staged + counts.unstaged + counts.untracked],
			["staged", t("스테이징됨"), counts.staged],
			["unstaged", t("변경됨"), counts.unstaged + counts.conflict],
			["untracked", t("추적 안 됨"), counts.untracked],
		] as [Kind, string, number][]).filter(([k, , n]) => k === "all" || n > 0),
	);
	const total = $derived(counts.conflict + counts.staged + counts.unstaged + counts.untracked);

	const inKind = (f: GitFile) => kind === "all" || (kind === "unstaged" ? f.state === "unstaged" || f.state === "conflict" : f.state === kind);
	/**
	 * With the whole list in hand, filtering is instant and local. When the server cut the list, a local filter would
	 * only search the page, so the words go to the server (after a pause) and its answer replaces the page.
	 */
	let remote = $state<{ q: string; kind: Kind; files: GitFile[]; matched: number; truncated: boolean } | null>(null);
	let searching = $state(false);
	const useRemote = $derived(truncated && (!!query.trim() || kind !== "all"));
	$effect(() => {
		const q = query.trim();
		const k = kind;
		if (!truncated || (!q && k === "all")) {
			remote = null;
			searching = false;
			return;
		}
		const id = app.readableId;
		const api = app.api;
		if (!id || !api) return;
		searching = true;
		const ctrl = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const r = await api.gitFiles(id, { ...(q ? { q } : {}), ...(k !== "all" ? { kind: k } : {}) }, ctrl.signal);
				remote = { q, kind: k, files: r.files, matched: r.matched, truncated: r.truncated };
			} catch (e) {
				if ((e as Error).name !== "AbortError") remote = null;
			} finally {
				if (!ctrl.signal.aborted) searching = false;
			}
		}, 250);
		return () => {
			clearTimeout(timer);
			ctrl.abort();
		};
	});
	const shown = $derived(useRemote && remote ? remote.files : files.filter((f) => inKind(f) && matchesFilter(f.path, query)));
	const matchedTotal = $derived(useRemote && remote ? remote.matched : shown.length);
	const moreThanShown = $derived(useRemote && remote ? remote.truncated : truncated && !useRemote);

	/** One flat list of rows: a heading per kind (only while "all" is on), then its files; the open diff is one row. */
	type Row = { type: "head"; title: string; n: number; key: string } | { type: "file"; f: GitFile; key: string; open: boolean } | { type: "diff"; key: string };
	const rows = $derived.by(() => {
		const out: Row[] = [];
		const groups: [string, GitFile[]][] = [
			[t("충돌"), shown.filter((f) => f.state === "conflict")],
			[t("스테이징됨"), shown.filter((f) => f.state === "staged")],
			[t("변경됨"), shown.filter((f) => f.state === "unstaged")],
			[t("추적 안 됨"), shown.filter((f) => f.state === "untracked")],
		];
		for (const [title, list] of groups) {
			if (!list.length) continue;
			if (kind === "all") out.push({ type: "head", title, n: list.length, key: `h:${title}` });
			for (const f of list) {
				const open = !!picked && picked.path === f.path && picked.staged === (f.state === "staged");
				out.push({ type: "file", f, key: `${f.state}:${f.path}`, open });
			}
		}
		return out;
	});

	/** Row heights differ (heading, file, an open diff), so positions come from a running sum, not a multiplication. */
	const DIFF_H = 320;
	const heightOf = (r: Row) => (r.type === "head" ? HEAD : ROW);
	let scroller = $state<HTMLElement | null>(null);
	let top = $state(0);
	let viewH = $state(MAX_H);
	const open = $derived(rows.find((r) => r.type === "file" && r.open));

	/** Plain rows are windowed. An open diff makes the list short enough to just render (a diff is capped at 200 KB). */
	const windowed = $derived(rows.length > 60 && !open);
	const win = $derived(windowed ? windowRows(rows.length, ROW, top, viewH, 8) : { from: 0, to: rows.length, before: 0, after: 0 });
	const visible = $derived(rows.slice(win.from, win.to));
	const listH = $derived(Math.min(MAX_H, rows.reduce((h, r) => h + heightOf(r), 0) + (open ? DIFF_H : 0)));

	function onscroll(e: Event) {
		// one write per frame is plenty: the window only moves by whole rows
		top = (e.currentTarget as HTMLElement).scrollTop;
	}
	$effect(() => {
		// a new filter starts from the top: the scroll position of the old list means nothing in the new one
		void kind;
		void query;
		if (scroller) scroller.scrollTop = 0;
		top = 0;
	});
</script>

<div class="files">
	{#if total > SEARCH_FROM || query}
		<div class="tools">
			<SearchField label={t("파일 찾기")} bind:value={query} />
		</div>
	{/if}
	{#if kinds.length > 2}
		<div class="tabs" role="tablist" aria-label={t("변경 종류")}>
			{#each kinds as [k, label, n] (k)}
				<button role="tab" class="tab" class:on={kind === k} aria-selected={kind === k} onclick={() => (kind = k)}>
					{label}<span class="n">{compact(n)}</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if !shown.length}
		<EmptyState tone="plain" as="p">{query ? t("'{q}'와 일치하는 파일이 없습니다", { q: query }) : t("변경된 파일이 없습니다")}</EmptyState>
	{:else}
		<div class="scroll" bind:this={scroller} bind:clientHeight={viewH} {onscroll} style:height="{listH}px">
			<div style:height="{win.before}px"></div>
			{#each visible as r (r.key)}
				{#if r.type === "head"}
					<div class="ghead"><span class="gtitle">{r.title}</span><span class="count">{compact(r.n)}</span></div>
				{:else if r.type === "file"}
					{@const n = lineCounts(r.f)}
					<button class="file" class:on={r.open} onclick={() => onpick(r.f)} title={r.f.from ? `${r.f.from} → ${r.f.path}` : r.f.path}>
						<span class="code" data-state={r.f.state}>{r.f.code}</span>
						<span class="name">
							<span class="base">{baseOf(r.f.path)}</span>
							{#if dirOf(r.f.path)}<span class="dir">{dirOf(r.f.path)}</span>{/if}
						</span>
						{#if n}
							<span class="num mono"><span class="plus">+{compact(n.add)}</span><span class="minus">−{compact(n.del)}</span></span>
							<span class="bar" aria-hidden="true">{#each diffBar(n.add, n.del) as c, i (i)}<i data-c={c}></i>{/each}</span>
						{/if}
					</button>
					{#if r.open}<div class="difrow">{@render diff()}</div>{/if}
				{/if}
			{/each}
			<div style:height="{win.after}px"></div>
		</div>
	{/if}

	{#if searching}
		<p class="cut">{t("전체에서 찾는 중…")}</p>
	{:else if moreThanShown}
		<p class="cut">{t("{total}개 중 {n}개만 표시합니다", { total: (useRemote && remote ? matchedTotal : total).toLocaleString(), n: cap.toLocaleString() })}</p>
	{/if}
</div>

<style>
	.files {
		display: flex;
		flex-direction: column;
	}
	.tools {
		padding: 4px 16px 8px;
	}
	/* wraps instead of scrolling sideways: a tab off the edge is a tab nobody finds */
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 0 16px 8px;
	}
	.tab {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 24px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-dim);
	}
	.tab:hover {
		background: var(--bg-hover);
	}
	.tab.on {
		background: var(--bg-active);
		color: var(--text);
	}
	.tab .n {
		color: var(--text-faint);
	}
	.scroll {
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.ghead {
		display: flex;
		align-items: baseline;
		gap: 8px;
		height: 28px;
		padding: 8px 16px 0;
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.gtitle {
		font-weight: 600;
	}
	.count {
		color: var(--text-faint);
	}
	.file {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 32px;
		padding: 0 16px;
		text-align: left;
		color: var(--text);
	}
	.file:hover {
		background: var(--bg-hover);
	}
	.file.on {
		background: var(--bg-active);
	}
	.code {
		flex: none;
		width: 16px;
		text-align: center;
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 700;
		line-height: 20px;
		color: var(--text-dim);
	}
	.code[data-state="staged"] {
		color: var(--ok);
	}
	.code[data-state="untracked"] {
		color: var(--text-faint);
	}
	.code[data-state="conflict"] {
		color: var(--warn);
	}
	/* the file name first and bold enough to scan, its folder dim after it and the first to be cut */
	.name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 8px;
		overflow: hidden;
		white-space: nowrap;
	}
	.base {
		flex: none;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: var(--fs-sm);
		line-height: 20px;
	}
	.dir {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		direction: rtl; /* a long folder loses its start, the part nearest the file stays: …/deep/er */
		text-align: left;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.num {
		flex: none;
		display: flex;
		gap: 4px;
		font-size: var(--fs-2xs);
		line-height: 16px;
	}
	.plus {
		color: var(--ok);
	}
	.minus {
		color: var(--danger);
	}
	.bar {
		flex: none;
		display: flex;
		gap: 1px;
	}
	.bar i {
		width: 6px;
		height: 8px;
		border-radius: 1px;
		background: var(--border-strong);
	}
	.bar i[data-c="add"] {
		background: var(--ok);
	}
	.bar i[data-c="del"] {
		background: var(--danger);
	}
	.difrow {
		padding: 0 16px 12px;
	}
	.cut {
		margin: 8px 16px 0;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
</style>
