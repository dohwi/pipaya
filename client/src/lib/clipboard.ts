import { t } from "./i18n";
import { messageHtml } from "./rich-copy";
import { isDesktopTauri } from "./tauri";
import type { ImageBlock } from "./types";

/** Maximum file size accepted by the desktop native file clipboard (256 MiB, matches Rust `MAX_FILE_BYTES`). */
export const MAX_CLIPBOARD_FILE_BYTES = 256 * 1024 * 1024;

export type FileCopyResult = "ok" | "unsupported" | "too_large" | "error";

export type FileClipboardInvoke = (
	command: string,
	payload: Uint8Array,
	options: { headers: Record<string, string> },
) => Promise<unknown>;

/** True when the current client can place a real file object (mp4, pdf, zip, …) on the OS clipboard. */
export function supportsFileClipboard(): boolean {
	return isDesktopTauri();
}

function encodeFilenameHeader(filename: string): string {
	const raw = filename.trim() || "file";
	const wellFormed =
		typeof (raw as string & { toWellFormed?: () => string }).toWellFormed === "function"
			? (raw as string & { toWellFormed: () => string }).toWellFormed()
			: raw.replace(/[\uD800-\uDFFF]/g, "_");
	return encodeURIComponent(wellFormed);
}

/**
 * Stages a file in the desktop app's cache under `filename` and places it on the OS clipboard so
 * Ctrl/Cmd+V pastes the actual file into Finder, Explorer, Discord, Slack, etc.
 */
export async function copyFile(
	source: Blob | string,
	filename: string,
	deps?: { supported?: () => boolean; invoke?: FileClipboardInvoke; knownSize?: number },
): Promise<FileCopyResult> {
	const supported = deps?.supported ? deps.supported() : supportsFileClipboard();
	if (!supported) return "unsupported";
	if (deps?.knownSize !== undefined && deps.knownSize > MAX_CLIPBOARD_FILE_BYTES) return "too_large";
	try {
		const { sourceBlob } = await import("./save-file");
		const blob = await sourceBlob(source);
		if (blob.size > MAX_CLIPBOARD_FILE_BYTES) return "too_large";
		const bytes = new Uint8Array(await blob.arrayBuffer());
		if (bytes.byteLength > MAX_CLIPBOARD_FILE_BYTES) return "too_large";
		const call: FileClipboardInvoke =
			deps?.invoke ??
			(async (cmd, payload, options) => {
				const { invoke } = await import("@tauri-apps/api/core");
				return invoke(cmd, payload, options);
			});
		const safeHeaderName = encodeFilenameHeader(filename);
		await call("copy_file_to_clipboard", bytes, {
			headers: { "x-file-name": safeHeaderName },
		});
		return "ok";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err ?? "");
		if (/exceeds .* byte limit/i.test(msg)) return "too_large";
		return "error";
	}
}

/** User-facing status text for a `copyFile` outcome. */
export function fileCopyMessage(result: FileCopyResult, filename?: string): { text: string; ok: boolean } {
	if (result === "ok") {
		return {
			text: filename ? t("{name}을(를) 복사했습니다", { name: filename }) : t("파일을 복사했습니다"),
			ok: true,
		};
	}
	if (result === "too_large") {
		return { text: t("파일이 너무 커서 복사할 수 없습니다"), ok: false };
	}
	return { text: t("복사하지 못했습니다"), ok: false };
}

function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
}

/**
 * Matches Cmd+C on macOS and Ctrl+C elsewhere. Checks `e.key` first so non-QWERTY Latin layouts
 * (Dvorak, Colemak, AZERTY) work naturally, and falls back to `e.code === "KeyC"` only when `e.key`
 * is not an ASCII letter (e.g. Korean `ㅊ` or Cyrillic layouts).
 */
export function isCopyShortcut(
	e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code"> & { key?: string },
	mac = isMacPlatform(),
): boolean {
	if (e.shiftKey || e.altKey) return false;
	const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
	if (!mod) return false;
	const key = e.key ?? "";
	if (/^[a-z]$/i.test(key)) return key.toLowerCase() === "c";
	return e.code === "KeyC";
}

const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** True when `el` is an editable text field whose own copy shortcut must never be hijacked. */
export function isTextInputTarget(el: Element | null): boolean {
	if (!el) return false;
	const html = el as HTMLElement;
	if (html.isContentEditable) return true;
	const tag = el.tagName?.toUpperCase();
	if (tag === "TEXTAREA") return true;
	if (tag === "INPUT") {
		const type = ((el as HTMLInputElement).type || "text").toLowerCase();
		return !NON_TEXT_INPUT_TYPES.has(type);
	}
	return false;
}

/**
 * True when a Ctrl/Cmd+C keydown event is safe for a media/file surface to handle:
 * no text is selected, no editable text field has focus, and nothing else already handled it.
 */
export function canInterceptCopyKey(e: KeyboardEvent): boolean {
	if (e.defaultPrevented || e.isComposing || !isCopyShortcut(e)) return false;
	if (typeof window !== "undefined" && window.getSelection()?.toString()) return false;
	if (typeof document !== "undefined" && isTextInputTarget(document.activeElement)) return false;
	return true;
}

/** `navigator.clipboard` is unavailable in insecure contexts (plain-http dev server), so fall back. */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* fall through */
	}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	ta.remove();
	return ok;
}

/** Puts an image on the clipboard. Browsers only take PNG there, so any other format is redrawn as one. */
export async function copyImage(source: Blob | string): Promise<boolean> {
	if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
	try {
		const { sourceBlob } = await import("./save-file");
		const blob = await sourceBlob(source);
		const png = blob.type === "image/png" ? blob : await toPng(blob);
		await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
		return true;
	} catch {
		return false;
	}
}

async function toPng(blob: Blob): Promise<Blob> {
	const bmp = await createImageBitmap(blob);
	const canvas = document.createElement("canvas");
	canvas.width = bmp.width;
	canvas.height = bmp.height;
	canvas.getContext("2d")!.drawImage(bmp, 0, 0);
	bmp.close();
	return await new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("png"))), "image/png"));
}

/**
 * Put text with its pictures on the clipboard. Synchronous on purpose: run from the click itself, it works without a
 * secure context (the plain-http address) through the copy event, which may set any type. false when the platform
 * refused; the caller then copies the text alone.
 */
export function copyMessage(text: string, images: readonly ImageBlock[]): boolean {
	if (typeof document === "undefined") return false;
	let wrote = false;
	const onCopy = (e: ClipboardEvent) => {
		if (!e.clipboardData) return;
		e.preventDefault();
		e.clipboardData.setData("text/plain", text);
		e.clipboardData.setData("text/html", messageHtml(text, images));
		wrote = true;
	};
	// A selection to copy: some engines fire no copy event without one.
	const ta = document.createElement("textarea");
	ta.value = text || " ";
	ta.setAttribute("readonly", "");
	ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
	const focused = document.activeElement as HTMLElement | null;
	document.body.appendChild(ta);
	ta.select();
	document.addEventListener("copy", onCopy, true);
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	document.removeEventListener("copy", onCopy, true);
	ta.remove();
	focused?.focus?.({ preventScroll: true });
	return ok && wrote;
}
