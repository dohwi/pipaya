import { isTauri } from "./tauri";

/**
 * Save bytes as a file. In the desktop/mobile app a webview ignores `<a download>`, so a native save dialog and a file write are used;
 * in a browser the usual anchor download works. Returns false when the user cancelled the dialog.
 */
export async function saveFile(source: Blob | string, filename: string): Promise<boolean> {
	const blob = await sourceBlob(source);
	if (isTauri()) {
		// no fallback to the anchor below: a webview ignores it silently, so a failure must reach the caller
		const { save } = await import("@tauri-apps/plugin-dialog");
		const path = await save({ defaultPath: filename });
		if (!path) return false;
		const { writeFile } = await import("@tauri-apps/plugin-fs");
		await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
		return true;
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
	return true;
}

/** The bytes behind a Blob, a `data:` URL, a `blob:` URL or an http(s) URL. */
export async function sourceBlob(source: Blob | string): Promise<Blob> {
	if (typeof source !== "string") return source;
	if (source.startsWith("data:")) return dataUrlToBlob(source);
	return await (await fetch(source)).blob();
}

/** Decodes a `data:` URL by hand: the app's CSP does not allow `fetch` on it. */
function dataUrlToBlob(src: string): Blob {
	const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(src);
	if (!m) throw new Error("not a data URL");
	const bin = m[2].includes(";base64") ? atob(m[3]) : decodeURIComponent(m[3]);
	return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: m[1] || "application/octet-stream" });
}
