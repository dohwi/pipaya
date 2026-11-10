<script lang="ts">
	import Icon from "./Icon.svelte";
	import IconButton from "./IconButton.svelte";
	import Badge from "./Badge.svelte";
	import EmptyState from "./EmptyState.svelte";
	import { t } from "../lib/i18n";
	import { formatCombo } from "../lib/keys";
	import { app } from "../lib/store.svelte";
	import { gitPanel, refOf } from "../lib/git-panel.svelte";
	import { shortName } from "../lib/sidebar-model";
	import Select from "./Select.svelte";
	import { layoutGraph } from "../lib/git-graph";
	import { GIT_LIMITS } from "../lib/git-limits";
	import { agoParts, lineCounts, refChips, trackState } from "../lib/git-view";
	import type { GitFile } from "../lib/types";

	/**
	 * The right sidebar: what the working directory of the session on screen looks like in git, read-only.
	 * Branch and its ahead/behind, the changed files (staged / unstaged / untracked), the worktrees of the repository, and
	 * the diff of one file on click. Nothing here writes: no stage, no discard, no commit.
	 */
	const hint = $derived(app.prefs.bindings.toggleRightSidebar ? ` (${formatCombo(app.prefs.bindings.toggleRightSidebar)})` : "");
	const status = $derived(gitPanel.status);
	const files = $derived(status?.files ?? []);
	const staged = $derived(files.filter((f) => f.state === "staged"));
	const unstaged = $derived(files.filter((f) => f.state === "unstaged" || f.state === "conflict"));
	const untracked = $derived(files.filter((f) => f.state === "untracked"));
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
	const branches = $derived(status?.branches ?? []);
	/** The picker: every branch, then each one (remote-tracking ones marked), the hint saying where it stands. */
	const branchOptions = $derived.by(() => {
		const opts: { value: string; label: string; hint?: string; disabled?: boolean }[] = [{ value: "", label: t("모든 브랜치") }];
		for (const b of branches) {
			const st = trackState(b);
			const hint = [b.current ? t("현재") : "", st === "ahead" || st === "diverged" ? `↑${b.ahead}` : "", st === "behind" || st === "diverged" ? `↓${b.behind}` : "", st === "gone" ? t("삭제됨") : "", b.elsewhere ? t("워크트리") : "", ago(b.at)].filter(Boolean).join(" ");
			opts.push({ value: refOf(b), label: b.name, hint });
		}
		if (status?.branchesCut) opts.push({ value: "\0cut", label: t("브랜치가 많아 {n}개만 표시합니다", { n: GIT_LIMITS.branches }), disabled: true });
		return opts;
	});
	/** The changed files fold into one row: the graph is the page, the working tree is a glance. */
	let filesOpen = $state(false);
	let treesOpen = $state(false);
	const totals = $derived.by(() => {
		let add = 0;
		let del = 0;
		for (const f of files) {
			add += f.add ?? 0;
			del += f.del ?? 0;
		}
		return { add, del };
	});
	const pick = (f: GitFile) => void gitPanel.pick({ path: f.path, staged: f.state === "staged" });
	const pickInCommit = (hash: string, path: string) => void gitPanel.pick({ path, staged: false, commit: hash });

	/** The diff's lines, with the file header lines dropped: the panel already says which file it is. */
	const lines = $derived.by(() => {
		const patch = gitPanel.diff?.patch ?? "";
		return patch
			.split("\n")
			.filter((l) => !l.startsWith("diff --git ") && !l.startsWith("index ") && !l.startsWith("--- ") && !l.startsWith("+++ ") && !l.startsWith("new file mode ") && !l.startsWith("deleted file mode ") && !l.startsWith("similarity index ") && !l.startsWith("rename from ") && !l.startsWith("rename to "))
			.filter((l, i, all) => !(l === "" && i === all.length - 1));
	});
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
				<span class="name mono">{status.detached ? t("분리된 HEAD") : status.branch}</span>
				{#if status.ahead}<Badge tone="neutral" size="sm" mono>↑{status.ahead}</Badge>{/if}
				{#if status.behind}<Badge tone="neutral" size="sm" mono>↓{status.behind}</Badge>{/if}
				{#if status.stashes}<span class="flag" title={t("보관된 변경(stash)")}>{t("보관 {n}", { n: status.stashes })}</span>{/if}
			</div>
			{#if status.upstream}<div class="up mono">{status.upstream}</div>{/if}

			<div class="pickrow">
				<Select size="sm" mono label={t("브랜치")} value={gitPanel.logRef} options={branchOptions} onchange={(v) => gitPanel.selectRef(v)} />
			</div>

			<section class="fold" aria-label={t("변경된 파일")}>
				<button class="foldhead" aria-expanded={filesOpen} disabled={!files.length} onclick={() => (filesOpen = !filesOpen)}>
					<span class="chev" class:open={filesOpen} aria-hidden="true"><Icon name="chevron-down" /></span>
					<span class="gtitle">{t("변경된 파일")}</span>
					<span class="count">{files.length}{status.truncated ? "+" : ""}</span>
					{#if totals.add || totals.del}<span class="num mono"><span class="plus">+{totals.add}</span> <span class="minus">−{totals.del}</span></span>{/if}
				</button>
				{#if filesOpen && files.length}
					<div class="foldbody" style:max-height="{GIT_LIMITS.filesVisible * 33 + 56}px">
						{#each [{ title: t("스테이징됨"), list: staged }, { title: t("변경됨"), list: unstaged }, { title: t("추적 안 됨"), list: untracked }] as group (group.title)}
							{#if group.list.length}
								<div class="ghead"><span class="gtitle">{group.title}</span><span class="count">{group.list.length}</span></div>
								<ul>
									{#each group.list as f (f.state + f.path)}
										{@const open = gitPanel.picked?.path === f.path && gitPanel.picked.staged === (f.state === "staged") && !gitPanel.picked.commit}
										<li>
											<button class="file" class:on={open} onclick={() => pick(f)} title={f.from ? `${f.from} → ${f.path}` : f.path}>
												<span class="code" data-state={f.state}>{f.code}</span>
												<span class="path">{f.path}</span>
												{@render counts(f)}
											</button>
											{#if open}{@render diffView()}{/if}
										</li>
									{/each}
								</ul>
							{/if}
						{/each}
						{#if status.truncated}<p class="cut">{t("파일이 많아 {n}개만 표시합니다", { n: GIT_LIMITS.files })}</p>{/if}
					</div>
				{/if}
			</section>

			<section class="graphbox" aria-label={t("그래프")}>
				<div class="ghead"><span class="gtitle">{t("그래프")}</span><span class="count">{graph.rows.length}{gitPanel.more ? "+" : ""}</span></div>
				<div class="graphscroll">
					{#if gitPanel.logError}
						<EmptyState tone="plain" as="p">{gitPanel.logError}</EmptyState>
					{:else if !graph.rows.length}
						<EmptyState tone="plain" as="p" loading={gitPanel.logLoading}>{t("커밋이 없습니다")}</EmptyState>
					{:else}
						<ul>
							{#each graph.rows as r (r.commit.hash)}
								{@const opened = gitPanel.openCommit === r.commit.hash}
								<li class="commit-wrap">
									<button class="commit" class:on={opened} aria-expanded={opened} onclick={() => void gitPanel.toggleCommit(r.commit.hash)} title={`${r.commit.hash.slice(0, 8)} · ${r.commit.author} · ${when(r.commit.at)}\n${r.commit.subject}`}>
										<svg class="lanes" width={gw} height={ROW} viewBox={`0 0 ${gw} ${ROW}`} aria-hidden="true">
											{#each r.segs as s, i (i)}
												<line x1={s.x1 * LANE + LANE / 2} y1={s.y1 * ROW} x2={s.x2 * LANE + LANE / 2} y2={s.y2 * ROW} stroke={PALETTE[s.color]} stroke-width="1.5" />
											{/each}
											<circle cx={r.col * LANE + LANE / 2} cy={ROW / 2} r="4" fill={PALETTE[r.color]} stroke="var(--bg-side)" stroke-width="1.5" />
										</svg>
										<span class="subject">{r.commit.subject}</span>
										{#each refChips(r.commit.refs).slice(0, 2) as chip (chip.label)}
											<span class="ref mono" data-kind={chip.kind}>{chip.label}</span>
										{/each}
										<span class="when">{ago(r.commit.at)}</span>
									</button>
									{#if opened}
										<div class="detail">
											{#if gitPanel.commitLoading}
												<EmptyState tone="plain" as="p" loading />
											{:else if gitPanel.commitError}
												<EmptyState tone="plain" as="p">{gitPanel.commitError}</EmptyState>
											{:else if gitPanel.commit}
												<p class="meta mono">{gitPanel.commit.hash.slice(0, 8)} · {gitPanel.commit.author} · {when(gitPanel.commit.at)}</p>
												{#if gitPanel.commit.parents.length > 1}<p class="meta">{t("병합 커밋: 첫 부모와 비교한 변경입니다")}</p>{/if}
												{#if gitPanel.commit.body}<p class="msg">{gitPanel.commit.body}</p>{/if}
												{#if !gitPanel.commit.files.length}
													<p class="meta">{t("변경된 파일이 없습니다")}</p>
												{:else}
													<ul class="cfiles">
														{#each gitPanel.commit.files as f (f.path)}
															{@const openFile = gitPanel.picked?.commit === r.commit.hash && gitPanel.picked.path === f.path}
															<li>
																<button class="file" class:on={openFile} onclick={() => pickInCommit(r.commit.hash, f.path)} title={f.from ? `${f.from} → ${f.path}` : f.path}>
																	<span class="code" data-state={f.code === "A" ? "staged" : f.code === "D" ? "conflict" : undefined}>{f.code}</span>
																	<span class="path">{f.path}</span>
																	{@render counts(f)}
																</button>
																{#if openFile}{@render diffView()}{/if}
															</li>
														{/each}
													</ul>
													{#if gitPanel.commit.truncated}<p class="cut">{t("파일이 많아 {n}개만 표시합니다", { n: GIT_LIMITS.commitFiles })}</p>{/if}
												{/if}
											{/if}
										</div>
									{/if}
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
						<div class="foldbody" style:max-height="{4 * 33}px">
							<ul>
								{#each status.worktrees as w (w.path)}
									<li class="tree" class:here={w.path === status.root} aria-current={w.path === status.root ? "true" : undefined}>
										<span class="glyph" aria-hidden="true"><Icon name="folder" /></span>
										<span class="path">{shortName(w.path, app.workspace?.home)}</span>
										<span class="wbranch mono">{w.branch ?? t("분리됨")}</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				</section>
			{/if}
		{/if}
	</div>
</aside>

{#snippet counts(f: { add?: number; del?: number })}
	{@const n = lineCounts(f)}
	{#if n}<span class="num mono"><span class="plus">+{n.add}</span> <span class="minus">−{n.del}</span></span>{/if}
{/snippet}

{#snippet diffView()}
	<div class="diff">
		{#if gitPanel.diffLoading}
			<EmptyState tone="plain" as="p" loading />
		{:else if gitPanel.diffError}
			<EmptyState tone="plain" as="p">{gitPanel.diffError}</EmptyState>
		{:else if gitPanel.diff?.binary}
			<EmptyState tone="plain" as="p">{t("바이너리 파일이라 미리 볼 수 없습니다")}</EmptyState>
		{:else if !lines.length}
			<EmptyState tone="plain" as="p">{t("표시할 변경 내용이 없습니다")}</EmptyState>
		{:else}
			<pre class="patch"><code>{#each lines as line, i (i)}<span class:add={line.startsWith("+")} class:del={line.startsWith("-")} class:hunk={line.startsWith("@@")}>{line}
</span>{/each}</code></pre>
			{#if gitPanel.diff?.truncated}<p class="cut">{t("변경 내용이 길어 앞부분만 표시합니다")}</p>{/if}
		{/if}
	</div>
{/snippet}

<style>
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
	/* both glyphs 16px so the two ends match (a 19px one beside a 16px one differ in weight) */
	.head :global(.iconbtn svg) {
		width: 16px;
		height: 16px;
	}
	/* the title and its folder: a 20px line over a 16px line = 36px in the 44px row, centred, whole pixels */
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
	/* A column: the picker and the folds take their own height, the graph takes the rest and scrolls inside itself */
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 12px 0 0;
		overflow-y: auto;
	}
	.pickrow {
		flex: none;
		margin-top: 8px;
		padding: 0 16px;
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
	.foldhead:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.foldhead:disabled .gtitle {
		color: var(--text-faint);
	}
	.foldhead .num {
		margin-left: auto;
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
	.foldbody {
		overflow-y: auto;
		padding-bottom: 8px;
	}
	.foldbody .ghead {
		margin-top: 8px;
	}
	.graphbox {
		flex: 1 0 240px; /* never squeezed below ~7 rows, even with the folds open: the body scrolls instead */
		min-height: 0;
		display: flex;
		flex-direction: column;
		margin-top: 8px;
		border-top: 1px solid var(--border);
	}
	.graphbox > .ghead {
		flex: none;
		height: 32px;
		align-items: center;
	}
	.graphscroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-bottom: 16px;
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
	.group {
		display: flex;
		flex-direction: column;
		gap: 1px; /* a hairline between the rows of one group, as every list in the app */
		margin-top: 12px;
	}
	.ghead {
		display: flex;
		align-items: baseline;
		gap: 8px;
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
	ul {
		display: flex;
		flex-direction: column;
		gap: 1px; /* the 1px between rows of one list */
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.file {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 32px; /* the app's row height */
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
	.path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px;
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
	.tree .path {
		font-size: var(--fs-sm);
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
	.commit.on {
		background: var(--bg-active);
	}
	.when {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.detail {
		padding: 8px 16px 12px;
	}
	.detail .meta {
		margin: 0 0 4px;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.detail .msg {
		margin: 0 0 8px;
		font-size: var(--fs-xs);
		line-height: 20px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--text-dim);
	}
	.cfiles {
		margin: 0 -16px; /* the file rows run edge to edge like the changed-file rows above */
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
	.flag {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.flag.warn {
		color: var(--warn);
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
	.lanes {
		flex: none;
		display: block;
		overflow: hidden;
	}
	.subject {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text);
	}
	.ref {
		flex: none;
		max-width: 40%;
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
	.diff {
		padding: 0 16px 12px;
	}
	.patch {
		margin: 0;
		max-height: 320px;
		overflow: auto;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		background: var(--bg-code);
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		line-height: 16px;
		white-space: pre;
	}
	.patch .add {
		color: var(--ok);
	}
	.patch .del {
		color: var(--danger);
	}
	.patch .hunk {
		color: var(--text-faint);
	}
	.cut {
		margin: 8px 16px 0;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
</style>
