import { messageHtml } from "./rich-copy";
import type { ImageBlock } from "./types";

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
