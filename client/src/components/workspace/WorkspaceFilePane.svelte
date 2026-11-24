<script lang="ts">
	import DOMPurify from "dompurify";
	import { onDestroy, onMount, untrack } from "svelte";
	import { errorText } from "../../lib/api";
	import { copyText } from "../../lib/clipboard";
	import { highlightCode, onHighlightReady } from "../../lib/code-highlight";
	import { baseName, extOf, parseTable, previewKind, sizeLabel, type PreviewKind } from "../../lib/files";
	import { t } from "../../lib/i18n";
	import { saveFile } from "../../lib/save-file";
	import { app } from "../../lib/store.svelte";
	import { closeVideoView, videoPlayer } from "../../lib/video-view";
	import { workspaceViewer, type DiffLine } from "../../lib/workspace-viewer.svelte";
	import Markdown from "../chat/Markdown.svelte";
	import Button from "../ui/Button.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Notice from "../ui/Notice.svelte";
	import Segmented from "../ui/Segmented.svelte";

	const IMAGE_PREVIEW_MAX = 1600;

	const sessionId = $derived(app.current?.id ?? workspaceViewer.sessionId);
	const selectedPath = $derived(workspaceViewer.activeFile ?? workspaceViewer.selectedPath);
	const fileName = $derived(selectedPath ? baseName(selectedPath) : "");
	const selectedChange = $derived(selectedPath ? workspaceViewer.changeFor(selectedPath) : undefined);

	// Syntax highlight readiness tick (re-runs derived highlighting when a lazy grammar finishes loading).
	let hlTick = $state(0);
	onMount(() => onHighlightReady(() => hlTick++));

	// Preview mode for rich text-backed formats (markdown, html, csv/tsv): preview vs source.
	let richPreview = $state(true);

	// Media / blob preview state (image, pdf, audio, video, html sandbox).
	let mediaUrl = $state<string | null>(null);
	let htmlUrl = $state<string | null>(null);
	let mediaMime = $state("");
	let mediaSize = $state<number | undefined>(undefined);
	let mediaLoading = $state(false);
	let mediaError = $state<string | null>(null);
	let mediaFailed = $state(false);
	let imgDims = $state<{ w: number; h: number } | null>(null);
	let videoHost = $state<HTMLElement>();
	let saving = $state(false);
	let copied = $state(false);

	const kind = $derived<PreviewKind>(fileName ? previewKind(fileName, mediaMime) : "text");
	const isMediaKind = $derived(kind === "image" || kind === "pdf" || kind === "audio" || kind === "video");
	const hasRichPreview = $derived(kind === "markdown" || kind === "html" || kind === "table");
	const showRichPreview = $derived(
		hasRichPreview && richPreview && workspaceViewer.viewMode === "file" && !!workspaceViewer.fileData && !workspaceViewer.fileData.binary,
	);

	function revokeMedia() {
		if (mediaUrl) URL.revokeObjectURL(mediaUrl);
		mediaUrl = null;
		if (htmlUrl) URL.revokeObjectURL(htmlUrl);
		htmlUrl = null;
	}
	onDestroy(revokeMedia);

	// Fetch binary/media blobs (image, pdf, audio, video) through `/sessions/:id/files`.
	$effect(() => {
		const path = selectedPath;
		const sid = sessionId;
		const api = app.api;
		const k = path ? previewKind(baseName(path)) : "text";
		untrack(revokeMedia);
		mediaMime = "";
		mediaSize = undefined;
		mediaError = null;
		mediaFailed = false;
		imgDims = null;
		richPreview = k === "markdown" || k === "html" || k === "table";

		if (!path || !sid || !api) {
			mediaLoading = false;
			return;
		}
		if (k !== "image" && k !== "pdf" && k !== "audio" && k !== "video") {
			mediaLoading = false;
			return;
		}
		const ctl = new AbortController();
		mediaLoading = true;
		api
			.fetchFile(sid, path, ctl.signal, k === "image" ? { max: IMAGE_PREVIEW_MAX } : undefined)
			.then((blob) => {
				if (ctl.signal.aborted) return;
				mediaMime = blob.type;
				mediaSize = k === "image" ? (workspaceViewer.fileData?.size ?? blob.size) : blob.size;
				mediaUrl = URL.createObjectURL(blob);
			})
			.catch((e) => {
				if (!ctl.signal.aborted && (e as Error).name !== "AbortError") mediaError = errorText(e);
			})
			.finally(() => {
				if (!ctl.signal.aborted) mediaLoading = false;
			});
		return () => ctl.abort();
	});

	// Build sandboxed blob URL for HTML preview when file content is loaded.
	$effect(() => {
		if (kind !== "html" || !showRichPreview || !workspaceViewer.fileData?.content) return;
		const blobUrl = URL.createObjectURL(new Blob([workspaceViewer.fileData.content], { type: "text/html;charset=utf-8" }));
		htmlUrl = blobUrl;
		return () => {
			URL.revokeObjectURL(blobUrl);
			if (htmlUrl === blobUrl) htmlUrl = null;
		};
	});

	// Mount Pipaya's video player (includes mobile fullscreen support).
	$effect(() => {
		if (kind !== "video" || !mediaUrl || mediaFailed || !videoHost) return;
		const player = videoPlayer(mediaUrl);
		player.querySelector("video")?.addEventListener("error", () => (mediaFailed = true));
		videoHost.replaceChildren(player);
		return () => closeVideoView(player);
	});

	const table = $derived(
		kind === "table" && showRichPreview && workspaceViewer.fileData?.content
			? parseTable(workspaceViewer.fileData.content, /\.tsv$/i.test(fileName) ? "\t" : ",")
			: null,
	);

	const modeOptions = $derived.by(() => {
		if (hasRichPreview) {
			const opts: { id: string; label: string }[] = [
				{ id: "preview", label: kind === "table" ? t("표") : t("미리보기") },
				{ id: "source", label: t("원본") },
			];
			if (selectedChange) opts.push({ id: "diff", label: t("변경 비교") });
			return opts;
		}
		if (selectedChange) {
			return [
				{ id: "file", label: t("파일") },
				{ id: "diff", label: t("변경 비교") },
			];
		}
		return [];
	});

	const activeModeId = $derived.by(() => {
		if (workspaceViewer.viewMode === "diff" && selectedChange) return "diff";
		if (hasRichPreview) return richPreview ? "preview" : "source";
		return "file";
	});

	function onModeChange(id: string) {
		if (id === "diff") {
			workspaceViewer.viewMode = "diff";
			if (selectedPath) void workspaceViewer.loadDiff(selectedPath);
		} else if (id === "preview") {
			workspaceViewer.viewMode = "file";
			richPreview = true;
		} else if (id === "source") {
			workspaceViewer.viewMode = "file";
			richPreview = false;
		} else {
			workspaceViewer.viewMode = "file";
		}
	}

	const fileExt = $derived.by(() => {
		const p = selectedPath ?? "";
		const base = p.split("/").pop() ?? "";
		const i = base.lastIndexOf(".");
		return i > 0 ? base.slice(i + 1).toLowerCase() : base.toLowerCase();
	});

	const rawLines = $derived.by(() => {
		const content = workspaceViewer.fileData?.content ?? "";
		return content ? content.split(/\r?\n/) : [];
	});

	const highlightedLines = $derived.by<string[] | null>(() => {
		void hlTick;
		const content = workspaceViewer.fileData?.content ?? "";
		if (!content || rawLines.length > 2500) return null;
		const res = highlightCode(content, fileExt);
		if (!res || res === "wait") return null;
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

	// Flattened diff rows so single-line AND multi-line range selection work identically in Diff view.
	interface FlatDiffItem {
		kind: "hunk" | "line";
		key: string;
		header?: string;
		line?: DiffLine;
		selectableIdx?: number;
		lineNum?: number;
	}

	const flatDiff = $derived.by<{ items: FlatDiffItem[]; lines: { lineNum: number; text: string }[] }>(() => {
		const diff = workspaceViewer.diffData;
		if (!diff) return { items: [], lines: [] };
		const items: FlatDiffItem[] = [];
		const lines: { lineNum: number; text: string }[] = [];
		for (let hi = 0; hi < diff.hunks.length; hi++) {
			const hunk = diff.hunks[hi]!;
			items.push({ kind: "hunk", key: `h:${hi}:${hunk.header}`, header: hunk.header });
			for (let li = 0; li < hunk.lines.length; li++) {
				const dl = hunk.lines[li]!;
				if (dl.type === "meta") {
					items.push({ kind: "line", key: `d:${hi}:${li}`, line: dl });
				} else {
					const idx = lines.length;
					const lineNum = dl.newLine ?? dl.oldLine ?? 1;
					lines.push({ lineNum, text: dl.text });
					items.push({ kind: "line", key: `d:${hi}:${li}`, line: dl, selectableIdx: idx, lineNum });
				}
			}
		}
		return { items, lines };
	});

	// --- Range & file-level comment state ---
	type CommentSelection =
		| { kind: "file"; path: string }
		| { kind: "lines"; mode: "file" | "diff"; path: string; anchorIdx: number; focusIdx: number };

	let selection = $state<CommentSelection | null>(null);
	let draggingRange = $state(false);
	let commentText = $state("");
	let sending = $state(false);

	const lineRange = $derived.by(() => {
		if (!selection || selection.kind !== "lines") return null;
		const startIdx = Math.min(selection.anchorIdx, selection.focusIdx);
		const endIdx = Math.max(selection.anchorIdx, selection.focusIdx);
		if (selection.mode === "file") {
			const startLine = startIdx + 1;
			const endLine = endIdx + 1;
			const lines = rawLines.slice(startIdx, endIdx + 1);
			return { mode: "file" as const, path: selection.path, startIdx, endIdx, startLine, endLine, lines };
		}
		const slice = flatDiff.lines.slice(startIdx, endIdx + 1);
		if (slice.length === 0) return null;
		const nums = slice.map((x) => x.lineNum);
		return {
			mode: "diff" as const,
			path: selection.path,
			startIdx,
			endIdx,
			startLine: Math.min(...nums),
			endLine: Math.max(...nums),
			lines: slice.map((x) => x.text),
		};
	});

	// Reset selection when switching files or view modes.
	$effect(() => {
		void selectedPath;
		void activeModeId;
		selection = null;
		draggingRange = false;
		commentText = "";
	});

	// Finish drag-selection cleanly on window pointerup.
	$effect(() => {
		if (!draggingRange) return;
		const onUp = () => {
			draggingRange = false;
			requestAnimationFrame(() => {
				document.querySelector<HTMLTextAreaElement>('[data-part="workspace-file-pane"] textarea.cta')?.focus();
			});
		};
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		return () => {
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
	});

	function onLinePointerDown(e: PointerEvent, mode: "file" | "diff", idx: number) {
		if (e.button !== 0 || !selectedPath) return;
		e.preventDefault();
		if (e.shiftKey && selection?.kind === "lines" && selection.mode === mode && selection.path === selectedPath) {
			selection = { ...selection, focusIdx: idx };
			requestAnimationFrame(() => {
				document.querySelector<HTMLTextAreaElement>('[data-part="workspace-file-pane"] textarea.cta')?.focus();
			});
			return;
		}
		// Clicking the exact same single selected line toggles the comment box closed.
		if (
			!e.shiftKey &&
			selection?.kind === "lines" &&
			selection.mode === mode &&
			selection.path === selectedPath &&
			selection.anchorIdx === idx &&
			selection.focusIdx === idx
		) {
			selection = null;
			commentText = "";
			return;
		}
		selection = { kind: "lines", mode, path: selectedPath, anchorIdx: idx, focusIdx: idx };
		commentText = "";
		draggingRange = true;
	}

	function onLinePointerEnter(mode: "file" | "diff", idx: number) {
		if (!draggingRange || !selection || selection.kind !== "lines" || selection.mode !== mode) return;
		if (selection.focusIdx !== idx) {
			selection = { ...selection, focusIdx: idx };
		}
	}

	function onLineKeyClick(e: KeyboardEvent, mode: "file" | "diff", idx: number) {
		if (e.key !== "Enter" && e.key !== " ") return;
		if (!selectedPath) return;
		e.preventDefault();
		if (e.shiftKey && selection?.kind === "lines" && selection.mode === mode && selection.path === selectedPath) {
			selection = { ...selection, focusIdx: idx };
		} else {
			selection = { kind: "lines", mode, path: selectedPath, anchorIdx: idx, focusIdx: idx };
			commentText = "";
		}
		requestAnimationFrame(() => {
			document.querySelector<HTMLTextAreaElement>('[data-part="workspace-file-pane"] textarea.cta')?.focus();
		});
	}

	function toggleFileComment() {
		if (!selectedPath) return;
		if (selection?.kind === "file" && selection.path === selectedPath) {
			selection = null;
			commentText = "";
			return;
		}
		selection = { kind: "file", path: selectedPath };
		commentText = "";
		requestAnimationFrame(() => {
			document.querySelector<HTMLTextAreaElement>('[data-part="workspace-file-pane"] textarea.cta')?.focus();
		});
	}

	function commentHeaderLabel(): string {
		if (!selection) return "";
		if (selection.kind === "file") return selection.path;
		if (!lineRange) return selection.path;
		if (lineRange.startLine === lineRange.endLine) return `${lineRange.path}:${lineRange.startLine}`;
		const count = lineRange.endIdx - lineRange.startIdx + 1;
		return `${lineRange.path}:${lineRange.startLine}-${lineRange.endLine} (${t("{n}줄", { n: count })})`;
	}

	function formatCommentText(note: string): string {
		const trimmed = note.trim();
		if (!selection) return trimmed;
		if (selection.kind === "file") {
			const ref = `\`${selection.path}\``;
			return trimmed ? `${ref} — ${trimmed}` : `${ref} `;
		}
		if (!lineRange) return trimmed;

		if (lineRange.startLine === lineRange.endLine && lineRange.lines.length === 1) {
			const ref = `\`${lineRange.path}:${lineRange.startLine}\``;
			const snippet = (lineRange.lines[0] ?? "").trim().slice(0, 140);
			const code = snippet ? ` (\`${snippet.replace(/`/g, "'")}\`)` : "";
			return trimmed ? `${ref}${code} — ${trimmed}` : `${ref}${code} `;
		}

		const count = lineRange.endIdx - lineRange.startIdx + 1;
		const loc = `\`${lineRange.path}:${lineRange.startLine}-${lineRange.endLine}\``;
		const joined = lineRange.lines.join("\n").trimEnd();
		const head = trimmed ? `${loc} — ${trimmed}` : `${loc} (${t("{n}줄", { n: count })})`;
		if (joined && lineRange.lines.length <= 10 && joined.length <= 600 && !joined.includes("```")) {
			return `${head}\n\`\`\`${fileExt}\n${joined}\n\`\`\``;
		}
		return trimmed ? `${loc} (${t("{n}줄", { n: count })}) — ${trimmed}` : `${loc} `;
	}

	function insertToComposer() {
		if (!selection || !sessionId) return;
		const formatted = formatCommentText(commentText);
		app.insertText = { paneId: sessionId, text: formatted };
		selection = null;
		commentText = "";
		// Switch back from the file tab to the chat tab and focus its composer.
		workspaceViewer.deactivateFile();
		app.toast(t("입력창에 추가했습니다"), "ok", sessionId);
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const pane = document.querySelector(`[data-pane="${CSS.escape(sessionId)}"]`);
				const el = pane?.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
				if (el) {
					el.focus();
					el.setSelectionRange(el.value.length, el.value.length);
				}
			});
		});
	}

	async function sendNow() {
		if (!selection || !sessionId || !commentText.trim()) return;
		sending = true;
		try {
			const formatted = formatCommentText(commentText);
			if (app.running[sessionId]) await app.queue(formatted, [], sessionId);
			else await app.send(formatted, [], sessionId);
			selection = null;
			commentText = "";
		} finally {
			sending = false;
		}
	}

	function onCommentKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			selection = null;
			commentText = "";
		} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (commentText.trim()) void sendNow();
			else insertToComposer();
		} else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			insertToComposer();
		}
	}

	async function copyFileText() {
		const txt = workspaceViewer.fileData?.content;
		if (!txt) return;
		if (await copyText(txt)) {
			copied = true;
			setTimeout(() => (copied = false), 1400);
		}
	}

	async function downloadCurrentFile() {
		const path = selectedPath;
		const sid = sessionId;
		const api = app.api;
		if (!path || !sid || !api || saving) return;
		saving = true;
		let fullUrl: string | null = null;
		try {
			const full = await api.fetchFile(sid, path);
			fullUrl = URL.createObjectURL(full);
			await saveFile(fullUrl, fileName || path);
		} catch (e) {
			app.toast(`${t("저장하지 못했습니다")}: ${errorText(e)}`, "error");
		} finally {
			if (fullUrl) URL.revokeObjectURL(fullUrl);
			saving = false;
		}
	}

	const displaySize = $derived(mediaSize ?? workspaceViewer.fileData?.size);
</script>

{#snippet inlineCommentBox(showRangeHint: boolean)}
	<div class="cbox">
		<div class="cbox-in">
			<div class="chead">
				<span class="cloc mono">{commentHeaderLabel()}</span>
				<span class="chint">
					{showRangeHint
						? t("Shift+클릭·드래그로 범위 선택 · Enter 입력창에 넣기 · Ctrl+Enter 바로 보내기")
						: t("Enter 입력창에 넣기 · Ctrl+Enter 바로 보내기")}
				</span>
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
				<Button size="sm" variant="default" onclick={() => ((selection = null), (commentText = ""))}>{t("취소")}</Button>
			</div>
		</div>
	</div>
{/snippet}

<section class="fpane" data-part="workspace-file-pane" aria-label={selectedPath ?? t("파일 뷰어")}>
	{#if selectedPath}
		<div class="fbar">
			<div class="fmeta">
				<span class="fpath mono" title={selectedPath}>{selectedPath}</span>
				{#if imgDims}
					<span class="fsub mono">{imgDims.w}×{imgDims.h}</span>
				{/if}
				{#if displaySize !== undefined}
					<span class="fsub mono">{sizeLabel(displaySize)}</span>
				{/if}
				{#if selectedChange && (selectedChange.additions > 0 || selectedChange.deletions > 0)}
					<span class="cstat mono">
						{#if selectedChange.additions > 0}<span class="add">+{selectedChange.additions}</span>{/if}
						{#if selectedChange.deletions > 0}<span class="del">-{selectedChange.deletions}</span>{/if}
					</span>
				{/if}
			</div>
			<div class="ftools">
				{#if modeOptions.length > 0}
					<div class="mtoggle">
						<Segmented
							label={t("보기 모드")}
							options={modeOptions}
							value={activeModeId}
							size="sm"
							full={false}
							onchange={onModeChange}
						/>
					</div>
				{/if}
				<IconButton
					icon="chat"
					size="sm"
					label={t("이 파일에 코멘트")}
					tip
					class={{ on: selection?.kind === "file" }}
					onclick={toggleFileComment}
				/>
				{#if workspaceViewer.fileData && !workspaceViewer.fileData.binary && !isMediaKind}
					<IconButton icon={copied ? "check" : "copy"} size="sm" label={t("복사")} tip onclick={copyFileText} />
				{/if}
				<IconButton icon="download" size="sm" label={t("저장")} tip disabled={saving} onclick={downloadCurrentFile} />
				<IconButton
					icon="retry"
					size="sm"
					label={t("새로고침")}
					onclick={() => void workspaceViewer.selectFile(selectedPath, workspaceViewer.viewMode)}
				/>
			</div>
		</div>

		{#if selection?.kind === "file"}
			{@render inlineCommentBox(false)}
		{/if}

		<div class="cscroll" class:media-bg={isMediaKind || showRichPreview}>
			{#if workspaceViewer.viewMode === "diff" && selectedChange}
				{#if !workspaceViewer.diffData}
					<div class="pad"><EmptyState loading compact>{t("Diff를 불러오는 중…")}</EmptyState></div>
				{:else if workspaceViewer.diffData.binary}
					<div class="pad"><EmptyState compact>{t("바이너리 파일은 Diff로 표시할 수 없습니다.")}</EmptyState></div>
				{:else if workspaceViewer.diffData.hunks.length === 0}
					<div class="pad"><EmptyState compact>{t("표시할 변경 라인이 없습니다.")}</EmptyState></div>
				{:else}
					<div class="lines mono" class:selecting={draggingRange}>
						{#each flatDiff.items as item (item.key)}
							{#if item.kind === "hunk"}
								<div class="hunk">{item.header}</div>
							{:else if item.line}
								{@const dl = item.line}
								{@const sidx = item.selectableIdx}
								{@const inRange =
									sidx !== undefined &&
									lineRange?.mode === "diff" &&
									sidx >= lineRange.startIdx &&
									sidx <= lineRange.endIdx}
								{@const isEnd = sidx !== undefined && lineRange?.mode === "diff" && sidx === lineRange.endIdx}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="row d-{dl.type}"
									class:picked={inRange}
									onpointerenter={() => sidx !== undefined && onLinePointerEnter("diff", sidx)}
								>
									<span class="ln">{dl.oldLine ?? ""}</span>
									<span class="ln">{dl.newLine ?? ""}</span>
									{#if sidx !== undefined}
										<button
											type="button"
											class="plus"
											title={t("이 줄에 코멘트 달기")}
											aria-label={t("이 줄에 코멘트 달기")}
											onpointerdown={(e) => onLinePointerDown(e, "diff", sidx)}
											onkeydown={(e) => onLineKeyClick(e, "diff", sidx)}
										>+</button>
									{:else}
										<span class="plus-sp"></span>
									{/if}
									<span class="txt">{dl.type === "add" ? "+" : dl.type === "del" ? "-" : " "}{dl.text}</span>
								</div>
								{#if isEnd}
									{@render inlineCommentBox(true)}
								{/if}
							{/if}
						{/each}
					</div>
				{/if}
			{:else if isMediaKind}
				{#if mediaLoading}
					<div class="pad"><EmptyState loading compact>{t("파일을 불러오는 중…")}</EmptyState></div>
				{:else if mediaError}
					<div class="pad"><Notice tone="danger" size="sm">{mediaError}</Notice></div>
				{:else if kind === "image" && mediaUrl}
					<div class="media-wrap">
						<button
							type="button"
							class="pic"
							onclick={() => app.openImage([{ src: mediaUrl!, mimeType: mediaMime || "image/png" }])}
							aria-label={t("이미지 크게 보기")}
						>
							<img
								src={mediaUrl}
								alt={fileName}
								onload={(e) => {
									const el = e.currentTarget as HTMLImageElement;
									if (el.naturalWidth && el.naturalHeight) imgDims = { w: el.naturalWidth, h: el.naturalHeight };
								}}
							/>
						</button>
					</div>
				{:else if kind === "pdf" && mediaUrl}
					<iframe class="pdf" src={mediaUrl} title={fileName}></iframe>
				{:else if (kind === "audio" || kind === "video") && mediaFailed}
					<div class="pad">
						<EmptyState compact>{t("재생할 수 없는 파일입니다. 파일이 깨졌거나 이 기기가 지원하지 않는 코덱일 수 있습니다. 저장해서 열어 보세요.")}</EmptyState>
					</div>
				{:else if kind === "audio" && mediaUrl}
					<div class="media-wrap">
						<!-- svelte-ignore a11y_media_has_caption -->
						<audio class="audio" src={mediaUrl} controls preload="metadata" onerror={() => (mediaFailed = true)}></audio>
					</div>
				{:else if kind === "video" && mediaUrl}
					<div class="media-wrap">
						<div class="videohost" bind:this={videoHost}></div>
					</div>
				{/if}
			{:else if workspaceViewer.fileLoading && !workspaceViewer.fileData}
				<div class="pad"><EmptyState loading compact>{t("파일을 불러오는 중…")}</EmptyState></div>
			{:else if workspaceViewer.fileError}
				<div class="pad">
					<Notice tone="danger" size="sm" onretry={() => selectedPath && workspaceViewer.loadFile(selectedPath)}>
						{workspaceViewer.fileError}
					</Notice>
				</div>
			{:else if workspaceViewer.fileData?.binary}
				<div class="bcard-wrap">
					<div class="bcard">
						<span class="bext mono">{extOf(fileName)}</span>
						<span class="bname mono">{fileName}</span>
						{#if displaySize !== undefined}<span class="bsize mono">{sizeLabel(displaySize)}</span>{/if}
						<div class="bact">
							<Button size="sm" variant="primary" disabled={saving} onclick={downloadCurrentFile}>{t("저장")}</Button>
							<Button size="sm" variant="default" onclick={toggleFileComment}>{t("이 파일에 코멘트")}</Button>
						</div>
					</div>
				</div>
			{:else if workspaceViewer.fileData}
				{#if workspaceViewer.fileData.truncated}
					<div class="trunc">{t("파일이 커서 앞부분만 표시합니다 (읽기 전용).")}</div>
				{/if}
				{#if kind === "markdown" && showRichPreview}
					<div class="md-wrap">
						<Markdown text={workspaceViewer.fileData.content} sessionId={sessionId ?? undefined} />
					</div>
				{:else if kind === "html" && showRichPreview && htmlUrl}
					<!-- fully sandboxed: no scripts, no same-origin, no forms, no navigation -->
					<iframe class="html" src={htmlUrl} sandbox="" referrerpolicy="no-referrer" title={fileName}></iframe>
				{:else if table}
					<div class="tablewrap">
						<table>
							<tbody>
								{#each table.rows as r, ri (ri)}
									<tr>
										{#each r as c, ci (ci)}
											{#if ri === 0}<th>{c}</th>{:else}<td>{c}</td>{/if}
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<div class="lines mono" class:selecting={draggingRange}>
						{#each rawLines as line, idx (idx)}
							{@const ln = idx + 1}
							{@const html = highlightedLines?.[idx]}
							{@const inRange =
								lineRange?.mode === "file" && idx >= lineRange.startIdx && idx <= lineRange.endIdx}
							{@const isEnd = lineRange?.mode === "file" && idx === lineRange.endIdx}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="row"
								class:picked={inRange}
								onpointerenter={() => onLinePointerEnter("file", idx)}
							>
								<button
									type="button"
									class="lnbtn"
									title={t("{line}번 줄에 코멘트 달기", { line: ln })}
									onpointerdown={(e) => onLinePointerDown(e, "file", idx)}
									onkeydown={(e) => onLineKeyClick(e, "file", idx)}
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
							{#if isEnd}
								{@render inlineCommentBox(true)}
							{/if}
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</section>

<style>
	.fpane {
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
	.fmeta {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.fpath {
		min-width: 0;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 20px;
	}
	.fsub {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		flex: none;
		line-height: 16px;
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
	.ftools {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: none;
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
	.cscroll.media-bg {
		background: var(--bg);
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
	.lines.selecting {
		user-select: none;
		-webkit-user-select: none;
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
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.row.d-add {
		background: var(--ok-soft);
	}
	.row.d-del {
		background: var(--danger-soft);
	}
	.row.d-add.picked,
	.row.d-del.picked {
		background: var(--accent-soft);
		box-shadow: inset 2px 0 0 var(--accent);
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
		.row:hover .lplus,
		.lnbtn:hover .lplus {
			opacity: 1;
		}
	}
	.lnbtn:focus-visible .lplus,
	.row.picked .lplus {
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
	.plus:focus-visible,
	.row.picked .plus {
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

	/* Rich media & document views */
	.media-wrap {
		min-height: 100%;
		display: grid;
		place-items: center;
		padding: 24px;
	}
	.pic {
		display: inline-flex;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-side);
		overflow: hidden;
		cursor: zoom-in;
		max-width: 100%;
	}
	.pic img {
		display: block;
		max-width: 100%;
		max-height: calc(var(--dvh, 100vh) - 180px);
		object-fit: contain;
	}
	.pdf,
	.html {
		display: block;
		width: 100%;
		height: 100%;
		min-height: 480px;
		border: 0;
		background: var(--bg);
	}
	.audio {
		width: min(480px, 100%);
	}
	.videohost {
		width: min(960px, 100%);
	}
	.videohost :global(video) {
		max-width: 100%;
		max-height: calc(var(--dvh, 100vh) - 180px);
		border-radius: var(--radius-sm);
	}
	.md-wrap {
		max-width: 820px;
		margin: 0 auto;
		padding: 20px 24px 32px;
	}
	.tablewrap {
		padding: 12px 16px;
		overflow: auto;
	}
	.tablewrap table {
		border-collapse: collapse;
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.tablewrap th,
	.tablewrap td {
		padding: 4px 12px;
		border: 1px solid var(--border);
		text-align: left;
		white-space: nowrap;
	}
	.tablewrap th {
		background: var(--bg-side);
		font-weight: 600;
	}
	.bcard-wrap {
		min-height: 100%;
		display: grid;
		place-items: center;
		padding: 24px;
	}
	.bcard {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 24px 32px;
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
		background: var(--bg-side);
		max-width: 420px;
		text-align: center;
	}
	.bext {
		padding: 4px 8px;
		border-radius: var(--radius-xs);
		background: var(--bg-active);
		color: var(--text-dim);
		font-size: var(--fs-2xs);
		font-weight: 600;
		line-height: 16px;
	}
	.bname {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
		word-break: break-all;
		line-height: 20px;
	}
	.bsize {
		font-size: var(--fs-xs);
		color: var(--text-faint);
		line-height: 16px;
	}
	.bact {
		display: flex;
		gap: 8px;
		padding-top: 8px;
	}

	/* Inline comment composer */
	.cbox {
		position: sticky;
		left: 0;
		padding: 8px 16px;
		background: var(--bg-elev);
		border-top: 1px solid var(--border-strong);
		border-bottom: 1px solid var(--border-strong);
		font-family: var(--font);
	}
	.cbox-in {
		max-width: 680px;
		display: flex;
		flex-direction: column;
		gap: 8px;
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
</style>
