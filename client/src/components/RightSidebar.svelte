<script lang="ts">
	import Icon from "./Icon.svelte";
	import IconButton from "./IconButton.svelte";
	import Badge from "./Badge.svelte";
	import EmptyState from "./EmptyState.svelte";
	import Select from "./Select.svelte";
	import { t } from "../lib/i18n";
	import { formatCombo } from "../lib/keys";
	import { app } from "../lib/store.svelte";
	import { gitPanel, refOf } from "../lib/git-panel.svelte";
	import { shortName } from "../lib/sidebar-model";
	import { layoutGraph } from "../lib/git-graph";
	import { GIT_LIMITS } from "../lib/git-limits";
	import { agoParts, chipsFor, compact, lineShare, summarize, trackState } from "../lib/git-view";

	/**
	 * The right sidebar: what the working directory of the session on screen looks like in git, read-only and at a glance.
	 * Which branch and how far it is from its remote, how much changed (counts and lines, not a file list: a repository
	 * with 80,000 changed files costs the same as one with two), the worktrees, and the history graph, which is the page.
	 * Nothing here writes: no stage, no discard, no commit.
	 */
	const hint = $derived(app.prefs.bindings.toggleRightSidebar ? ` (${formatCombo(app.prefs.bindings.toggleRightSidebar)})` : "");
	const status = $derived(gitPanel.status);
	const summary = $derived(summarize(status?.counts ?? null));
	const share = $derived(status?.lines ? lineShare(status.lines.add, status.lines.del) : null);
	/** The folder the panel is about, as the header shows it ("work/app"). */
	const folder = $derived.by(() => {
		const cwd = app.current?.cwd;
		return cwd ? shortName(cwd, app.workspace?.home) : "";
	});
	const reason = $derived.by(() => {
		switch (status?.reason) {
			case "not-a-repo":
				return t("이 폴더는 git 저장소가 아닙니다");
			case "no-git":
				return t("서버에서 git을 실행할 수 없습니다");
			case "missing":
				return t("작업 폴더를 찾을 수 없습니다");
			default:
				return "";
		}
	});
	/** Lane width and row height of the history graph, in px (the row is the app's 32px). */
	const LANE = 12;
	const ROW = 32;
	const PALETTE = ["var(--info)", "var(--ok)", "var(--warn)", "var(--danger)", "var(--text-dim)"];
	const graph = $derived(layoutGraph(gitPanel.commits, PALETTE.length));
	/** The lanes drawn: a repository with dozens of branches would push the subjects off the panel, so the rest is clipped. */
	const gw = $derived(Math.min(graph.lanes, 8) * LANE);
	const when = (at: number) => new Date(at * 1000).toLocaleString();
	/** "3h ago": the clock is read once a minute, which is as fresh as the words are. */
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});
	const ago = (at: number) => {
		const { unit, n } = agoParts(at, now);
		if (unit === "s") return t("{n}초 전", { n });
		if (unit === "m") return t("{n}분 전", { n });
		if (unit === "h") return t("{n}시간 전", { n });
		if (unit === "d") return t("{n}일 전", { n });
		if (unit === "mo") return t("{n}달 전", { n });
		return t("{n}년 전", { n });
	};
	const kindLabel = (kind: "conflict" | "staged" | "unstaged" | "untracked") => {
		if (kind === "conflict") return t("충돌");
		if (kind === "staged") return t("스테이징됨");
		if (kind === "unstaged") return t("변경됨");
		return t("추적 안 됨");
	};
	/** The picker: every branch, then each one (remote-tracking ones marked), the hint saying where it stands. */
	const branchOptions = $derived.by(() => {
		const opts: { value: string; label: string; hint?: string; disabled?: boolean }[] = [{ value: "", label: t("모든 브랜치") }];
		for (const b of status?.branches ?? []) {
			const st = trackState(b);
			const hint = [b.current ? t("현재") : "", st === "ahead" || st === "diverged" ? `↑${b.ahead}` : "", st === "behind" || st === "diverged" ? `↓${b.behind}` : "", st === "gone" ? t("삭제됨") : "", b.elsewhere ? t("워크트리") : "", ago(b.at)].filter(Boolean).join(" ");
			opts.push({ value: refOf(b), label: b.name, hint });
		}
		if (status?.branchesCut) opts.push({ value: "\0cut", label: t("브랜치가 많아 {n}개만 표시합니다", { n: GIT_LIMITS.branches }), disabled: true });
		return opts;
	});
	let treesOpen = $state(false);
</script>

<aside class="right" id="right-sidebar" data-part="right-sidebar" aria-label={t("우측 사이드바")}>
	<!-- The toggle at the left edge, the refresh at the right edge, the title and its folder between them (a second, quiet
	     line like the main header's). Focus and reading order: toggle, refresh, then the body. -->
	<div class="head">
		<IconButton icon="sidebar-right" label={t("우측 사이드바 닫기")} title={t("우측 사이드바 닫기") + hint} class="toggle tap" aria-expanded={true} aria-controls="right-sidebar" onclick={() => app.right.toggle()} />
		<div class="titles">
			<span class="title">{t("변경 사항")}</span>
			{#if folder}<span class="folder mono" title={app.current?.cwd}>{folder}</span>{/if}
		</div>
		<IconButton icon="retry" size="sm" label={t("새로 고침")} tip class="refresh tap" disabled={gitPanel.loading} onclick={() => void gitPanel.load()} />
	</div>

	<div class="body">
		{#if gitPanel.error}
			<EmptyState tone="plain">
				{#if gitPanel.error.kind === "old-server"}{t("서버를 업데이트해야 Git 정보를 볼 수 있어요 (서버 재시작이 필요합니다)")}
				{:else if gitPanel.error.kind === "gone"}{t("이 대화를 서버에서 찾을 수 없습니다")}
				{:else}{gitPanel.error.message}{/if}
			</EmptyState>
		{:else if !app.readableId}
			<!-- a terminal, or nothing open: there is no working directory to read -->
			<EmptyState tone="plain">{t("대화를 열면 그 작업 폴더의 변경 사항을 보여 줍니다")}</EmptyState>
		{:else if !status}
			<EmptyState tone="plain" loading={gitPanel.loading} />
		{:else if !status.repo}
			<EmptyState tone="plain">{reason}</EmptyState>
		{:else}
			<div class="branch">
				<span class="glyph" aria-hidden="true"><Icon name="fork" /></span>
				<span class="name mono">{status.detached ? t("분리된 HEAD") : (status.branch ?? t("브랜치 없음"))}</span>
				{#if status.ahead}<Badge tone="neutral" size="sm" mono>↑{status.ahead}</Badge>{/if}
				{#if status.behind}<Badge tone="neutral" size="sm" mono>↓{status.behind}</Badge>{/if}
				{#if status.stashes}<span class="flag" title={t("보관된 변경(stash)")}>{t("보관 {n}", { n: status.stashes })}</span>{/if}
			</div>
			{#if status.upstream}<div class="up mono">{status.upstream}</div>{/if}

			<!-- The working tree in one block: the lines first and big (green added, red removed), the bar of their split, then
			     how many files and of which kind. A number, never a list. -->
			<div class="summary" aria-label={t("변경 요약")}>
				{#if !summary}
					<span class="muted">{t("변경 사항이 너무 많아 세지 못했습니다")}</span>
				{:else if !summary.total}
					<span class="muted">{t("변경된 파일이 없습니다")}</span>
				{:else}
					<div class="line">
						{#if status.lines}
							<span class="big mono" title={t("추가된 줄 {add}, 삭제된 줄 {del}", { add: status.lines.add.toLocaleString(), del: status.lines.del.toLocaleString() })}>
								<span class="plus">+{compact(status.lines.add)}</span><span class="minus">−{compact(status.lines.del)}</span>
							</span>
						{:else}
							<span class="muted" title={t("변경이 많아 줄 수는 세지 않습니다")}>{t("줄 수 생략")}</span>
						{/if}
						<span class="files">{t("파일 {n}개", { n: summary.total.toLocaleString() })}</span>
					</div>
					{#if share}
						<div class="split" role="img" aria-label={t("추가 {a}% 삭제 {d}%", { a: share.add, d: share.del })}>
							{#if share.add}<i class="add" style:width="{share.add}%"></i>{/if}
							{#if share.del}<i class="del" style:width="{share.del}%"></i>{/if}
						</div>
					{/if}
					<div class="kinds">
						{#each summary.kinds as k (k.kind)}
							<span class="kind" data-kind={k.kind}><i aria-hidden="true"></i>{kindLabel(k.kind)} <b>{compact(k.n)}</b></span>
						{/each}
					</div>
				{/if}
			</div>

			<section class="graphbox" aria-label={t("그래프")}>
				<div class="ghead">
					<span class="gtitle">{t("그래프")}</span>
					<span class="count">{graph.rows.length}{gitPanel.more ? "+" : ""}</span>
					<span class="pick"><Select size="sm" mono width="100%" label={t("그래프에 보일 브랜치")} value={gitPanel.logRef} options={branchOptions} onchange={(v) => gitPanel.selectRef(v)} /></span>
				</div>
				<div class="graphscroll">
					{#if gitPanel.logError}
						<EmptyState tone="plain" as="p">{gitPanel.logError}</EmptyState>
					{:else if !graph.rows.length}
						<EmptyState tone="plain" as="p" loading={gitPanel.logLoading}>{t("커밋이 없습니다")}</EmptyState>
					{:else}
						<ul>
							{#each graph.rows as r (r.commit.hash)}
								{@const chips = chipsFor(r.commit.refs)}
								<li>
									<div class="commit" title={`${r.commit.hash.slice(0, 8)} · ${r.commit.author} · ${when(r.commit.at)}\n${r.commit.subject}`}>
										<svg class="lanes" width={gw} height={ROW} viewBox={`0 0 ${gw} ${ROW}`} aria-hidden="true">
											{#each r.segs as s, i (i)}
												<line x1={s.x1 * LANE + LANE / 2} y1={s.y1 * ROW} x2={s.x2 * LANE + LANE / 2} y2={s.y2 * ROW} stroke={PALETTE[s.color]} stroke-width="1.5" />
											{/each}
											<circle cx={r.col * LANE + LANE / 2} cy={ROW / 2} r="4" fill={PALETTE[r.color]} stroke="var(--bg-side)" stroke-width="1.5" />
										</svg>
										<span class="subject">{r.commit.subject}</span>
										{#if chips.shown}
											<span class="ref mono" data-kind={chips.shown.kind} title={chips.all}>{chips.shown.label}</span>
											{#if chips.more}<span class="more-refs mono" title={chips.all}>+{chips.more}</span>{/if}
										{/if}
										<span class="when">{ago(r.commit.at)}</span>
									</div>
								</li>
							{/each}
						</ul>
						{#if gitPanel.more}
							{#if gitPanel.logLimit < GIT_LIMITS.commitsMax}
								<button class="more" disabled={gitPanel.logLoading} onclick={() => gitPanel.showMore()}>{t("커밋 {n}개 더 보기", { n: GIT_LIMITS.commitsPage })}</button>
							{:else}
								<p class="cut">{t("최근 {n}개까지만 표시합니다", { n: GIT_LIMITS.commitsMax })}</p>
							{/if}
						{/if}
					{/if}
				</div>
			</section>

			{#if status.worktrees.length > 1}
				<section class="fold" aria-label={t("워크트리")}>
					<button class="foldhead" aria-expanded={treesOpen} onclick={() => (treesOpen = !treesOpen)}>
						<span class="chev" class:open={treesOpen} aria-hidden="true"><Icon name="chevron-down" /></span>
						<span class="gtitle">{t("워크트리")}</span>
						<span class="count">{status.worktrees.length}</span>
					</button>
					{#if treesOpen}
						<ul class="foldbody">
							{#each status.worktrees as w (w.path)}
								<li class="tree" class:here={w.path === status.root} aria-current={w.path === status.root ? "true" : undefined}>
									<span class="glyph" aria-hidden="true"><Icon name="folder" /></span>
									<span class="path">{shortName(w.path, app.workspace?.home)}</span>
									<span class="wbranch mono">{w.branch ?? t("분리됨")}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}
		{/if}
	</div>
</aside>

<style>
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 12px 0 0;
		overflow-y: auto;
	}
	/* the working tree's changes in one card: the lines are the answer, so they are the biggest thing in it */
	.summary {
		flex: none;
		margin: 8px 16px 0;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		line-height: 20px;
	}
	.summary .muted {
		color: var(--text-faint);
		font-size: var(--fs-xs);
	}
	.summary .line {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.summary .big {
		display: flex;
		gap: 8px;
		font-size: var(--fs-lg);
		font-weight: 600;
		line-height: 24px;
	}
	.summary .files {
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	/* one bar for the split of added against removed lines: green then red, always filling the width */
	.split {
		display: flex;
		gap: 2px;
		height: 8px; /* a bar, not a rule: 8px reads at a glance */
		margin-top: 8px;
		border-radius: 4px;
		overflow: hidden;
	}
	.split i {
		display: block;
		height: 100%;
		min-width: 4px;
	}
	.split .add {
		background: var(--ok);
	}
	.split .del {
		background: var(--danger);
	}
	.kinds {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		margin-top: 8px;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.kind {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.kind i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
	}
	.kind[data-kind="staged"] i {
		background: var(--ok);
	}
	.kind[data-kind="unstaged"] i {
		background: var(--warn);
	}
	.kind[data-kind="conflict"] i {
		background: var(--danger);
	}
	.kind b {
		font-weight: 600;
		color: var(--text-dim);
	}
	.pick {
		flex: 1;
		min-width: 0;
		margin-left: auto;
		max-width: 180px;
	}
	.fold {
		flex: none;
		margin-top: 8px;
		border-top: 1px solid var(--border);
	}
	.foldhead {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 32px;
		padding: 0 16px;
		text-align: left;
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.foldhead:hover {
		background: var(--bg-hover);
	}
	.foldbody {
		margin: 0;
		padding: 0 0 8px;
		list-style: none;
		max-height: 132px;
		overflow-y: auto;
	}
	.graphbox {
		flex: 1 0 240px; /* never squeezed below ~7 rows: the body scrolls instead */
		min-height: 0;
		display: flex;
		flex-direction: column;
		margin-top: 8px;
		border-top: 1px solid var(--border);
	}
	.ghead {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 44px; /* the 34px picker plus 5px above and below */
		padding: 0 16px;
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.gtitle {
		font-weight: 600;
		color: var(--text);
	}
	.count {
		color: var(--text-faint);
	}
	.graphscroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-bottom: 16px;
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 1px; /* the 1px between rows of one list */
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px;
	}
	.right {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--bg-side);
		border-left: 1px solid var(--border);
	}
	.head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0;
		/* the same box as the main header (44px + its 1px hairline), so the two lines meet across the panel's edge */
		box-sizing: content-box;
		height: 44px;
		/* Columns are centres from the panel's left edge, 20px apart like the left sidebar's. Left: the toggle on 25 (the
		   branch glyph's and the file codes' column below), in a 20px box with no margin, so the row starts 14px in.
		   Right: the refresh in the same 20px box ending 16px from the window, the row's right line (like the sidebar's
		   `+` / `⋯` / ↺ column). The titles sit between them. */
		padding: 0 16px 0 14px;
		border-bottom: 1px solid var(--border);
	}
	.head :global(.iconbtn) {
		width: 20px;
		height: 20px;
		flex: none;
	}
	.head :global(.iconbtn svg) {
		width: 16px;
		height: 16px;
	}
	.titles {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
		margin: 0 12px; /* 12px of air from each icon, so a finger on one never lands on the other */
	}
	.title {
		font-size: var(--fs-md);
		font-weight: 600;
		line-height: 20px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.folder {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.branch {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 16px;
		line-height: 20px;
	}
	.branch .glyph {
		display: grid;
		place-items: center;
		color: var(--text-dim);
	}
	.branch .glyph :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
	}
	.branch .name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		font-weight: 600;
	}
	.up {
		padding: 0 16px 0 40px; /* the branch name's line: the glyph column plus its 8px */
		font-size: var(--fs-2xs);
		line-height: 20px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tree {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 16px;
		color: var(--text-dim);
	}
	.tree.here {
		color: var(--text);
	}
	.tree.here .path {
		font-weight: 600;
	}
	.tree .glyph {
		display: grid;
		place-items: center;
		flex: none;
	}
	.tree .glyph :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
	}
	.wbranch {
		flex: none;
		max-width: 40%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
	}
	.commit {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 32px;
		padding: 0 16px;
		text-align: left;
		color: var(--text-dim);
	}
	.commit:hover {
		background: var(--bg-hover);
	}
	.lanes {
		flex: none;
		display: block;
		overflow: hidden;
	}
	.subject {
		flex: 1 0 40%;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text);
	}
	.more-refs {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	/* a chip is a label, not a second title: it gives way before the subject does (the subject keeps at least ~60%) */
	.ref {
		flex: 0 1 auto;
		min-width: 0;
		max-width: 96px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0 4px;
		border-radius: var(--radius-sm);
		background: var(--bg-hover);
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.ref[data-kind="head"] {
		background: var(--info-soft);
		color: var(--info);
	}
	.ref[data-kind="tag"] {
		color: var(--warn);
	}
	.when {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.flag {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.more {
		width: 100%;
		height: 32px;
		padding: 0 16px;
		text-align: left;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
	}
	.more:disabled {
		opacity: 0.5;
	}
	.more:hover:not(:disabled) {
		color: var(--text);
		background: var(--bg-hover);
	}
	.num {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
	}
	.plus {
		color: var(--ok);
	}
	.minus {
		color: var(--danger);
	}
	.chev {
		display: grid;
		place-items: center;
		flex: none;
		color: var(--text-faint);
		transform: rotate(-90deg);
		transition: transform var(--motion-fast) var(--ease-std);
	}
	.chev.open {
		transform: none;
	}
	.chev :global(svg) {
		width: 16px;
		height: 16px;
	}
	.cut {
		margin: 8px 16px 0;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
</style>
