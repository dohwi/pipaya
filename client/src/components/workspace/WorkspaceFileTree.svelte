<script lang="ts">
	import { splitFilePath } from "../../lib/files";
	import { t } from "../../lib/i18n";
	import { formatCombo } from "../../lib/keys";
	import { workDir } from "../../lib/nav";
	import { app } from "../../lib/store.svelte";
	import { EdgeResizeController, RAIL_W } from "../../lib/shell/sidebar-resize.svelte";
	import { viewport } from "../../lib/viewport.svelte";
	import { formatCompactCount, WORKSPACE_FILE_MIME } from "../../lib/workspace-edits";
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
	const shortcutHint = $derived(app.prefs.bindings.toggleFiles ? ` (${formatCombo(app.prefs.bindings.toggleFiles)})` : "");
	const totalAdd = $derived(workspaceViewer.changes.reduce((n, c) => n + c.additions, 0));
	const totalDel = $derived(workspaceViewer.changes.reduce((n, c) => n + c.deletions, 0));
	const anyPending = $derived(workspaceViewer.changes.some((c) => c.pending));
	/** Only files the user deliberately opened as tabs appear below the summary tile in the collapsed 56px rail, keeping huge 100+ file turns calm and readable. */
	const railOpenFiles = $derived(
		workspaceViewer.openFiles.map((path) => ({
			path,
			name: path.split("/").pop() ?? path,
			change: workspaceViewer.changeFor(path),
		})),
	);

	function expandToChanges() {
		workspaceViewer.filter = "changed";
		app.filesOpen = true;
	}

	// Resizable desktop sidebar width (200..420px).
	let panelWidth = $state(260);
	const fileResize = new EdgeResizeController(
		{
			isCollapsed: () => !open,
			setCollapsed: (v) => {
				app.filesOpen = !v;
			},
			shownWidth: () => panelWidth,
			setWidth: (w) => {
				panelWidth = Math.max(200, Math.min(420, Math.round(w)));
			},
		},
		{ side: "right", collapsedWidth: RAIL_W, minWidth: 200, maxWidth: 420 },
	);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	// Mobile right-drawer touch swipe-to-dismiss state (follows the finger 1:1, closes past 25% or on quick flick).
	let drawerEl = $state<HTMLElement>();
	let swipeX = $state<number | null>(null);
	let touchStart: { x: number; y: number; t: number; locked: "h" | "v" | null } | null = null;

	const filterOptions = $derived([
		{ id: "all", label: t("전체") },
		{
			id: "changed",
			label:
				workspaceViewer.changes.length > 0
					? t("변경됨 ({n})", { n: formatCompactCount(workspaceViewer.changes.length) })
					: t("변경됨"),
		},
	]);

	// Refresh tree when drawer opens or bound session changes.
	$effect(() => {
		if (!open || !sessionId) return;
		void workspaceViewer.refreshTree({ preserveOpenDirs: true });
	});

	// Avoid stacking left sidebar drawer and right file drawer on narrow viewports.
	$effect(() => {
		if (app.sidebar.open && open && typeof window !== "undefined" && window.innerWidth <= 860) {
			app.filesOpen = false;
		}
	});

	// Close mobile drawer on Escape.
	$effect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && typeof window !== "undefined" && window.innerWidth <= 860) {
				e.preventDefault();
				app.filesOpen = false;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	function onDrawerTouchStart(e: TouchEvent) {
		if (!open || e.touches.length !== 1 || typeof window === "undefined" || window.innerWidth > 860) return;
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
		if (typeof window !== "undefined" && window.innerWidth <= 860) {
			app.filesOpen = false;
		}
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
				style:padding-left="{12 + depth * 16}px"
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
				style:padding-left="{28 + depth * 16}px"
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
	class:dragging={fileResize.resizing}
	class:folding={fileResize.resizing && fileResize.foldingPreview}
	class:swiping={swipeX !== null}
	inert={viewport.narrow && !open && swipeX === null}
	data-part="workspace-tree"
	style:--wv-w="{panelWidth}px"
	style:translate={swipeX !== null ? `${swipeX}px 0` : undefined}
	aria-label={t("파일 뷰어")}
	ontouchstart={onDrawerTouchStart}
	ontouchmove={onDrawerTouchMove}
	ontouchend={onDrawerTouchEnd}
	ontouchcancel={onDrawerTouchEnd}
>
	{#if !viewport.narrow}
		<!-- A window splitter (WAI-ARIA): stays mounted in both open and rail states so dragging or clicking the edge folds and unfolds. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="grip"
			role="separator"
			aria-orientation="vertical"
			aria-label={t("파일 뷰어 너비 조절")}
			aria-valuemin={200}
			aria-valuemax={420}
			aria-valuenow={open ? panelWidth : 0}
			tabindex="0"
			title={open ? t("끌어서 너비 조절 · 밀어넣어 접기 · 클릭으로 접기/펼치기") : t("끌어서 펼치기 · 클릭으로 펼치기")}
			onpointerdown={fileResize.down}
			onpointermove={fileResize.move}
			onpointerup={fileResize.up}
			onpointercancel={fileResize.up}
			onkeydown={fileResize.key}
		></div>
	{/if}

	<!-- Collapsed desktop rail (56px, mirrors left Rail.svelte): compact changed-files/+/- summary + quick-jump file icons -->
	<div class="frail" data-part="workspace-rail" inert={open || viewport.narrow}>
		<div class="rtop">
			<IconButton icon="folder" label={t("파일 뷰어 펼치기")} title={t("파일 뷰어 펼치기") + shortcutHint} onclick={() => (app.filesOpen = true)} />
		</div>
		<div class="rbody">
			{#if workspaceViewer.changes.length > 0}
				<button
					type="button"
					class="rchg tap"
					class:pending={anyPending}
					onclick={expandToChanges}
					title={totalAdd > 0 || totalDel > 0
						? t("변경된 파일 {n}개 (+{add} / -{del})", {
								n: workspaceViewer.changes.length.toLocaleString(),
								add: totalAdd.toLocaleString(),
								del: totalDel.toLocaleString(),
							})
						: t("변경된 파일 {n}개", { n: workspaceViewer.changes.length.toLocaleString() })}
					aria-label={t("변경된 파일 {n}개", { n: workspaceViewer.changes.length })}
				>
					{#if anyPending}<span class="rpdot" aria-hidden="true"></span>{/if}
					<span class="rcnt mono">{formatCompactCount(workspaceViewer.changes.length)}</span>
					{#if totalAdd > 0}<span class="radd mono">+{formatCompactCount(totalAdd)}</span>{/if}
					{#if totalDel > 0}<span class="rdel mono">-{formatCompactCount(totalDel)}</span>{/if}
				</button>
			{/if}
			{#if workspaceViewer.changes.length > 0 && railOpenFiles.length > 0}
				<span class="rsep" aria-hidden="true"></span>
			{/if}
			{#each railOpenFiles as item (item.path)}
				{@const isCur = workspaceViewer.activeFile === item.path}
				{@const ch = item.change}
				<button
					type="button"
					class="rfile tap"
					class:active={isCur}
					onclick={() => pickFile(item.path, ch ? "diff" : undefined)}
					title={ch && (ch.additions > 0 || ch.deletions > 0)
						? `${item.path} (+${ch.additions.toLocaleString()} -${ch.deletions.toLocaleString()})`
						: item.path}
					aria-label={item.path}
					aria-current={isCur ? "true" : undefined}
				>
					<FileIcon name={item.name} />
					{#if ch}
						<span class="rdot {statusClass(ch.status)}" aria-hidden="true"></span>
					{/if}
				</button>
			{/each}
		</div>
	</div>

	<div class="ftree-in" inert={!open}>
	<header class="head">
		<div class="htitle" title={workspaceViewer.workDir}>
			{#if workspaceViewer.branch}
				<span class="hbranch mono" title="{folderName} · {workspaceViewer.branch}">{workspaceViewer.branch}</span>
			{:else}
				<span class="hname mono">{folderName || t("파일 뷰어")}</span>
			{/if}
		</div>
		<div class="hact">
			<IconButton icon="retry" label={t("새로고침")} onclick={() => workspaceViewer.refreshTree({ preserveOpenDirs: true })} />
			{#if viewport.narrow}
				<IconButton icon="x" label={t("파일 뷰어 닫기")} title={t("파일 뷰어 닫기") + shortcutHint} onclick={() => (app.filesOpen = false)} />
			{/if}
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
							{@const parts = splitFilePath(entry.path)}
							{@const baseLabel = parts?.base ?? entry.name}
							{@const dirLabel = parts?.dir.replace(/\/$/, "") ?? ""}
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
								<span class="fico"><FileIcon name={baseLabel} /></span>
								<span class="tstack">
									<span class="tbase mono">{baseLabel}</span>
									{#if dirLabel}<span class="tdir mono">{dirLabel}</span>{/if}
								</span>
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
						{@const parts = splitFilePath(ch.path)}
						{@const baseLabel = parts?.base ?? ch.path.split("/").pop() ?? ch.path}
						{@const dirLabel = parts?.dir.replace(/\/$/, "") ?? ""}
						<button
							type="button"
							class="trow file changed-row"
							draggable="true"
							ondragstart={(e) => startFileDrag(e, ch.path, false)}
							class:on={workspaceViewer.activeFile === ch.path}
							class:opened={workspaceViewer.openFiles.includes(ch.path) && workspaceViewer.activeFile !== ch.path}
							class:recent={workspaceViewer.isRecent(ch.path) || ch.pending}
							onclick={() => pickFile(ch.path, "diff")}
							title={ch.additions > 0 || ch.deletions > 0
								? `${ch.path} (+${ch.additions.toLocaleString()} -${ch.deletions.toLocaleString()})`
								: ch.path}
						>
							<span class="fico"><FileIcon name={baseLabel} /></span>
							<span class="tstack">
								<span class="tbase mono">{baseLabel}</span>
								{#if dirLabel}<span class="tdir mono">{dirLabel}</span>{/if}
							</span>
							{#if ch.pending}
								<span class="pend">{t("수정 중")}</span>
							{:else}
								<span class="cstat mono">
									{#if ch.additions > 0}<span class="add">+{formatCompactCount(ch.additions)}</span>{/if}
									{#if ch.deletions > 0}<span class="del">-{formatCompactCount(ch.deletions)}</span>{/if}
								</span>
							{/if}
							<span class="st mono {statusClass(ch.status)}">{ch.status}</span>
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
		height: 100%;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg-side);
		border-left: 1px solid var(--border);
		transition:
			flex-basis var(--motion-normal) var(--ease),
			width var(--motion-normal) var(--ease);
	}
	.ftree-in,
	.frail {
		display: flex;
		flex-direction: column;
		min-height: 0;
		padding-top: var(--sat);
		padding-right: var(--sar);
		padding-bottom: var(--sab);
	}
	.ftree-in {
		flex: 1;
		width: var(--wv-w, 260px);
	}
	@media (min-width: 861px) {
		.ftree {
			overflow: visible; /* let the 9px edge grip straddle the left border */
		}
		.ftree:not(.open) {
			flex-basis: var(--rail-w);
			width: var(--rail-w);
		}
		.ftree-in,
		.frail {
			position: absolute;
			top: 0;
			height: 100%;
			overflow: hidden;
			transition:
				opacity var(--motion-normal) var(--ease-std),
				visibility 0s;
		}
		.ftree-in {
			left: 0;
			width: var(--wv-w, 260px);
		}
		.frail {
			right: 0;
			width: var(--rail-w);
			align-items: center;
		}
		.ftree:not(.open) .ftree-in,
		.ftree.open .frail {
			opacity: 0;
			visibility: hidden;
			pointer-events: none;
			transition:
				opacity var(--motion-fast) var(--ease-std),
				visibility 0s linear var(--motion-fast);
		}
		/* dragged below minWidth toward the fold snap point: subtle fade signals an imminent snap */
		.ftree.folding .ftree-in {
			opacity: 0.65;
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
		left: -4px; /* centres the 9px hit strip over the 1px left border */
		width: 9px;
		cursor: col-resize;
		touch-action: none;
		z-index: var(--z-popover);
	}
	.grip::before {
		content: "";
		position: absolute;
		top: calc(50% - 16px);
		left: 3px; /* centres the 4px grabber on the 2px hairline at left: 4px */
		width: 4px;
		height: 32px;
		border-radius: 2px;
		background: var(--accent);
		opacity: 0;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.grip::after {
		content: "";
		position: absolute;
		top: 0;
		bottom: 0;
		left: 4px;
		width: 2px;
		background: var(--accent);
		opacity: 0;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.grip:hover::after,
	.grip:focus-visible::after,
	.ftree.dragging .grip::after {
		opacity: 0.55;
	}
	.grip:hover::before,
	.grip:focus-visible::before,
	.ftree.dragging .grip::before {
		opacity: 0.9;
	}
	.grip:focus-visible {
		outline: none;
	}
	/* Collapsed desktop right rail (56px, exact vertical rhythm with left Rail.svelte & Header) */
	.rtop {
		display: grid;
		place-items: center;
		flex: none;
		width: 100%;
		box-sizing: content-box;
		height: 44px;
		border-bottom: 1px solid var(--border);
	}
	.rtop :global(.iconbtn:focus-visible) {
		outline-offset: -2px;
	}
	@media (min-width: 601px) {
		:global(:root:has(main > [data-part="tabbar"])) .rtop {
			border-bottom-color: var(--tabbar-line);
		}
	}
	.rbody {
		flex: 1;
		min-height: 0;
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 8px 0;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: none;
	}
	.rbody::-webkit-scrollbar {
		display: none;
	}
	.rchg {
		position: relative;
		flex: none;
		width: 44px;
		padding: 4px;
		border: 0;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--bg-hover) 55%, transparent);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0;
		overflow: hidden;
		cursor: pointer;
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.rchg:hover {
			background: var(--bg-hover);
		}
	}
	.rpdot {
		position: absolute;
		top: 4px;
		right: 4px;
		width: 6px; /* optical 6px live-edit indicator matching tab/tree dots */
		height: 6px; /* optical 6px live-edit indicator matching tab/tree dots */
		border-radius: var(--radius-pill);
		background: var(--warn);
		pointer-events: none;
	}
	.rcnt,
	.radd,
	.rdel {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		line-height: 16px;
	}
	.rcnt {
		font-size: var(--fs-xs);
		font-weight: 700;
		color: var(--text);
	}
	.radd {
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--ok);
	}
	.rdel {
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--danger);
	}
	.rsep {
		flex: none;
		width: 28px;
		height: 1px;
		margin: 4px 0;
		background: var(--border-strong);
	}
	.rfile {
		position: relative;
		flex: none;
		width: 40px;
		height: 36px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		cursor: pointer;
		transition: background var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.rfile:hover {
			background: var(--bg-hover);
		}
	}
	.rfile.active {
		background: var(--accent-soft);
	}
	/* Mirror left Rail's edge bar on the right side for the currently focused file tab */
	.rfile.active::after {
		content: "";
		position: absolute;
		right: -8px;
		top: 8px;
		bottom: 8px;
		width: 3px;
		border-radius: 2px 0 0 2px;
		background: var(--text);
	}
	.rdot {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 6px; /* optical 6px status indicator matching tree/tab dots */
		height: 6px; /* optical 6px status indicator matching tree/tab dots */
		border-radius: var(--radius-pill);
		background: var(--info);
		pointer-events: none;
	}
	.rdot.st-add {
		background: var(--ok);
	}
	.rdot.st-del {
		background: var(--danger);
	}
	.head {
		box-sizing: content-box;
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 44px;
		padding: 0 12px;
		background: var(--bg-side);
		border-bottom: 1px solid var(--border);
	}
	/* Match left Sidebar .brandrow and Header hairline over the tab strip so the top 44px line runs unbroken across all three columns */
	@media (min-width: 601px) {
		:global(:root:has(main > [data-part="tabbar"])) .head {
			border-bottom-color: var(--tabbar-line);
		}
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
		gap: 0;
		flex: none;
	}
	/* Compact 32px hitboxes (16px icons? no, keep 19px glyph crisp while tightening horizontal footprint to 32px so retry & x sit 13px ink-to-ink like header controls) */
	.hact :global(.iconbtn) {
		width: 32px;
		height: 38px;
	}
	/* Pull the 32px button's 6.5px right padding outside the 12px gutter so the 19px glyph right edge aligns with Segmented/search below */
	.hact :global(.iconbtn:last-child) {
		margin-right: -6.5px;
	}
	/* 38px tall button in a 44px bar: draw the focus ring inside so it never clips against the bar edge */
	.hact :global(.iconbtn:focus-visible) {
		outline-offset: -2px;
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
		padding: 4px 12px;
		gap: 8px;
		content-visibility: auto;
		contain-intrinsic-size: auto 44px;
	}
	.tstack {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.tbase {
		color: var(--text);
		font-size: var(--fs-xs);
		line-height: 20px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tdir {
		color: var(--text-faint);
		font-size: var(--fs-2xs);
		line-height: 16px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	@media (max-width: 640px) {
		.search {
			height: 36px; /* comfortable mobile input height with 16px text */
			font-size: 16px; /* prevent iOS Safari auto-zoom on input focus */
		}
	}
	@media (max-width: 860px) {
		.frail {
			display: none;
		}
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
			z-index: var(--z-drawer);
			translate: 102% 0;
			transition: translate var(--motion-normal) var(--ease);
		}
		.ftree-in {
			width: 100%;
			height: 100%;
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
