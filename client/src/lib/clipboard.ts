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
