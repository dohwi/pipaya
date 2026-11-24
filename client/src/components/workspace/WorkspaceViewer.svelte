<script lang="ts">
	import DOMPurify from "dompurify";
	import { onMount } from "svelte";
	import { highlightCode, onHighlightReady } from "../../lib/code-highlight";
	import { t } from "../../lib/i18n";
	import { workDir } from "../../lib/nav";
	import { app } from "../../lib/store.svelte";
	import { workspaceViewer, type DiffLine, type WorkspaceEntry } from "../../lib/workspace-viewer.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import Icon from "../ui/Icon.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Notice from "../ui/Notice.svelte";
	import Segmented from "../ui/Segmented.svelte";

	const session = $derived(app.current);
	const sessionId = $derived(session?.id ?? null);
	const folderName = $derived(session ? workDir(session).split(/[\\/]/).filter(Boolean).pop() ?? workDir(session) : "");

	// Resizable desktop panel width (380..920px).
	let panelWidth = $state(580);
	let dragging = $state(false);

	// Syntax highlight readiness tick (re-runs derived highlighting when a lazy grammar finishes loading).
	let hlTick = $state(0);
	onMount(() => onHighlightReady(() => hlTick++));

	// Inline line-comment composer state (works in both File view and Diff view).
	let commentTarget = $state<{ path: string; line: number; snippet: string; key: string } | null>(null);
	let commentText = $state("");
	let sending = $state(false);
	let mobileShowFile = $state(false);

	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	const filterOptions = $derived([
		{ id: "all", label: t("전체") },
		{
			id: "changed",
			label: workspaceViewer.changes.length > 0 ? t("변경됨 ({n})", { n: workspaceViewer.changes.length }) : t("변경됨"),
		},
	]);

	const selectedChange = $derived(workspaceViewer.selectedPath ? workspaceViewer.changeFor(workspaceViewer.selectedPath) : undefined);

	const modeOptions = $derived([
		{ id: "file", label: t("파일") },
		{ id: "diff", label: t("변경 비교") },
	]);

	const fileExt = $derived.by(() => {
		const p = workspaceViewer.selectedPath ?? "";
		const base = p.split("/").pop() ?? "";
		const i = base.lastIndexOf(".");
		return i > 0 ? base.slice(i + 1).toLowerCase() : base.toLowerCase();
	});

	const rawLines = $derived.by(() => {
		const content = workspaceViewer.fileData?.content ?? "";
		return content ? content.split(/\r?\n/) : [];
	});

	/** Per-line highlighted HTML when grammar is ready and file is a reasonable size; null falls back to plain escaped text. */
	const highlightedLines = $derived.by<string[] | null>(() => {
		void hlTick;
		const content = workspaceViewer.fileData?.content ?? "";
		if (!content || rawLines.length > 2500) return null;
		const res = highlightCode(content, fileExt);
		if (!res || res === "wait") return null;
		// Highlight line-by-line only if multi-line spans wouldn't break; for simplicity and safety, sanitize per-line highlight.
		const out: string[] = [];
		for (const line of rawLines) {
			if (!line) {
				out.push("");
				continue;
			}
			const h = highlightCode(line, fileExt);
			out.push(h && h !== "wait" ? DOMPurify.sanitize(h, { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"] }) : "");
		}
		return out;
	});

	// Refresh tree when panel opens or active session changes.
	$effect(() => {
		if (!app.filesOpen || !sessionId) return;
		void workspaceViewer.refreshTree({ preserveOpenDirs: true });
	});

	// Reset inline comment when switching files or view modes.
	$effect(() => {
		void workspaceViewer.selectedPath;
		void workspaceViewer.viewMode;
		commentTarget = null;
		commentText = "";
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
		mobileShowFile = true;
		await workspaceViewer.selectFile(path, mode);
	}

	function openLineComment(path: string, line: number, snippet: string, key: string) {
		if (commentTarget?.key === key) {
			commentTarget = null;
			commentText = "";
			return;
		}
		commentTarget = { path, line, snippet: snippet.trim().slice(0, 140), key };
		commentText = "";
	}

	function formatCommentText(target: { path: string; line: number; snippet: string }, note: string): string {
		const ref = `\`${target.path}:${target.line}\``;
		const code = target.snippet ? ` (\`${target.snippet.replace(/`/g, "'")}\`)` : "";
		const trimmed = note.trim();
		return trimmed ? `${ref}${code} — ${trimmed}` : `${ref}${code} `;
	}

	function insertToComposer() {
		if (!commentTarget || !sessionId) return;
		const formatted = formatCommentText(commentTarget, commentText);
		app.insertText = { paneId: sessionId, text: formatted };
		commentTarget = null;
		commentText = "";
		app.toast(t("입력창에 추가했습니다"), "ok", sessionId);
		queueMicrotask(() => {
			const pane = document.querySelector(`[data-pane="${CSS.escape(sessionId)}"]`);
			pane?.querySelector<HTMLTextAreaElement>("textarea[data-composer]")?.focus();
		});
	}

	async function sendNow() {
		if (!commentTarget || !sessionId || !commentText.trim()) return;
		sending = true;
		try {
			const formatted = formatCommentText(commentTarget, commentText);
			if (app.running[sessionId]) await app.queue(formatted, [], sessionId);
			else await app.send(formatted, [], sessionId);
			commentTarget = null;
			commentText = "";
		} finally {
			sending = false;
		}
	}

	function onCommentKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			commentTarget = null;
			commentText = "";
		} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (commentText.trim()) void sendNow();
			else insertToComposer();
		} else if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			insertToComposer();
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
			panelWidth = Math.max(380, Math.min(920, Math.round(next)));
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

	function diffLineNumber(l: DiffLine): number {
		return l.newLine ?? l.oldLine ?? 1;
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
				class:on={workspaceViewer.selectedPath === entry.path}
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

{#snippet inlineCommentBox()}
	<div class="cbox">
		<div class="chead">
			<span class="cloc mono">{commentTarget?.path}:{commentTarget?.line}</span>
			<span class="chint">{t("Enter 입력창에 넣기 · Ctrl+Enter 바로 보내기")}</span>
		</div>
		<!-- svelte-ignore a11y_autofocus -->
		<textarea
			class="cta"
			rows="2"
			autofocus
			bind:value={commentText}
			onkeydown={onCommentKey}
			placeholder={t("수정 요청을 입력하거나 비우고 Enter로 줄 위치만 입력창에 넣으세요…")}
		></textarea>
		<div class="cact">
			<Button size="sm" variant="primary" onclick={insertToComposer}>{t("입력창에 넣기")}</Button>
			<Button size="sm" variant="default" disabled={sending || !commentText.trim()} onclick={sendNow}>{t("바로 보내기")}</Button>
			<Button size="sm" variant="default" onclick={() => ((commentTarget = null), (commentText = ""))}>{t("취소")}</Button>
		</div>
	</div>
{/snippet}

<aside
	class="viewer"
	class:dragging
	data-part="workspace-viewer"
	style:--wv-w="{panelWidth}px"
	aria-label={t("파일 뷰어")}
>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div class="grip" role="separator" aria-orientation="vertical" aria-label={t("파일 뷰어 너비 조절")} onpointerdown={startResize}></div>

	<header class="head">
		{#if mobileShowFile && workspaceViewer.selectedPath}
			<span class="mback">
				<IconButton icon="chevron-left" size="sm" label={t("파일 목록")} onclick={() => (mobileShowFile = false)} />
			</span>
		{/if}
		<div class="htitle">
			<span class="hname mono" title={workspaceViewer.workDir}>{folderName || t("파일 뷰어")}</span>
			{#if workspaceViewer.branch}
				<Badge tone="neutral" size="sm" mono>{workspaceViewer.branch}</Badge>
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
		<div class="split" class:mobile-file={mobileShowFile}>
			<!-- Left column: file tree / changed list -->
			<div class="tree-col">
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
										class:on={workspaceViewer.selectedPath === entry.path}
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
							{#each workspaceViewer.changes as ch (ch.path)}
								<button
									type="button"
									class="trow file changed-row"
									class:on={workspaceViewer.selectedPath === ch.path}
									class:recent={workspaceViewer.isRecent(ch.path)}
									onclick={() => pickFile(ch.path, "diff")}
									title={ch.path}
								>
									<span class="st mono {statusClass(ch.status)}">{ch.status}</span>
									<span class="tname mono">{ch.path}</span>
									<span class="cstat mono">
										{#if ch.additions > 0}<span class="add">+{ch.additions}</span>{/if}
										{#if ch.deletions > 0}<span class="del">-{ch.deletions}</span>{/if}
									</span>
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
			</div>

			<!-- Right column: read-only file / diff viewer with inline line comments -->
			<div class="code-col">
				{#if !workspaceViewer.selectedPath}
					<div class="pad">
						<EmptyState>{t("왼쪽에서 파일을 선택해 내용을 확인하세요. 줄을 클릭하면 코멘트를 채팅 입력창에 바로 넣을 수 있습니다.")}</EmptyState>
					</div>
				{:else}
					<div class="fbar">
						<span class="fpath mono" title={workspaceViewer.selectedPath}>{workspaceViewer.selectedPath}</span>
						{#if selectedChange}
							<div class="mtoggle">
								<Segmented
									label={t("보기 모드")}
									options={modeOptions}
									value={workspaceViewer.viewMode}
									size="sm"
									full={false}
									onchange={(id) => {
										workspaceViewer.viewMode = id as "file" | "diff";
										if (id === "diff" && workspaceViewer.selectedPath) void workspaceViewer.loadDiff(workspaceViewer.selectedPath);
									}}
								/>
							</div>
						{/if}
					</div>

					<div class="cscroll">
						{#if workspaceViewer.viewMode === "diff" && selectedChange}
							{#if !workspaceViewer.diffData}
								<div class="pad"><EmptyState loading compact>{t("Diff를 불러오는 중…")}</EmptyState></div>
							{:else if workspaceViewer.diffData.binary}
								<div class="pad"><EmptyState compact>{t("바이너리 파일은 Diff로 표시할 수 없습니다.")}</EmptyState></div>
							{:else if workspaceViewer.diffData.hunks.length === 0}
								<div class="pad"><EmptyState compact>{t("표시할 변경 라인이 없습니다.")}</EmptyState></div>
							{:else}
								<div class="lines mono">
									{#each workspaceViewer.diffData.hunks as hunk (hunk.header)}
										<div class="hunk">{hunk.header}</div>
										{#each hunk.lines as dl, idx (`${hunk.header}:${idx}`)}
											{@const ln = diffLineNumber(dl)}
											{@const key = `d:${hunk.header}:${idx}`}
											<div class="row d-{dl.type}" class:picked={commentTarget?.key === key}>
												<span class="ln">{dl.oldLine ?? ""}</span>
												<span class="ln">{dl.newLine ?? ""}</span>
												{#if dl.type !== "meta"}
													<button
														type="button"
														class="plus"
														title={t("이 줄에 코멘트 달기")}
														aria-label={t("이 줄에 코멘트 달기")}
														onclick={() => openLineComment(workspaceViewer.selectedPath!, ln, dl.text, key)}
													>+</button>
												{:else}
													<span class="plus-sp"></span>
												{/if}
												<span class="txt">{dl.type === "add" ? "+" : dl.type === "del" ? "-" : " "}{dl.text}</span>
											</div>
											{#if commentTarget?.key === key}
												{@render inlineCommentBox()}
											{/if}
										{/each}
									{/each}
								</div>
							{/if}
						{:else if workspaceViewer.fileLoading && !workspaceViewer.fileData}
							<div class="pad"><EmptyState loading compact>{t("파일을 불러오는 중…")}</EmptyState></div>
						{:else if workspaceViewer.fileError}
							<div class="pad">
								<Notice tone="danger" size="sm" onretry={() => workspaceViewer.selectedPath && workspaceViewer.loadFile(workspaceViewer.selectedPath)}>
									{workspaceViewer.fileError}
								</Notice>
							</div>
						{:else if workspaceViewer.fileData?.binary}
							<div class="pad"><EmptyState compact>{t("바이너리 파일은 텍스트로 표시할 수 없습니다.")}</EmptyState></div>
						{:else if workspaceViewer.fileData}
							{#if workspaceViewer.fileData.truncated}
								<div class="trunc">{t("파일이 커서 앞부분만 표시합니다 (읽기 전용).")}</div>
							{/if}
							<div class="lines mono">
								{#each rawLines as line, idx (idx)}
									{@const ln = idx + 1}
									{@const key = `f:${ln}`}
									{@const html = highlightedLines?.[idx]}
									<div class="row" class:picked={commentTarget?.key === key}>
										<button
											type="button"
											class="lnbtn"
											title={t("{line}번 줄에 코멘트 달기", { line: ln })}
											onclick={() => openLineComment(workspaceViewer.selectedPath!, ln, line, key)}
										>
											<span class="lnum">{ln}</span>
											<span class="lplus" aria-hidden="true">+</span>
										</button>
										{#if html}
											<span class="txt">{@html html}</span>
										{:else}
											<span class="txt">{line}</span>
										{/if}
									</div>
									{#if commentTarget?.key === key}
										{@render inlineCommentBox()}
									{/if}
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</aside>

<style>
	.viewer {
		position: relative;
		flex: 0 0 var(--wv-w, 580px);
		width: var(--wv-w, 580px);
		max-width: 65vw;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		border-left: 1px solid var(--border);
	}
	.viewer.dragging {
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
	.mback {
		display: none;
	}
	.htitle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		line-height: 20px;
	}
	.hname {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 20px;
	}
	.hact {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}
	.split {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.tree-col {
		flex: 0 0 212px;
		width: 212px;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg-side);
		border-right: 1px solid var(--border);
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
	.trow.recent {
		background: var(--accent-soft);
		color: var(--text);
	}
	.changed-row, .search-row {
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
	.st-add { color: var(--ok); }
	.st-mod { color: var(--info); }
	.st-del { color: var(--danger); }
	.cstat {
		display: inline-flex;
		gap: 4px;
		font-size: var(--fs-2xs);
		flex: none;
		line-height: 16px;
	}
	.add { color: var(--ok); }
	.del { color: var(--danger); }

	.code-col {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
	}
	.fbar {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 12px;
		min-height: 40px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-side);
	}
	.fpath {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 20px;
	}
	.mtoggle {
		flex: none;
	}
	.cscroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
		background: var(--bg-code);
	}
	.trunc {
		padding: 8px 12px;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--warn);
		background: var(--warn-soft);
		border-bottom: 1px solid var(--border);
	}
	.lines {
		padding: 8px 0;
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.hunk {
		padding: 4px 12px;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--info);
		background: var(--info-soft);
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}
	.row {
		display: flex;
		align-items: stretch;
		min-width: max-content;
		line-height: 20px;
	}
	@media (hover: hover) {
		.row:hover {
			background: var(--bg-hover);
		}
	}
	.row.picked {
		background: var(--accent-soft);
	}
	.row.d-add {
		background: var(--ok-soft);
	}
	.row.d-del {
		background: var(--danger-soft);
	}
	.lnbtn {
		position: relative;
		width: 48px;
		padding: 0 8px 0 4px;
		border: 0;
		background: transparent;
		color: var(--text-faint);
		font: inherit;
		text-align: right;
		cursor: pointer;
		flex: none;
		user-select: none;
		line-height: 20px;
	}
	.lplus {
		position: absolute;
		left: 4px;
		top: 0;
		color: var(--accent);
		font-weight: 700;
		opacity: 0;
	}
	@media (hover: hover) {
		.row:hover .lplus, .lnbtn:hover .lplus {
			opacity: 1;
		}
	}
	.lnbtn:focus-visible .lplus, .row.picked .lplus {
		opacity: 1;
	}
	.ln {
		width: 36px;
		padding: 0 4px;
		text-align: right;
		color: var(--text-faint);
		user-select: none;
		flex: none;
		line-height: 20px;
	}
	.plus {
		width: 20px;
		height: 20px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--accent);
		font-weight: 700;
		cursor: pointer;
		flex: none;
		opacity: 0;
		line-height: 20px;
	}
	@media (hover: hover) {
		.row:hover .plus {
			opacity: 1;
		}
	}
	.plus:focus-visible, .row.picked .plus {
		opacity: 1;
	}
	.plus-sp {
		width: 20px;
		flex: none;
	}
	.txt {
		padding: 0 12px 0 4px;
		white-space: pre;
		color: var(--text);
		line-height: 20px;
	}
	/* Reuse app syntax palette tokens from Markdown.svelte */
	.txt :global(:is(.hljs-keyword, .hljs-doctag, .hljs-template-tag, .hljs-template-variable, .hljs-type, .hljs-variable.language_, .hljs-meta .hljs-keyword)) {
		color: var(--syn-keyword);
	}
	.txt :global(:is(.hljs-title, .hljs-title.class_, .hljs-title.function_)) {
		color: var(--syn-title);
	}
	.txt :global(:is(.hljs-attr, .hljs-attribute, .hljs-literal, .hljs-meta, .hljs-number, .hljs-operator, .hljs-variable, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id, .hljs-section)) {
		color: var(--syn-number);
	}
	.txt :global(:is(.hljs-string, .hljs-regexp, .hljs-meta .hljs-string)) {
		color: var(--syn-string);
	}
	.txt :global(:is(.hljs-built_in, .hljs-symbol)) {
		color: var(--syn-builtin);
	}
	.txt :global(:is(.hljs-comment, .hljs-code, .hljs-formula)) {
		color: var(--syn-comment);
	}
	.txt :global(:is(.hljs-name, .hljs-quote, .hljs-selector-tag, .hljs-selector-pseudo, .hljs-addition)) {
		color: var(--syn-name);
	}
	.txt :global(:is(.hljs-bullet, .hljs-link)) {
		color: var(--syn-bullet);
	}
	.txt :global(.hljs-deletion) {
		color: var(--syn-keyword);
	}

	.cbox {
		position: sticky;
		left: 0;
		padding: 8px 12px;
		background: var(--bg-elev);
		border-top: 1px solid var(--border-strong);
		border-bottom: 1px solid var(--border-strong);
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-family: var(--font);
	}
	.chead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
		line-height: 16px;
	}
	.cloc {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--accent);
		line-height: 16px;
	}
	.chint {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		line-height: 16px;
	}
	.cta {
		width: 100%;
		padding: 8px;
		border-radius: var(--radius-xs);
		border: 1px solid var(--border-strong);
		background: var(--bg);
		color: var(--text);
		font-size: var(--fs-xs);
		line-height: 20px;
		resize: vertical;
	}
	.cact {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.pad {
		padding: 16px;
	}
	.pad-sm {
		padding: 8px;
	}

	@media (max-width: 1024px) {
		.viewer {
			position: fixed;
			inset: 0;
			left: auto;
			width: min(640px, 100vw);
			max-width: 100vw;
			z-index: var(--z-drawer);
			padding-top: var(--sat);
			padding-bottom: var(--sab);
		}
		.grip {
			display: none;
		}
	}
	@media (max-width: 640px) {
		.mback {
			display: inline-flex;
		}
		.tree-col {
			flex: 1 1 100%;
			width: 100%;
			border-right: 0;
		}
		.code-col {
			display: none;
		}
		.split.mobile-file .tree-col {
			display: none;
		}
		.split.mobile-file .code-col {
			display: flex;
		}
	}
</style>
