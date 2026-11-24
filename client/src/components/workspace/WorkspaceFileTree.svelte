<script lang="ts">
	import { t } from "../../lib/i18n";
	import { workDir } from "../../lib/nav";
	import { app } from "../../lib/store.svelte";
	import { WORKSPACE_FILE_MIME } from "../../lib/workspace-edits";
	import { workspaceViewer, type WorkspaceEntry } from "../../lib/workspace-viewer.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import Icon from "../ui/Icon.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Notice from "../ui/Notice.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import FileIcon from "./FileIcon.svelte";

	let { open = false }: { open?: boolean } = $props();

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

	// Mobile right-drawer touch swipe-to-dismiss state (follows the finger 1:1, closes past 25% or on quick flick).
	let drawerEl = $state<HTMLElement>();
	let swipeX = $state<number | null>(null);
	let touchStart: { x: number; y: number; t: number; locked: "h" | "v" | null } | null = null;

	const filterOptions = $derived([
		{ id: "all", label: t("전체") },
		{
			id: "changed",
			label: workspaceViewer.changes.length > 0 ? t("변경됨 ({n})", { n: workspaceViewer.changes.length }) : t("변경됨"),
		},
	]);

	// Refresh tree when drawer opens or bound session changes.
	$effect(() => {
		if (!open || !sessionId) return;
		void workspaceViewer.refreshTree({ preserveOpenDirs: true });
	});

	// Avoid stacking left sidebar drawer and right file drawer on narrow viewports.
	$effect(() => {
		if (app.sidebar.open && open && typeof window !== "undefined" && window.innerWidth <= 900) {
			app.filesOpen = false;
		}
	});

	// Close mobile drawer on Escape.
	$effect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && typeof window !== "undefined" && window.innerWidth <= 900) {
				e.preventDefault();
				app.filesOpen = false;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	function onDrawerTouchStart(e: TouchEvent) {
		if (!open || e.touches.length !== 1 || typeof window === "undefined" || window.innerWidth > 900) return;
		const pt = e.touches[0]!;
		touchStart = { x: pt.clientX, y: pt.clientY, t: Date.now(), locked: null };
	}

	function onDrawerTouchMove(e: TouchEvent) {
		if (!touchStart || e.touches.length !== 1) return;
		const pt = e.touches[0]!;
		const dx = pt.clientX - touchStart.x;
		const dy = pt.clientY - touchStart.y;
		if (!touchStart.locked) {
			if (Math.hypot(dx, dy) < 10) return;
			touchStart.locked = Math.abs(dx) > Math.abs(dy) && dx > 0 ? "h" : "v";
		}
		if (touchStart.locked !== "h") return;
		swipeX = Math.max(0, dx);
	}

	function onDrawerTouchEnd() {
		if (!touchStart) return;
		const moved = swipeX ?? 0;
		const dt = Math.max(1, Date.now() - touchStart.t);
		const w = drawerEl?.offsetWidth || 300;
		const fastFlick = moved > 40 && moved / dt > 0.35;
		touchStart = null;
		swipeX = null;
		if (moved > w * 0.25 || fastFlick) {
			app.filesOpen = false;
		}
	}

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
		// On narrow screens, slide the drawer away right away so the opened file tab takes focus cleanly.
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

	function startFileDrag(e: DragEvent, path: string, dir: boolean) {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData(WORKSPACE_FILE_MIME, JSON.stringify({ path, dir }));
		e.dataTransfer.setData("text/plain", dir ? `${path}/` : path);
		e.dataTransfer.effectAllowed = "copy";
	}

	const scrimOpacity = $derived.by(() => {
		if (swipeX === null) return undefined;
		const w = drawerEl?.offsetWidth || 300;
		return Math.max(0, 1 - swipeX / w);
	});
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
				draggable="true"
				ondragstart={(e) => startFileDrag(e, entry.path, true)}
				style:padding-left="{12 + depth * 14}px"
				onclick={() => workspaceViewer.toggleDir(entry.path)}
				title={entry.path}
			>
				<span class="chev" class:open={isOpen}><Icon name="chevron-right" /></span>
				<span class="fico"><FileIcon name={entry.name} dir open={isOpen} /></span>
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
				draggable="true"
				ondragstart={(e) => startFileDrag(e, entry.path, false)}
				class:on={workspaceViewer.activeFile === entry.path}
				class:opened={workspaceViewer.openFiles.includes(entry.path) && workspaceViewer.activeFile !== entry.path}
				class:recent
				style:padding-left="{28 + depth * 14}px"
				onclick={() => pickFile(entry.path)}
				title={entry.path}
			>
				<span class="fico"><FileIcon name={entry.name} /></span>
				<span class="tname">{entry.name}</span>
				{#if ch}
					<span class="st mono {statusClass(ch.status)}">{ch.status}</span>
				{/if}
			</button>
		{/if}
	{/each}
{/snippet}

<!-- Mobile scrim backdrop: fades in with the right drawer, tapping outside dismisses cleanly -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
	class="fscrim"
	class:show={open}
	class:swiping={swipeX !== null}
	style:opacity={scrimOpacity}
	onclick={() => (app.filesOpen = false)}
></div>

<aside
	bind:this={drawerEl}
	class="ftree"
	class:open
	class:dragging
	class:swiping={swipeX !== null}
	inert={!open}
	data-part="workspace-tree"
	style:--wv-w="{panelWidth}px"
	style:translate={swipeX !== null ? `${swipeX}px 0` : undefined}
	aria-label={t("파일 뷰어")}
	ontouchstart={onDrawerTouchStart}
	ontouchmove={onDrawerTouchMove}
	ontouchend={onDrawerTouchEnd}
	ontouchcancel={onDrawerTouchEnd}
>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div class="grip" role="separator" aria-orientation="vertical" aria-label={t("파일 뷰어 너비 조절")} onpointerdown={startResize}></div>

	<div class="ftree-in">
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
								draggable="true"
								ondragstart={(e) => startFileDrag(e, entry.path, false)}
								class:on={workspaceViewer.activeFile === entry.path}
								class:opened={workspaceViewer.openFiles.includes(entry.path) && workspaceViewer.activeFile !== entry.path}
								class:recent={workspaceViewer.isRecent(entry.path)}
								onclick={() => pickFile(entry.path)}
								title={entry.path}
							>
								<span class="fico"><FileIcon name={entry.name} /></span>
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
							draggable="true"
							ondragstart={(e) => startFileDrag(e, ch.path, false)}
							class:on={workspaceViewer.activeFile === ch.path}
							class:opened={workspaceViewer.openFiles.includes(ch.path) && workspaceViewer.activeFile !== ch.path}
							class:recent={workspaceViewer.isRecent(ch.path) || ch.pending}
							onclick={() => pickFile(ch.path, "diff")}
							title={ch.path}
						>
							<span class="fico"><FileIcon name={ch.path.split("/").pop() ?? ch.path} /></span>
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
	</div>
</aside>

<style>
	.fscrim {
		display: none;
	}
	.ftree {
		position: relative;
		flex: 0 0 var(--wv-w, 260px);
		width: var(--wv-w, 260px);
		max-width: 45vw;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg-side);
		border-left: 1px solid var(--border);
		transition:
			flex-basis var(--motion-normal) var(--ease),
			width var(--motion-normal) var(--ease),
			opacity var(--motion-fast) var(--ease-std),
			border-left-color var(--motion-fast) var(--ease-std);
	}
	.ftree-in {
		flex: 1;
		min-height: 0;
		width: var(--wv-w, 260px);
		display: flex;
		flex-direction: column;
	}
	@media (min-width: 901px) {
		.ftree:not(.open) {
			flex-basis: 0;
			width: 0;
			opacity: 0;
			border-left-color: transparent;
			pointer-events: none;
		}
	}
	.ftree.dragging {
		user-select: none;
		transition: none; /* follow the resize pointer 1:1 */
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
		padding: 8px 12px;
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
		padding: 4px 0 12px;
	}
	.trow {
		width: 100%;
		min-height: 28px;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 12px;
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
		padding-left: 12px;
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
		width: 16px;
		height: 16px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		color: var(--text-faint);
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
		padding: 4px 12px;
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
		padding: 8px 12px;
	}

	@media (max-width: 900px) {
		.fscrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: var(--z-drawer-scrim);
			background: var(--scrim);
			opacity: 0;
			pointer-events: none;
			transition: opacity var(--motion-normal) var(--ease-std);
		}
		.fscrim.show {
			opacity: 1;
			pointer-events: auto;
		}
		.fscrim.swiping {
			transition: none; /* follow the finger 1:1 */
		}
		.ftree {
			position: fixed;
			top: 0;
			right: 0;
			bottom: 0;
			width: min(max(296px, 82vw), 360px);
			max-width: 100%;
			padding-top: var(--sat);
			padding-right: var(--sar);
			padding-bottom: var(--sab);
			z-index: var(--z-drawer);
			translate: 102% 0;
			transition: translate var(--motion-normal) var(--ease);
		}
		.ftree-in {
			width: 100%;
		}
		.ftree.open {
			translate: 0 0;
		}
		.ftree.swiping {
			transition: none; /* follow the finger 1:1 */
		}
		.grip {
			display: none;
		}
		.trow {
			min-height: 36px; /* comfortable touch target on phones */
		}
	}
</style>
