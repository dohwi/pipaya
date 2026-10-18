<script lang="ts">
	import { onDestroy } from "svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { errorText } from "../lib/api";
	import { copyText } from "../lib/clipboard";
	import { parseTable, previewKind, sizeLabel } from "../lib/files";
	import Markdown from "./Markdown.svelte";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";

	/** Preview of a file in the session's working directory: an image, PDF, audio, video, Markdown, CSV table, text, or just a download for anything else. */
	const open = $derived(app.filePreview);
	const close = () => (app.filePreview = null);

	const MAX_TEXT = 400_000;
	let url = $state<string | null>(null);
	let text = $state<string | null>(null);
	let truncated = $state(false);
	let failed = $state<string | null>(null);
	let loading = $state(true);
	let size = $state<number | undefined>(undefined);
	let copied = $state(false);
	/** HTML shows as a page by default; this flips it to the source */
	let source = $state(false);
	let htmlUrl = $state<string | null>(null);

	const kind = $derived(open ? previewKind(open.file.name, open.file.mimeType) : "other");

	const table = $derived(kind === "table" && text !== null ? parseTable(text, /\.tsv$/i.test(open?.file.name ?? "") ? "\t" : ",") : null);

	function revoke() {
		if (url) URL.revokeObjectURL(url);
		url = null;
		if (htmlUrl) URL.revokeObjectURL(htmlUrl);
		htmlUrl = null;
	}
	onDestroy(revoke);

	$effect(() => {
		const f = open;
		if (!f || !app.api) return;
		const ctl = new AbortController();
		revoke();
		text = null;
		failed = null;
		truncated = false;
		source = false;
		loading = true;
		app.api
			.fetchFile(f.sessionId, f.file.path, ctl.signal)
			.then(async (blob) => {
				size = blob.size;
				// the server names the type; trust the file name for the preview kind, and always hand the browser the right type
				const k = previewKind(f.file.name, blob.type || f.file.mimeType);
				if (k === "text" || k === "markdown" || k === "table" || k === "html") {
					const raw = await blob.text();
					truncated = raw.length > MAX_TEXT;
					text = truncated ? raw.slice(0, MAX_TEXT) : raw;
				}
				url = URL.createObjectURL(blob);
				// the server sends html as text/plain; the frame needs the real type
				if (k === "html") htmlUrl = URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: "text/html" }));
			})
			.catch((e) => {
				if ((e as Error).name !== "AbortError") failed = errorText(e);
			})
			.finally(() => (loading = false));
		return () => ctl.abort();
	});

	function save() {
		if (!url || !open) return;
		const a = document.createElement("a");
		a.href = url;
		a.download = open.file.name;
		a.click();
	}

	async function copy() {
		if (text !== null && (await copyText(text))) {
			copied = true;
			setTimeout(() => (copied = false), 1400);
		}
	}
</script>

{#if open}
	<Modal onclose={close} title={open.file.name} sub={`${open.file.path}${size !== undefined ? ` · ${sizeLabel(size)}` : ""}`} subMono divider width="xl" maxHeight="85vh" layer={2} portal>
		{#snippet headerActions()}
			{#if kind === "html"}
				<button type="button" class="iconbtn" class:on={source} onclick={() => (source = !source)} aria-pressed={source} aria-label={t("소스 보기")} title={t("소스 보기")}><Icon name="terminal" /></button>
			{/if}
			{#if text !== null}
				<button type="button" class="iconbtn" onclick={copy} aria-label={t("복사")} title={t("복사")}><Icon name={copied ? "check" : "copy"} /></button>
			{/if}
			<button type="button" class="iconbtn" onclick={save} disabled={!url} aria-label={t("저장")} title={t("저장")}><Icon name="download" /></button>
		{/snippet}
		<div class="body">
			{#if loading}
				<div class="note"><span class="spinner"></span></div>
			{:else if failed}
				<div class="note">{failed}</div>
			{:else if kind === "image" && url}
				<button type="button" class="pic" onclick={() => app.openImage([{ src: url!, mimeType: open.file.mimeType ?? "image/png" }])} aria-label={t("이미지 크게 보기")}>
					<img src={url} alt={open.file.name} />
				</button>
			{:else if kind === "pdf" && url}
				<iframe class="pdf" src={url} title={open.file.name}></iframe>
			{:else if kind === "audio" && url}
				<!-- svelte-ignore a11y_media_has_caption -->
				<audio class="media" src={url} controls preload="metadata"></audio>
			{:else if kind === "video" && url}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video class="media" src={url} controls preload="metadata" playsinline></video>
			{:else if kind === "html" && htmlUrl && !source}
				<!-- fully sandboxed: no scripts, no same-origin, no forms, no navigation -->
				<iframe class="html" src={htmlUrl} sandbox="" referrerpolicy="no-referrer" title={open.file.name}></iframe>
			{:else if kind === "markdown" && text !== null}
				<Markdown {text} sessionId={open.sessionId} />
				{#if truncated}<div class="note">{t("파일이 커서 앞부분만 보여 줍니다")}</div>{/if}
			{:else if table}
				<div class="tablewrap">
					<table>
						<tbody>
							{#each table.rows as r, i}
								<tr>{#each r as c}{#if i === 0}<th>{c}</th>{:else}<td>{c}</td>{/if}{/each}</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if truncated || table.more}<div class="note">{t("파일이 커서 앞부분만 보여 줍니다")}</div>{/if}
			{:else if text !== null}
				<pre>{text}</pre>
				{#if truncated}<div class="note">{t("파일이 커서 앞부분만 보여 줍니다")}</div>{/if}
			{:else}
				<div class="note">{t("미리볼 수 없는 형식입니다. 저장해서 열어 보세요.")}</div>
			{/if}
		</div>
	</Modal>
{/if}

<style>
	.body {
		overflow: auto;
		padding: 14px;
		min-height: 120px;
	}
	.pic {
		display: block;
		margin: 0 auto;
		padding: 0;
		cursor: zoom-in;
	}
	.pic img {
		display: block;
		max-width: 100%;
		max-height: 70vh;
		border-radius: var(--radius);
	}
	.pdf {
		display: block;
		width: 100%;
		height: 70vh;
		border: 0;
		border-radius: var(--radius);
		background: #fff;
	}
	.html {
		display: block;
		width: 100%;
		height: 70vh;
		border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
		border-radius: var(--radius);
		background: #fff;
	}
	.iconbtn.on {
		color: var(--accent, inherit);
	}
	.media {
		display: block;
		width: 100%;
		max-height: 70vh;
		border-radius: var(--radius);
	}
	.tablewrap {
		overflow: auto;
		max-height: 70vh;
	}
	table {
		border-collapse: collapse;
		font-size: var(--fs-sm);
	}
	th,
	td {
		padding: 4px 10px;
		border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
		text-align: left;
		white-space: nowrap;
	}
	th {
		position: sticky;
		top: 0;
		background: var(--bg-elev, var(--bg, #222));
		font-weight: 600;
	}
	pre {
		margin: 0;
		font-family: var(--mono);
		font-size: var(--fs-sm);
		line-height: 1.55;
		tab-size: 2;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.note {
		display: grid;
		place-items: center;
		padding: 24px;
		color: var(--text-dim);
		font-size: var(--fs-sm);
		text-align: center;
	}
</style>
