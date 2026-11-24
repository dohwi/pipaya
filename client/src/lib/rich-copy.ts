import type { ImageBlock } from "./types";

/**
 * Copying a message with its pictures, and pasting it back with them. The clipboard gets plain text (what every app
 * takes), HTML with the pictures inline (editors that take HTML show them), and a marker in that HTML so a pipaya input
 * knows the message as its own: it takes the text with the pictures attached, `#imageN` renumbered after the ones
 * already there. Plain functions on strings (no DOM), so they can be unit-tested.
 */

const MARK = "data-pipaya-message";
const MARK_ATTR = new RegExp(`${MARK}\\s*=\\s*["']([^"']*)["']`);
const IMG_TOKEN = /#image(\d+)\b/g;
const DATA_IMG = /<img\b[^>]*?\bsrc\s*=\s*["'](data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))["']/gi;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The HTML put on the clipboard: the text (line breaks kept), then the pictures in order. */
export function messageHtml(text: string, images: readonly ImageBlock[]): string {
	const body = esc(text).replace(/\n/g, "<br>");
	const pics = images.map((b, i) => `<p><img src="data:${b.mimeType};base64,${b.data}" alt="image${i + 1}"></p>`).join("");
	return `<div ${MARK}="${encodeURIComponent(JSON.stringify({ v: 1, text }))}">${body ? `<p>${body}</p>` : ""}${pics}</div>`;
}

/** Inline pictures (`data:` URLs) of a pasted HTML, in document order. Links to elsewhere are skipped. */
export function htmlImages(html: string): ImageBlock[] {
	const out: ImageBlock[] = [];
	for (const m of html.matchAll(DATA_IMG)) out.push({ type: "image", mimeType: m[2]!.toLowerCase(), data: m[3]!.replace(/\s+/g, "") });
	return out;
}

/** A message copied from pipaya: its text and pictures. null for any other HTML. */
export function pastedMessage(html: string): { text: string; images: ImageBlock[] } | null {
	const m = MARK_ATTR.exec(html);
	if (!m) return null;
	try {
		const p = JSON.parse(decodeURIComponent(m[1]!)) as { v?: number; text?: unknown };
		if (typeof p.text !== "string") return null;
		return { text: p.text, images: htmlImages(html) };
	} catch {
		return null;
	}
}

/** `#image1..#image{count}` move up by `by` (the pictures already attached come first). */
export function shiftImageTokens(text: string, by: number, count: number): string {
	if (!by) return text;
	return text.replace(IMG_TOKEN, (m, n) => (Number(n) >= 1 && Number(n) <= count ? `#image${Number(n) + by}` : m));
}
