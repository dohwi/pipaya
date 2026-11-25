<script lang="ts">
	import DOMPurify from "dompurify";
	import { onDestroy, onMount, untrack } from "svelte";
	import { errorText } from "../../lib/api";
	import { copyText } from "../../lib/clipboard";
	import { highlightCode, onHighlightReady } from "../../lib/code-highlight";
	import { baseName, extOf, parseTable, previewKind, sizeLabel, type PreviewKind } from "../../lib/files";
	import { t } from "../../lib/i18n";
	import { surfaceIn, surfaceOut } from "../../lib/motion";
	import { saveFile } from "../../lib/save-file";
	import { app } from "../../lib/store.svelte";
	import { closeVideoView, videoPlayer } from "../../lib/video-view";
	import { buildFullFileDiff, formatLineSpec, type FullDiffRow } from "../../lib/workspace-edits";
	import { workspaceViewer } from "../../lib/workspace-viewer.svelte";
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

	// Only treat `fileData` as valid for the currently active tab (prevents stale content from another tab).
	const currentFileData = $derived(
		workspaceViewer.fileData && workspaceViewer.fileData.path === selectedPath ? workspaceViewer.fileData : null,
	);

	// Syntax highlight readiness tick (re-runs derived highlighting when a lazy grammar finishes loading).
	let hlTick = $state(0);
	onMount(() => onHighlightReady(() => hlTick++));

	// Preview mode for rich text-backed formats (markdown, html, csv/tsv): preview vs source.
	let richPreview = $state(true);

	// Direct inline edit state (triggered by double-clicking code lines or clicking the edit icon).
	let editing = $state(false);
	let editDraft = $state("");
	let editSaving = $state(false);
	let editArea = $state<HTMLTextAreaElement>();
	let editGutter = $state<HTMLElement>();
	const editDirty = $derived(editing && currentFileData !== null && editDraft !== currentFileData.content);
	const editLineCount = $derived(editing ? (editDraft ? editDraft.split(/\r?\n/).length : 1) : 0);

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
		!editing &&
			hasRichPreview &&
			richPreview &&
			workspaceViewer.viewMode === "file" &&
			!!currentFileData &&
			!currentFileData.binary,
	);
	const canEditText = $derived(
		!isMediaKind && !!currentFileData && !currentFileData.binary && !currentFileData.truncated,
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
		editing = false;
		editDraft = "";

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
				mediaSize = k === "image" ? (currentFileData?.size ?? blob.size) : blob.size;
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
		if (kind !== "html" || !showRichPreview || !currentFileData?.content) return;
		const blobUrl = URL.createObjectURL(new Blob([currentFileData.content], { type: "text/html;charset=utf-8" }));
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
		kind === "table" && showRichPreview && currentFileData?.content
			? parseTable(currentFileData.content, /\.tsv$/i.test(fileName) ? "\t" : ",")
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
		editing = false;
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
		const content = currentFileData?.content ?? "";
		return content ? content.split(/\r?\n/) : [];
	});

	const highlightedLines = $derived.by<string[] | null>(() => {
		void hlTick;
		const content = currentFileData?.content ?? "";
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

	// Full-file inline diff: merges changed hunks into the complete file so changed files always show full context.
	const fullDiffRows = $derived.by<FullDiffRow[]>(() => {
		const diff = workspaceViewer.diffData;
		if (!diff || diff.binary || diff.path !== selectedPath) return [];
		const content = currentFileData && !currentFileData.binary ? currentFileData.content : null;
		return buildFullFileDiff(content, diff.hunks);
	});

	const highlightedDiffLines = $derived.by<string[] | null>(() => {
		void hlTick;
		if (fullDiffRows.length === 0 || fullDiffRows.length > 2500) return null;
		const sample = currentFileData?.content ?? fullDiffRows.map((r) => r.text).join("\n");
		const probe = highlightCode(sample.slice(0, 4000), fileExt);
		if (!probe || probe === "wait") return null;
		const out: string[] = [];
		for (const r of fullDiffRows) {
			if (!r.text) {
				out.push("");
				continue;
			}
			const h = highlightCode(r.text, fileExt);
			out.push(h && h !== "wait" ? DOMPurify.sanitize(h, { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"] }) : "");
		}
		return out;
	});

	const changeAnchors = $derived.by<number[]>(() => {
		const out: number[] = [];
		for (let i = 0; i < fullDiffRows.length; i++) {
			if (fullDiffRows[i]?.changeStart) out.push(i);
		}
		return out;
	});

	let scrollHost = $state<HTMLElement>();
	let activeChangeIdx = $state(0);
	let lastAutoScrollKey = "";

	function jumpToChange(idx: number) {
		if (changeAnchors.length === 0 || !scrollHost) return;
		const wrapped = ((idx % changeAnchors.length) + changeAnchors.length) % changeAnchors.length;
		activeChangeIdx = wrapped;
		const rowIdx = changeAnchors[wrapped]!;
		const el = scrollHost.querySelector<HTMLElement>(`[data-drow="${rowIdx}"]`);
		el?.scrollIntoView({ block: "center", behavior: "smooth" });
	}

	// Automatically scroll to the first changed line once when opening a changed file in full-file diff mode.
	$effect(() => {
		const path = selectedPath;
		const isDiff = workspaceViewer.viewMode === "diff" && !!selectedChange;
		const first = changeAnchors[0];
		const host = scrollHost;
		if (!isDiff || !path || first === undefined || !host) return;
		const key = `${path}:${fullDiffRows.length}:${first}`;
		if (lastAutoScrollKey === key) return;
		lastAutoScrollKey = key;
		activeChangeIdx = 0;
		requestAnimationFrame(() => {
			host.querySelector<HTMLElement>(`[data-drow="${first}"]`)?.scrollIntoView({ block: "center" });
		});
	});

	// --- Direct double-click editing ---
	function startEdit(focusLine?: number) {
		if (!canEditText || !currentFileData) return;
		clearSelection();
		editDraft = currentFileData.content;
		editing = true;
		requestAnimationFrame(() => {
			const ta = editArea;
			if (!ta) return;
			ta.focus();
			if (focusLine && focusLine > 1) {
				const lines = editDraft.split(/\r?\n/);
				let offset = 0;
				for (let i = 0; i < Math.min(focusLine - 1, lines.length); i++) {
					offset += (lines[i]?.length ?? 0) + 1;
				}
				ta.setSelectionRange(offset, offset);
				ta.scrollTop = Math.max(0, (focusLine - 6) * 20);
				if (editGutter) editGutter.scrollTop = ta.scrollTop;
			}
		});
	}

	function cancelEdit() {
		editing = false;
		editDraft = "";
	}

	async function commitEdit() {
		if (!editing || !selectedPath || editSaving) return;
		editSaving = true;
		try {
			const res = await workspaceViewer.saveFile(selectedPath, editDraft);
			if (res.ok) {
				editing = false;
				app.toast(t("저장했습니다"), "ok", sessionId ?? undefined);
			} else {
				app.toast(`${t("저장하지 못했습니다")}: ${res.error}`, "error", sessionId ?? undefined);
			}
		} finally {
			editSaving = false;
		}
	}

	function onEditorKey(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
			e.preventDefault();
			void commitEdit();
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			cancelEdit();
			return;
		}
		if (e.key === "Tab" && editArea) {
			e.preventDefault();
			const start = editArea.selectionStart;
			const end = editArea.selectionEnd;
			editDraft = `${editDraft.slice(0, start)}\t${editDraft.slice(end)}`;
			requestAnimationFrame(() => {
				editArea?.setSelectionRange(start + 1, start + 1);
			});
		}
	}

	// --- Multi-line / range / Ctrl-click / text-drag selection + Floating comment popover ---
	type CommentSelection =
		| { kind: "file"; path: string }
		| { kind: "lines"; mode: "file" | "diff"; path: string; indices: number[]; anchorIdx: number };

	let selection = $state<CommentSelection | null>(null);
	/** True when the floating popover is expanded to full comment box; false shows compact floating action pill after text drag. */
	let popoverOpen = $state(false);
	let popoverPos = $state<{ top: number; left: number }>({ top: 120, left: 24 });
	let draggingRange = $state(false);
	let dragBaseIndices = $state<number[]>([]);
	let commentText = $state("");
	let sending = $state(false);
	let popoverEl = $state<HTMLElement>();
	let draggingPopover = $state(false);

	function startPopoverDrag(e: PointerEvent) {
		if (e.button !== 0 || !popoverEl) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest("button, textarea, input")) return;
		e.preventDefault();
		draggingPopover = true;
		const rect = popoverEl.getBoundingClientRect();
		const offsetX = e.clientX - rect.left;
		const offsetY = e.clientY - rect.top;
		const onMove = (ev: PointerEvent) => {
			const w = popoverEl?.offsetWidth || rect.width;
			const h = popoverEl?.offsetHeight || rect.height;
			const margin = 8;
			const left = Math.max(margin, Math.min(ev.clientX - offsetX, window.innerWidth - w - margin));
			const top = Math.max(margin, Math.min(ev.clientY - offsetY, window.innerHeight - h - margin));
			popoverPos = { top: Math.round(top), left: Math.round(left) };
		};
		const onUp = () => {
			draggingPopover = false;
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	function clearSelection() {
		selection = null;
		popoverOpen = false;
		draggingRange = false;
		dragBaseIndices = [];
		commentText = "";
	}

	/** Place the floating popover/pill right below an anchor rect, clamped safely within the viewport. */
	function positionBelow(rect: DOMRect, estimatedW = 460, estimatedH = 190, align: "left" | "right" = "left") {
		if (typeof window === "undefined") return;
		const margin = 12;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const width = Math.min(estimatedW, vw - margin * 2);
		const rawLeft = vw <= 600 ? (vw - width) / 2 : align === "right" ? rect.right - width : rect.left;
		const left = Math.max(margin, Math.min(rawLeft, vw - width - margin));
		let top = rect.bottom + 8;
		if (top + estimatedH > vh - margin) {
			top = Math.max(margin, rect.top - estimatedH - 8);
		}
		popoverPos = { top: Math.round(top), left: Math.round(left) };
	}

	function positionBelowRow(mode: "file" | "diff", idx: number) {
		const attr = mode === "diff" ? `[data-drow="${idx}"]` : `[data-frow="${idx}"]`;
		const row = scrollHost?.querySelector<HTMLElement>(attr);
		if (!row) return;
		const rect = row.getBoundingClientRect();
		const paneRect = scrollHost?.getBoundingClientRect();
		const anchorLeft = Math.max(paneRect ? paneRect.left + 64 : rect.left + 64, 24);
		positionBelow(new DOMRect(anchorLeft, rect.top, rect.width, rect.height), 480, 196);
	}

	const selectedIndexSet = $derived.by(() => {
		if (!selection || selection.kind !== "lines") return new Set<number>();
		return new Set(selection.indices);
	});

	const selectedLineInfo = $derived.by(() => {
		if (!selection || selection.kind !== "lines") return null;
		const sorted = [...new Set(selection.indices)].sort((a, b) => a - b);
		if (sorted.length === 0) return null;
		if (selection.mode === "file") {
			const lineNums = sorted.map((i) => i + 1);
			const lines = sorted.map((i) => rawLines[i] ?? "");
			return {
				mode: "file" as const,
				path: selection.path,
				sorted,
				lineNums,
				spec: formatLineSpec(lineNums),
				lines,
				contiguous: sorted[sorted.length - 1]! - sorted[0]! + 1 === sorted.length,
			};
		}
		const rows = sorted.map((i) => fullDiffRows[i]).filter((r): r is FullDiffRow => !!r);
		if (rows.length === 0) return null;
		const lineNums = rows.map((r) => r.newLine ?? r.oldLine ?? 1);
		return {
			mode: "diff" as const,
			path: selection.path,
			sorted,
			lineNums,
			spec: formatLineSpec(lineNums),
			lines: rows.map((r) => r.text),
			contiguous: sorted[sorted.length - 1]! - sorted[0]! + 1 === sorted.length,
		};
	});

	// Reset selection when switching files or view modes.
	$effect(() => {
		void selectedPath;
		void activeModeId;
		clearSelection();
	});

	// Finish drag-selection on window pointerup and float the comment popover right below the end line.
	$effect(() => {
		if (!draggingRange) return;
		const onUp = () => {
			draggingRange = false;
			if (selection?.kind === "lines" && selection.indices.length > 0) {
				const last = Math.max(...selection.indices);
				popoverOpen = true;
				positionBelowRow(selection.mode, last);
				requestAnimationFrame(() => {
					popoverEl?.querySelector<HTMLTextAreaElement>("textarea.cta")?.focus();
				});
			}
		};
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		return () => {
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
	});

	// Close floating popover when clicking outside (unless clicking the left gutter or file comment trigger).
	$effect(() => {
		if (!selection) return;
		const onDocDown = (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (popoverEl?.contains(target)) return;
			if (target.closest(".lnbtn, [data-file-comment-btn]")) return;
			if (draggingRange) return;
			clearSelection();
		};
		window.addEventListener("pointerdown", onDocDown);
		return () => window.removeEventListener("pointerdown", onDocDown);
	});

	function rangeArray(a: number, b: number): number[] {
		const s = Math.min(a, b);
		const e = Math.max(a, b);
		const out: number[] = [];
		for (let i = s; i <= e; i++) out.push(i);
		return out;
	}

	function onLinePointerDown(e: PointerEvent, mode: "file" | "diff", idx: number) {
		if (e.button !== 0 || !selectedPath) return;
		e.preventDefault();
		const cur = selection?.kind === "lines" && selection.mode === mode && selection.path === selectedPath ? selection : null;

		// Ctrl/Cmd + Click: toggle individual non-contiguous lines into/out of the selection!
		if (e.ctrlKey || e.metaKey) {
			const prev = cur ? cur.indices : [];
			const next = prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx].sort((a, b) => a - b);
			if (next.length === 0) {
				clearSelection();
				return;
			}
			selection = { kind: "lines", mode, path: selectedPath, indices: next, anchorIdx: idx };
			popoverOpen = true;
			positionBelowRow(mode, idx);
			requestAnimationFrame(() => popoverEl?.querySelector<HTMLTextAreaElement>("textarea.cta")?.focus());
			return;
		}

		// Shift + Click: extend range from anchor line to clicked line!
		if (e.shiftKey && cur) {
			const next = rangeArray(cur.anchorIdx, idx);
			selection = { ...cur, indices: next };
			popoverOpen = true;
			positionBelowRow(mode, Math.max(cur.anchorIdx, idx));
			requestAnimationFrame(() => popoverEl?.querySelector<HTMLTextAreaElement>("textarea.cta")?.focus());
			return;
		}

		// Plain click on the exact same single selected line toggles closed.
		if (cur && cur.indices.length === 1 && cur.indices[0] === idx) {
			clearSelection();
			return;
		}

		selection = { kind: "lines", mode, path: selectedPath, indices: [idx], anchorIdx: idx };
		commentText = "";
		popoverOpen = false;
		dragBaseIndices = [];
		draggingRange = true;
	}

	function onLinePointerEnter(mode: "file" | "diff", idx: number) {
		if (!draggingRange || !selection || selection.kind !== "lines" || selection.mode !== mode) return;
		const next = [...new Set([...dragBaseIndices, ...rangeArray(selection.anchorIdx, idx)])].sort((a, b) => a - b);
		selection = { ...selection, indices: next };
	}

	function onLineKeyClick(e: KeyboardEvent, mode: "file" | "diff", idx: number) {
		if (e.key !== "Enter" && e.key !== " ") return;
		if (!selectedPath) return;
		e.preventDefault();
		const cur = selection?.kind === "lines" && selection.mode === mode && selection.path === selectedPath ? selection : null;
		if (e.shiftKey && cur) {
			selection = { ...cur, indices: rangeArray(cur.anchorIdx, idx) };
		} else {
			selection = { kind: "lines", mode, path: selectedPath, indices: [idx], anchorIdx: idx };
			commentText = "";
		}
		popoverOpen = true;
		positionBelowRow(mode, idx);
		requestAnimationFrame(() => popoverEl?.querySelector<HTMLTextAreaElement>("textarea.cta")?.focus());
	}

	function toggleFileComment(e: MouseEvent) {
		if (!selectedPath) return;
		if (selection?.kind === "file" && selection.path === selectedPath) {
			clearSelection();
			return;
		}
		selection = { kind: "file", path: selectedPath };
		commentText = "";
		popoverOpen = true;
		const btn = e.currentTarget as HTMLElement | null;
		if (btn) positionBelow(btn.getBoundingClientRect(), 460, 186, "right");
		requestAnimationFrame(() => popoverEl?.querySelector<HTMLTextAreaElement>("textarea.cta")?.focus());
	}

	const commentParts = $derived.by<{ path: string; suffix: string }>(() => {
		if (!selection) return { path: "", suffix: "" };
		if (selection.kind === "file") return { path: selection.path, suffix: "" };
		if (!selectedLineInfo) return { path: selection.path, suffix: "" };
		const count = selectedLineInfo.sorted.length;
		if (count === 1) return { path: selectedLineInfo.path, suffix: `:${selectedLineInfo.spec}` };
		return { path: selectedLineInfo.path, suffix: `:${selectedLineInfo.spec} (${t("{n}줄", { n: count })})` };
	});

	function formatCommentText(note: string): string {
		const trimmed = note.trim();
		if (!selection) return trimmed;
		if (selection.kind === "file") {
			const ref = `\`${selection.path}\``;
			return trimmed ? `${ref} — ${trimmed}` : `${ref} `;
		}
		if (!selectedLineInfo) return trimmed;

		if (selectedLineInfo.sorted.length === 1) {
			const ref = `\`${selectedLineInfo.path}:${selectedLineInfo.spec}\``;
			const snippet = (selectedLineInfo.lines[0] ?? "").trim().slice(0, 140);
			const code = snippet ? ` (\`${snippet.replace(/`/g, "'")}\`)` : "";
			return trimmed ? `${ref}${code} — ${trimmed}` : `${ref}${code} `;
		}

		const count = selectedLineInfo.sorted.length;
		const loc = `\`${selectedLineInfo.path}:${selectedLineInfo.spec}\``;
		const joined = selectedLineInfo.lines.join("\n").trimEnd();
		const head = trimmed ? `${loc} — ${trimmed}` : `${loc} (${t("{n}줄", { n: count })})`;
		if (joined && selectedLineInfo.lines.length <= 12 && joined.length <= 700 && !joined.includes("```")) {
			return `${head}\n\`\`\`${fileExt}\n${joined}\n\`\`\``;
		}
		return trimmed ? `${loc} (${t("{n}줄", { n: count })}) — ${trimmed}` : `${loc} `;
	}

	function insertToComposer() {
		if (!selection || !sessionId) return;
		const formatted = formatCommentText(commentText);
		app.insertText = { paneId: sessionId, text: formatted };
		clearSelection();
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
			clearSelection();
		} finally {
			sending = false;
		}
	}

	function onCommentKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			clearSelection();
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
		const txt = currentFileData?.content;
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

	const displaySize = $derived(mediaSize ?? currentFileData?.size);

	// Publish file controls & metadata to the topmost Header bar so desktop needs zero extra nav rows.
	$effect(() => {
		const path = selectedPath;
		if (!path) {
			workspaceViewer.paneControl = null;
			return;
		}
		workspaceViewer.paneControl = {
			path,
			size: displaySize,
			imgDims,
			editing,
			editDirty,
			editSaving,
			canEdit: canEditText,
			canCopy: !!currentFileData && !currentFileData.binary && !isMediaKind,
			copied,
			saving,
			fileCommentOpen: selection?.kind === "file",
			modeOptions,
			activeModeId,
			showChangeNav: workspaceViewer.viewMode === "diff" && !!selectedChange && changeAnchors.length > 1,
			changeCount: changeAnchors.length,
			activeChangeIdx,
			onModeChange,
			onStartEdit: () => startEdit(),
			onCommitEdit: () => void commitEdit(),
			onCancelEdit: cancelEdit,
			onToggleFileComment: toggleFileComment,
			onCopy: () => void copyFileText(),
			onDownload: () => void downloadCurrentFile(),
			onJumpChange: jumpToChange,
		};
	});

	onDestroy(() => {
		workspaceViewer.paneControl = null;
	});
</script>

<section class="fpane" data-part="workspace-file-pane" aria-label={selectedPath ?? t("파일 뷰어")}>
	{#if selectedPath}
		<!-- Compact action strip shown on phones (<=640px) only; on desktop all file info & controls live in the top Header -->
		<div class="mbar">
			{#if editing}
				<div class="mtools">
					<Button size="sm" variant="primary" disabled={editSaving} onclick={() => void commitEdit()}>
						{t("저장")}
					</Button>
					<Button size="sm" variant="default" disabled={editSaving} onclick={cancelEdit}>
						{t("취소")}
					</Button>
				</div>
			{:else}
				<div class="mleft">
					{#if modeOptions.length > 0}
						<Segmented
							label={t("보기 모드")}
							options={modeOptions}
							value={activeModeId}
							size="sm"
							full={false}
							onchange={onModeChange}
						/>
					{/if}
					{#if workspaceViewer.viewMode === "diff" && selectedChange && changeAnchors.length > 1}
						<div class="cnav">
							<IconButton icon="arrow-up" size="sm" label={t("이전 변경")} onclick={() => jumpToChange(activeChangeIdx - 1)} />
							<span class="cidx mono">{activeChangeIdx + 1}/{changeAnchors.length}</span>
							<IconButton icon="arrow-down" size="sm" label={t("다음 변경")} onclick={() => jumpToChange(activeChangeIdx + 1)} />
						</div>
					{/if}
				</div>
				<div class="fact">
					{#if canEditText}
						<IconButton
							icon="pencil"
							size="sm"
							label={t("직접 수정 (더블클릭)")}
							tip
							onclick={() => startEdit()}
						/>
					{/if}
					<span data-file-comment-btn="true">
						<IconButton
							icon="chat"
							size="sm"
							label={t("이 파일에 코멘트")}
							tip
							class={{ on: selection?.kind === "file" }}
							onclick={toggleFileComment}
						/>
					</span>
					{#if currentFileData && !currentFileData.binary && !isMediaKind}
						<IconButton icon={copied ? "check" : "copy"} size="sm" label={t("복사")} tip onclick={copyFileText} />
					{/if}
					<IconButton icon="download" size="sm" label={t("저장")} tip disabled={saving} onclick={downloadCurrentFile} />
				</div>
			{/if}
		</div>

		{#if editing}
			<div class="editor-wrap">
				<div class="egutter mono" bind:this={editGutter} aria-hidden="true">
					{#each Array(editLineCount) as _, i (i)}
						<div class="eln">{i + 1}</div>
					{/each}
				</div>
				<textarea
					class="earea mono"
					bind:this={editArea}
					bind:value={editDraft}
					spellcheck="false"
					onkeydown={onEditorKey}
					onscroll={() => {
						if (editGutter && editArea) editGutter.scrollTop = editArea.scrollTop;
					}}
					aria-label={selectedPath}
				></textarea>
			</div>
		{:else}
			<div class="cscroll" bind:this={scrollHost} class:media-bg={isMediaKind || showRichPreview}>
				{#if workspaceViewer.viewMode === "diff" && selectedChange}
					{#if (workspaceViewer.fileLoading && !currentFileData) || !workspaceViewer.diffData}
						<div class="pad"><EmptyState loading compact>{t("Diff를 불러오는 중…")}</EmptyState></div>
					{:else if workspaceViewer.diffData.binary}
						<div class="pad"><EmptyState compact>{t("바이너리 파일은 Diff로 표시할 수 없습니다.")}</EmptyState></div>
					{:else if fullDiffRows.length === 0}
						<div class="pad"><EmptyState compact>{t("표시할 변경 라인이 없습니다.")}</EmptyState></div>
					{:else}
						{#if currentFileData?.truncated}
							<div class="trunc">{t("파일이 커서 앞부분만 표시합니다 (읽기 전용).")}</div>
						{/if}
						<div class="lines mono" class:selecting={draggingRange}>
							{#each fullDiffRows as dl, idx (idx)}
								{@const html = highlightedDiffLines?.[idx]}
								{@const inRange = selection?.kind === "lines" && selection.mode === "diff" && selectedIndexSet.has(idx)}
								{@const ln = dl.newLine ?? dl.oldLine ?? idx + 1}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="row d-{dl.type}"
									class:picked={inRange}
									data-drow={idx}
									data-change-start={dl.changeStart ? "true" : undefined}
									onpointerenter={() => onLinePointerEnter("diff", idx)}
									ondblclick={() => canEditText && startEdit(ln)}
								>
									<button
										type="button"
										class="lnbtn diff-ln"
										title={t("{line}번 줄에 코멘트 달기", { line: ln })}
										onpointerdown={(e) => onLinePointerDown(e, "diff", idx)}
										onkeydown={(e) => onLineKeyClick(e, "diff", idx)}
									>
										<span class="lplus" aria-hidden="true">+</span>
										<span class="dln">{dl.oldLine ?? ""}</span>
										<span class="dln">{dl.newLine ?? ""}</span>
									</button>
									<span class="dsig" aria-hidden="true">{dl.type === "add" ? "+" : dl.type === "del" ? "-" : " "}</span>
									{#if html}
										<span class="txt">{@html html}</span>
									{:else}
										<span class="txt">{dl.text}</span>
									{/if}
								</div>
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
				{:else if workspaceViewer.fileLoading && !currentFileData}
					<div class="pad"><EmptyState loading compact>{t("파일을 불러오는 중…")}</EmptyState></div>
				{:else if workspaceViewer.fileError}
					<div class="pad">
						<Notice tone="danger" size="sm" onretry={() => selectedPath && workspaceViewer.loadFile(selectedPath)}>
							{workspaceViewer.fileError}
						</Notice>
					</div>
				{:else if currentFileData?.binary}
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
				{:else if currentFileData}
					{#if currentFileData.truncated}
						<div class="trunc">{t("파일이 커서 앞부분만 표시합니다 (읽기 전용).")}</div>
					{/if}
					{#if kind === "markdown" && showRichPreview}
						<div class="md-wrap">
							<Markdown text={currentFileData.content} sessionId={sessionId ?? undefined} />
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
								{@const inRange = selection?.kind === "lines" && selection.mode === "file" && selectedIndexSet.has(idx)}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="row"
									class:picked={inRange}
									data-frow={idx}
									onpointerenter={() => onLinePointerEnter("file", idx)}
									ondblclick={() => canEditText && startEdit(ln)}
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
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	{/if}

	<!-- Draggable Floating Comment Popover anchored below the clicked left-gutter line/range or file comment button -->
	{#if selection && popoverOpen && !editing}
		<div
			class="float-pop"
			class:moving={draggingPopover}
			bind:this={popoverEl}
			style:top="{popoverPos.top}px"
			style:left="{popoverPos.left}px"
			role="dialog"
			aria-label={t("이 파일에 코멘트")}
			in:surfaceIn={{ y: 6 }}
			out:surfaceOut={{ y: 6 }}
		>
			<div class="fcard">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="chead" onpointerdown={startPopoverDrag} title={t("드래그하여 이동")}>
					<span class="cgrip" aria-hidden="true">
						<svg viewBox="0 0 10 14" fill="currentColor">
							<circle cx="2.5" cy="3" r="1.2" /><circle cx="7.5" cy="3" r="1.2" />
							<circle cx="2.5" cy="7" r="1.2" /><circle cx="7.5" cy="7" r="1.2" />
							<circle cx="2.5" cy="11" r="1.2" /><circle cx="7.5" cy="11" r="1.2" />
						</svg>
					</span>
					<span class="cloc mono" title="{commentParts.path}{commentParts.suffix}">
						<span class="cpath">{commentParts.path}</span>{#if commentParts.suffix}<span class="clines">{commentParts.suffix}</span>{/if}
					</span>
					<IconButton icon="x" size="sm" label={t("닫기")} onclick={clearSelection} />
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
				<div class="cfoot">
					<div class="cact">
						<Button size="sm" variant="primary" onclick={insertToComposer}>{t("입력창에 넣기")}</Button>
						<Button size="sm" variant="default" disabled={sending || !commentText.trim()} onclick={sendNow}>{t("바로 보내기")}</Button>
					</div>
					<span class="chint">
						{selection.kind === "lines"
							? t("Shift·Ctrl+클릭·드래그로 다중 선택")
							: t("Enter 입력창에 넣기 · Ctrl+Enter 바로 보내기")}
					</span>
				</div>
			</div>
		</div>
	{/if}
</section>

<style>
	.fpane {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
	}
	.mbar {
		display: none;
	}
	@media (max-width: 640px) {
		.mbar {
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
	}
	.mleft,
	.mtools {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.fact {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}
	.cnav {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}
	.cidx {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		line-height: 16px;
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

	/* Direct inline editor */
	.editor-wrap {
		flex: 1;
		min-height: 0;
		display: flex;
		background: var(--bg-code);
	}
	.egutter {
		flex: none;
		width: 48px;
		padding: 8px 8px 8px 4px;
		overflow: hidden;
		text-align: right;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
		background: var(--bg-side);
		border-right: 1px solid var(--border);
		user-select: none;
	}
	.eln {
		line-height: 20px;
	}
	.earea {
		flex: 1;
		min-width: 0;
		min-height: 0;
		padding: 8px 12px;
		border: 0;
		outline: none;
		resize: none;
		background: transparent;
		color: var(--text);
		font-size: var(--fs-xs);
		line-height: 20px;
		tab-size: 4;
		white-space: pre;
		overflow: auto;
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
		width: 56px;
		padding: 0 8px 0 16px;
		border: 0;
		border-right: 1px solid var(--border);
		background: transparent;
		color: var(--text-faint);
		font: inherit;
		text-align: right;
		cursor: pointer;
		flex: none;
		user-select: none;
		line-height: 20px;
	}
	@media (hover: hover) {
		.lnbtn:hover {
			background: var(--bg-active);
			color: var(--text);
		}
	}
	.lnbtn.diff-ln {
		width: 88px;
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 4px;
		padding: 0 8px 0 16px;
	}
	.dln {
		width: 30px;
		text-align: right;
		flex: none;
	}
	.dsig {
		width: 16px;
		text-align: center;
		flex: none;
		user-select: none;
		color: var(--text-faint);
		line-height: 20px;
	}
	.row.d-add .dsig {
		color: var(--ok);
	}
	.row.d-del .dsig {
		color: var(--danger);
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

	/* Floating comment popover & selection pill */
	.float-pop {
		position: fixed;
		z-index: var(--z-popover);
		width: min(480px, calc(100vw - 24px));
		border-radius: var(--radius-md);
		border: 1px solid var(--border-strong);
		background: var(--bg-elev);
		box-shadow: var(--shadow-overlay);
	}
	.float-pop.moving {
		user-select: none;
		-webkit-user-select: none;
	}
	.fcard {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
	}
	.chead {
		display: flex;
		align-items: center;
		gap: 8px;
		line-height: 20px;
		cursor: grab;
		user-select: none;
		-webkit-user-select: none;
	}
	.float-pop.moving .chead {
		cursor: grabbing;
	}
	.cgrip {
		width: 10px;
		height: 14px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-faint);
		flex: none;
	}
	.cgrip svg {
		width: 10px;
		height: 14px;
	}
	.cloc {
		flex: 1;
		min-width: 0;
		display: inline-flex;
		align-items: baseline;
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--accent);
		line-height: 16px;
	}
	.cpath {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.clines {
		flex: 0 0 auto;
		white-space: nowrap;
	}
	.cfoot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
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
