<script lang="ts">
	import Icon from "./Icon.svelte";
	import IconButton from "./IconButton.svelte";
	import Badge from "./Badge.svelte";
	import EmptyState from "./EmptyState.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { gitPanel } from "../lib/git-panel.svelte";
	import { shortName } from "../lib/sidebar-model";
	import type { GitFile } from "../lib/types";

	/**
	 * The right sidebar: what the working directory of the session on screen looks like in git, read-only.
	 * Branch and its ahead/behind, the changed files (staged / unstaged / untracked), the worktrees of the repository, and
	 * the diff of one file on click. Nothing here writes: no stage, no discard, no commit.
	 */
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
	const pick = (f: GitFile) => void gitPanel.pick({ path: f.path, staged: f.state === "staged" });

	/** The diff's lines, with the file header lines dropped: the panel already says which file it is. */
	const lines = $derived.by(() => {
		const patch = gitPanel.diff?.patch ?? "";
		return patch
			.split("\n")
			.filter((l) => !l.startsWith("diff --git ") && !l.startsWith("index ") && !l.startsWith("--- ") && !l.startsWith("+++ ") && !l.startsWith("new file mode ") && !l.startsWith("deleted file mode ") && !l.startsWith("similarity index ") && !l.startsWith("rename from ") && !l.startsWith("rename to "))
			.filter((l, i, all) => !(l === "" && i === all.length - 1));
	});
</script>

<aside class="right" data-part="right-sidebar" aria-label={t("우측 사이드바")}>
	<div class="head">
		<span class="title">{t("변경 사항")}</span>
		{#if folder}<span class="folder mono" title={app.current?.cwd}>{folder}</span>{/if}
		<IconButton
			icon="retry"
			size="sm"
			label={t("새로 고침")}
			tip
			class="refresh"
			disabled={gitPanel.loading}
			onclick={() => void gitPanel.load()}
		/>
		<IconButton icon="x" size="sm" label={t("우측 사이드바 닫기")} tip onclick={() => app.right.toggle()} />
	</div>

	<div class="body">
		{#if gitPanel.error}
			<EmptyState tone="plain">{gitPanel.error}</EmptyState>
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
			</div>
			{#if status.upstream}<div class="up mono">{status.upstream}</div>{/if}

			{#if !files.length}
				<EmptyState tone="plain">{t("변경된 파일이 없습니다")}</EmptyState>
			{:else}
				{#each [{ title: t("스테이징됨"), list: staged }, { title: t("변경됨"), list: unstaged }, { title: t("추적 안 됨"), list: untracked }] as group (group.title)}
					{#if group.list.length}
						<section class="group" aria-label={group.title}>
							<div class="ghead"><span class="gtitle">{group.title}</span><span class="count">{group.list.length}</span></div>
							<ul>
								{#each group.list as f (f.state + f.path)}
									{@const open = gitPanel.picked?.path === f.path && gitPanel.picked.staged === (f.state === "staged")}
									<li>
										<button class="file" class:on={open} onclick={() => pick(f)} title={f.from ? `${f.from} → ${f.path}` : f.path}>
											<span class="code" data-state={f.state}>{f.code}</span>
											<span class="path">{f.path}</span>
										</button>
										{#if open}
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
										{/if}
									</li>
								{/each}
							</ul>
						</section>
					{/if}
				{/each}
				{#if status.truncated}<p class="cut">{t("파일이 많아 일부만 표시합니다")}</p>{/if}
			{/if}

			{#if status.worktrees.length > 1}
				<section class="group" aria-label={t("워크트리")}>
					<div class="ghead"><span class="gtitle">{t("워크트리")}</span><span class="count">{status.worktrees.length}</span></div>
					<ul>
						{#each status.worktrees as w (w.path)}
							<li class="tree" class:here={w.path === status.root} aria-current={w.path === status.root ? "true" : undefined}>
								<span class="glyph" aria-hidden="true"><Icon name="folder" /></span>
								<span class="path">{shortName(w.path, app.workspace?.home)}</span>
								<span class="wbranch mono">{w.branch ?? t("분리됨")}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{/if}
	</div>
</aside>

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
		gap: 8px;
		height: 45px; /* the header's bar (44 + its hairline): the two tops read as one line */
		padding: 0 16px;
		border-bottom: 1px solid var(--border);
	}
	.title {
		flex: none;
		font-size: var(--fs-md);
		font-weight: 600;
		line-height: 20px;
	}
	.folder {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		line-height: 20px;
		color: var(--text-faint);
	}
	/* the two buttons sit on the panel's right line: a 32px button holds a 16px glyph 8px in */
	.head :global(.refresh) {
		margin-left: auto;
	}
	.head :global(.iconbtn:last-child) {
		margin-right: -8px; /* the close glyph on the panel's 16px right line: a 32px button holds a 16px glyph 8px in */
	}
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 12px 0 16px;
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
