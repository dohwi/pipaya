<script lang="ts">
	import { t } from "../../lib/i18n";
	import { workDir } from "../../lib/nav";
	import { app } from "../../lib/store.svelte";
	import { workspaceViewer, type WorkspaceEntry } from "../../lib/workspace-viewer.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import Icon from "../ui/Icon.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Notice from "../ui/Notice.svelte";
	import Segmented from "../ui/Segmented.svelte";

	const session = $derived(app.current);
	const sessionId = $derived(session?.id ?? workspaceViewer.sessionId);
	const folderName = $derived(
		workspaceViewer.workDir.split(/[\\/]/).filter(Boolean).pop() ??
			(session ? workDir(session).split(/[\\/]/).filter(Boolean).pop() ?? workDir(session) : ""),
	);

	// Resizable desktop sidebar width (200..420px).
	let panelWidth = $state(260);
	let dragging = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	const filterOptions = $derived([
		{ id: "all", label: t("전체") },
		{
			id: "changed",
			label: workspaceViewer.changes.length > 0 ? t("변경됨 ({n})", { n: workspaceViewer.changes.length }) : t("변경됨"),
		},
	]);

	// Refresh tree when drawer opens or bound session changes.
	$effect(() => {
		if (!app.filesOpen || !sessionId) return;
		void workspaceViewer.refreshTree({ preserveOpenDirs: true });
	});

	function onSearchInput(e: Event) {
		const val = (e.currentTarget as HTMLInputElement).value;
		workspaceViewer.search = val;
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			searchTimer = null;
			void workspaceViewer.runSearch(val);
		}, 160);
	}

	async function pickFile(path: string, mode?: "file" | "diff") {
		await workspaceViewer.openFile(path, mode);
		// On narrow screens, close the drawer right away so the opened file tab takes focus cleanly.
		if (typeof window !== "undefined" && window.innerWidth <= 900) {
			app.filesOpen = false;
		}
	}

	function startResize(e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		dragging = true;
		const startX = e.clientX;
		const startW = panelWidth;
		const onMove = (ev: PointerEvent) => {
			const next = startW + (startX - ev.clientX);
			panelWidth = Math.max(200, Math.min(420, Math.round(next)));
		};
		const onUp = () => {
			dragging = false;
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	function statusClass(status: string): string {
		if (status === "A" || status === "?") return "st-add";
		if (status === "D" || status === "U") return "st-del";
		return "st-mod";
	}
</script>

{#snippet treeNodes(entries: WorkspaceEntry[], depth: number)}
	{#each entries as entry (entry.path)}
		{@const ch = !entry.dir ? workspaceViewer.changeFor(entry.path) : undefined}
		{@const recent = !entry.dir && workspaceViewer.isRecent(entry.path)}
		{@const dirDirty = entry.dir && workspaceViewer.dirHasChanges(entry.path)}
		{#if entry.dir}
			{@const isOpen = !!workspaceViewer.expandedDirs[entry.path]}
			<button
				type="button"
				class="trow dir"
				style:padding-left="{8 + depth * 12}px"
				onclick={() => workspaceViewer.toggleDir(entry.path)}
				title={entry.path}
			>
				<span class="chev" class:open={isOpen}><Icon name="chevron-right" /></span>
				<span class="fico"><Icon name="folder" /></span>
				<span class="tname">{entry.name}</span>
				{#if dirDirty}<span class="dot" aria-label={t("변경 있음")}></span>{/if}
			</button>
			{#if isOpen}
				{@render treeNodes(workspaceViewer.dirEntries[entry.path] ?? [], depth + 1)}
			{/if}
		{:else}
			<button
				type="button"
				class="trow file"
				class:on={workspaceViewer.activeFile === entry.path}
				class:opened={workspaceViewer.openFiles.includes(entry.path) && workspaceViewer.activeFile !== entry.path}
				class:recent
				style:padding-left="{20 + depth * 12}px"
				onclick={() => pickFile(entry.path)}
				title={entry.path}
			>
				<span class="fico"><Icon name="file" /></span>
				<span class="tname">{entry.name}</span>
				{#if ch}
					<span class="st mono {statusClass(ch.status)}">{ch.status}</span>
				{/if}
			</button>
		{/if}
	{/each}
{/snippet}

<aside
	class="ftree"
	class:dragging
	data-part="workspace-tree"
	style:--wv-w="{panelWidth}px"
	aria-label={t("파일 뷰어")}
>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div class="grip" role="separator" aria-orientation="vertical" aria-label={t("파일 뷰어 너비 조절")} onpointerdown={startResize}></div>

	<header class="head">
		<div class="htitle" title={workspaceViewer.workDir}>
			{#if workspaceViewer.branch}
				<span class="hbranch mono" title="{folderName} · {workspaceViewer.branch}">{workspaceViewer.branch}</span>
			{:else}
				<span class="hname mono">{folderName || t("파일 뷰어")}</span>
			{/if}
		</div>
		<div class="hact">
			<IconButton icon="retry" size="sm" label={t("새로고침")} onclick={() => workspaceViewer.refreshTree({ preserveOpenDirs: true })} />
			<IconButton icon="x" size="sm" label={t("닫기")} onclick={() => (app.filesOpen = false)} />
		</div>
	</header>

	{#if !sessionId}
		<div class="pad">
			<EmptyState>{t("대화를 열면 현재 작업 폴더의 파일과 실시간 변경 내역을 볼 수 있습니다.")}</EmptyState>
		</div>
	{:else}
		<div class="tctrl">
			<Segmented
				label={t("파일 필터")}
				options={filterOptions}
				value={workspaceViewer.filter}
				size="sm"
				onchange={(id) => (workspaceViewer.filter = id as "all" | "changed")}
			/>
			<input
				class="search"
				type="search"
				value={workspaceViewer.search}
				oninput={onSearchInput}
				placeholder={t("파일 검색…")}
				aria-label={t("파일 검색")}
			/>
		</div>

		<div class="tlist">
			{#if workspaceViewer.treeError}
				<div class="pad-sm">
					<Notice tone="danger" size="sm" onretry={() => workspaceViewer.refreshTree()}>{workspaceViewer.treeError}</Notice>
				</div>
			{:else if workspaceViewer.search.trim()}
				{#if workspaceViewer.searchEntries.length === 0}
					<div class="pad-sm"><EmptyState compact>{t("일치하는 파일이 없습니다.")}</EmptyState></div>
				{:else}
					{#each workspaceViewer.searchEntries as entry (entry.path)}
						{#if !entry.dir}
							{@const ch = workspaceViewer.changeFor(entry.path)}
							<button
								type="button"
								class="trow file search-row"
								class:on={workspaceViewer.activeFile === entry.path}
								class:opened={workspaceViewer.openFiles.includes(entry.path) && workspaceViewer.activeFile !== entry.path}
								class:recent={workspaceViewer.isRecent(entry.path)}
								onclick={() => pickFile(entry.path)}
								title={entry.path}
							>
								<span class="fico"><Icon name="file" /></span>
								<span class="tname mono">{entry.path}</span>
								{#if ch}<span class="st mono {statusClass(ch.status)}">{ch.status}</span>{/if}
							</button>
						{/if}
					{/each}
				{/if}
			{:else if workspaceViewer.filter === "changed"}
				{#if workspaceViewer.changes.length === 0}
					<div class="pad-sm">
						<EmptyState compact>{t("변경된 파일이 없습니다. 에이전트가 파일을 수정하면 실시간으로 표시됩니다.")}</EmptyState>
					</div>
				{:else}
					<div class="chhead">
						<span class="chcap">{t("방금 수정한 파일")}</span>
						<button type="button" class="chclr" onclick={() => workspaceViewer.clearChanges()}>{t("비우기")}</button>
					</div>
					{#each workspaceViewer.changes as ch (ch.path)}
						<button
							type="button"
							class="trow file changed-row"
							class:on={workspaceViewer.activeFile === ch.path}
							class:opened={workspaceViewer.openFiles.includes(ch.path) && workspaceViewer.activeFile !== ch.path}
							class:recent={workspaceViewer.isRecent(ch.path) || ch.pending}
							onclick={() => pickFile(ch.path, "diff")}
							title={ch.path}
						>
							<span class="st mono {statusClass(ch.status)}">{ch.status}</span>
							<span class="tname mono">{ch.path}</span>
							{#if ch.pending}
								<span class="pend">{t("수정 중")}</span>
							{:else}
								<span class="cstat mono">
									{#if ch.additions > 0}<span class="add">+{ch.additions}</span>{/if}
									{#if ch.deletions > 0}<span class="del">-{ch.deletions}</span>{/if}
								</span>
							{/if}
						</button>
					{/each}
				{/if}
			{:else if workspaceViewer.treeLoading && workspaceViewer.rootEntries.length === 0}
				<div class="pad-sm"><EmptyState loading compact>{t("파일 목록을 불러오는 중…")}</EmptyState></div>
			{:else if workspaceViewer.rootEntries.length === 0}
				<div class="pad-sm"><EmptyState compact>{t("표시할 파일이 없습니다.")}</EmptyState></div>
			{:else}
				{@render treeNodes(workspaceViewer.rootEntries, 0)}
			{/if}
		</div>
	{/if}
</aside>

<style>
	.ftree {
		position: relative;
		flex: 0 0 var(--wv-w, 260px);
		width: var(--wv-w, 260px);
		max-width: 45vw;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg-side);
		border-left: 1px solid var(--border);
	}
	.ftree.dragging {
		user-select: none;
	}
	.grip {
		position: absolute;
		top: 0;
		bottom: 0;
		left: -4px;
		width: 8px;
		cursor: col-resize;
		z-index: 2;
	}
	.head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 44px;
		padding: 0 8px 0 12px;
		background: var(--bg-side);
		border-bottom: 1px solid var(--border);
	}
	.htitle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		line-height: 20px;
	}
	.hname,
	.hbranch {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 20px;
	}
	.hbranch {
		color: var(--text-dim);
		font-weight: 500;
	}
	.hact {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}
	.tctrl {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px;
		border-bottom: 1px solid var(--border);
	}
	.search {
		width: 100%;
		height: 32px;
		padding: 0 8px;
		border-radius: var(--radius-xs);
		border: 1px solid var(--border-strong);
		background: var(--bg);
		color: var(--text);
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.tlist {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 4px 0;
	}
	.trow {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		border: 0;
		background: transparent;
		color: var(--text-dim);
		font-size: var(--fs-xs);
		line-height: 20px;
		text-align: left;
		cursor: pointer;
	}
	@media (hover: hover) {
		.trow:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.trow.on {
		background: var(--bg-active);
		color: var(--text);
	}
	.trow.opened {
		color: var(--text);
	}
	.trow.recent {
		background: var(--accent-soft);
		color: var(--text);
	}
	.changed-row,
	.search-row {
		padding-left: 8px;
		gap: 8px;
	}
	.chev {
		width: 12px;
		height: 12px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		color: var(--text-faint);
		transition: transform var(--motion-fast) var(--ease);
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.chev :global(svg) {
		width: 12px;
		height: 12px;
	}
	.fico {
		width: 14px;
		height: 14px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		color: var(--text-faint);
	}
	.fico :global(svg) {
		width: 14px;
		height: 14px;
	}
	.tname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 20px;
	}
	.dot {
		width: 6px; /* optical 6px indicator matching sidebar status dots */
		height: 6px; /* optical 6px indicator matching sidebar status dots */
		border-radius: var(--radius-pill);
		background: var(--accent);
		flex: none;
	}
	.st {
		font-size: var(--fs-2xs);
		font-weight: 600;
		flex: none;
		line-height: 16px;
	}
	.st-add {
		color: var(--ok);
	}
	.st-mod {
		color: var(--info);
	}
	.st-del {
		color: var(--danger);
	}
	.cstat {
		display: inline-flex;
		gap: 4px;
		font-size: var(--fs-2xs);
		flex: none;
		line-height: 16px;
	}
	.add {
		color: var(--ok);
	}
	.del {
		color: var(--danger);
	}
	.chhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 8px;
		line-height: 16px;
	}
	.chcap {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		line-height: 16px;
	}
	.chclr {
		border: 0;
		background: transparent;
		padding: 0 4px;
		font-size: var(--fs-2xs);
		color: var(--text-dim);
		cursor: pointer;
		line-height: 16px;
	}
	@media (hover: hover) {
		.chclr:hover {
			color: var(--text);
		}
	}
	.pend {
		font-size: var(--fs-2xs);
		color: var(--warn);
		flex: none;
		line-height: 16px;
	}
	.pad {
		padding: 16px;
	}
	.pad-sm {
		padding: 8px;
	}

	@media (max-width: 900px) {
		.ftree {
			position: fixed;
			top: 0;
			right: 0;
			bottom: 0;
			width: min(82vw, 300px);
			max-width: 100%;
			z-index: var(--z-dock);
		}
		.grip {
			display: none;
		}
	}
</style>
