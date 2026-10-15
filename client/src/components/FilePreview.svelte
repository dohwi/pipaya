<script lang="ts">
	import { onDestroy } from "svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { errorText } from "../lib/api";
	import { copyText } from "../lib/clipboard";
	import { previewKind, sizeLabel } from "../lib/files";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";

	/** Preview of a file in the session's working directory: an image, text, or just a download for anything else. */
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

	const kind = $derived(open ? previewKind(open.file.name, open.file.mimeType) : "other");

	function revoke() {
		if (url) URL.revokeObjectURL(url);
		url = null;
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
		loading = true;
		app.api
			.fetchFile(f.sessionId, f.file.path, ctl.signal)
			.then(async (blob) => {
				size = blob.size;
				// the server names the type; trust the file name for the preview kind, and always hand the browser the right type
				const k = previewKind(f.file.name, blob.type || f.file.mimeType);
				if (k === "text") {
					const raw = await blob.text();
					truncated = raw.length > MAX_TEXT;
					text = truncated ? raw.slice(0, MAX_TEXT) : raw;
				}
				url = URL.createObjectURL(blob);
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
	<Modal onclose={close} label={open.file.name} width="xl" maxHeight="85vh" layer={2} portal>
		<div class="head">
			<div class="title">
				<span class="nm">{open.file.name}</span>
				<span class="sub mono">{open.file.path}{size !== undefined ? ` · ${sizeLabel(size)}` : ""}</span>
			</div>
			{#if text !== null}
				<button type="button" class="iconbtn" onclick={copy} aria-label={t("복사")} title={t("복사")}><Icon name={copied ? "check" : "copy"} /></button>
			{/if}
			<button type="button" class="iconbtn" onclick={save} disabled={!url} aria-label={t("저장")} title={t("저장")}><Icon name="download" /></button>
			<button type="button" class="iconbtn" onclick={close} aria-label={t("닫기")}><Icon name="x" /></button>
		</div>
		<div class="body">
			{#if loading}
				<div class="note"><span class="spinner"></span></div>
			{:else if failed}
				<div class="note">{failed}</div>
			{:else if kind === "image" && url}
				<button type="button" class="pic" onclick={() => app.openImage([{ src: url!, mimeType: open.file.mimeType ?? "image/png" }])} aria-label={t("이미지 크게 보기")}>
					<img src={url} alt={open.file.name} />
				</button>
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
	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--border);
	}
	.title {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.nm {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
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
