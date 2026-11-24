<script lang="ts">
	import DOMPurify from "dompurify";
	import { onMount } from "svelte";
	import { highlightCode, onHighlightReady } from "../../lib/code-highlight";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { workspaceViewer, type DiffLine } from "../../lib/workspace-viewer.svelte";
	import Button from "../ui/Button.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Notice from "../ui/Notice.svelte";
	import Segmented from "../ui/Segmented.svelte";

	const sessionId = $derived(app.current?.id ?? workspaceViewer.sessionId);
	const selectedPath = $derived(workspaceViewer.activeFile ?? workspaceViewer.selectedPath);
	const selectedChange = $derived(selectedPath ? workspaceViewer.changeFor(selectedPath) : undefined);

	// Syntax highlight readiness tick (re-runs derived highlighting when a lazy grammar finishes loading).
	let hlTick = $state(0);
	onMount(() => onHighlightReady(() => hlTick++));

	// Inline line-comment composer state (works in both File view and Diff view).
	let commentTarget = $state<{ path: string; line: number; snippet: string; key: string } | null>(null);
	let commentText = $state("");
	let sending = $state(false);

	const modeOptions = $derived([
		{ id: "file", label: t("파일") },
		{ id: "diff", label: t("변경 비교") },
	]);

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

	// Reset inline comment when switching files or view modes.
	$effect(() => {
		void selectedPath;
		void workspaceViewer.viewMode;
		commentTarget = null;
		commentText = "";
	});

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

	function diffLineNumber(l: DiffLine): number {
		return l.newLine ?? l.oldLine ?? 1;
	}
</script>

{#snippet inlineCommentBox()}
	<div class="cbox">
		<div class="cbox-in">
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
	</div>
{/snippet}

<section class="fpane" data-part="workspace-file-pane" aria-label={selectedPath ?? t("파일 뷰어")}>
	{#if selectedPath}
		<div class="fbar">
			<div class="fmeta">
				<span class="fpath mono" title={selectedPath}>{selectedPath}</span>
				{#if selectedChange && (selectedChange.additions > 0 || selectedChange.deletions > 0)}
					<span class="cstat mono">
						{#if selectedChange.additions > 0}<span class="add">+{selectedChange.additions}</span>{/if}
						{#if selectedChange.deletions > 0}<span class="del">-{selectedChange.deletions}</span>{/if}
					</span>
				{/if}
			</div>
			<div class="ftools">
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
								if (id === "diff" && selectedPath) void workspaceViewer.loadDiff(selectedPath);
							}}
						/>
					</div>
				{/if}
				<IconButton
					icon="retry"
					size="sm"
					label={t("새로고침")}
					onclick={() => void workspaceViewer.selectFile(selectedPath, workspaceViewer.viewMode)}
				/>
			</div>
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
											onclick={() => openLineComment(selectedPath, ln, dl.text, key)}
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
					<Notice tone="danger" size="sm" onretry={() => selectedPath && workspaceViewer.loadFile(selectedPath)}>
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
								onclick={() => openLineComment(selectedPath, ln, line, key)}
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
