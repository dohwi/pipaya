import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sniffImage } from "./image-file.ts";
import { DEFAULT_LIMITS, type ResizeLimits } from "./image-resize-core.ts";
import { resizeImage } from "./image-resize.ts";

type Block = { type?: string; data?: string; mimeType?: string; [k: string]: unknown };

const base64Size = (chars: number) => chars;

/** Result per picture (keyed by a cheap fingerprint), so a long history is not decoded again on every turn. */
const cache = new Map<string, Block>();
const CACHE_MAX = 200;

const fingerprint = (data: string, limits: ResizeLimits) =>
	`${limits.maxWidth}x${limits.maxHeight}:${data.length}:${Bun.hash(data)}`;

const placeholder = (why: string): Block => ({ type: "text", text: `[image omitted: ${why}]` });

async function fit(block: Block, limits: ResizeLimits, signal?: AbortSignal): Promise<Block> {
	const data = block.data;
	if (typeof data !== "string") return block;
	const bytes = Buffer.from(data, "base64");
	const info = sniffImage(bytes);
	const oversize = !info?.width || !info.height || info.width > limits.maxWidth || info.height > limits.maxHeight || data.length >= limits.maxBytes;
	if (!oversize) return block;

	const key = fingerprint(data, limits);
	const hit = cache.get(key);
	if (hit) return hit;

	const resized = await resizeImage(bytes, limits, signal);
	const out: Block = resized
		? { ...block, data: resized.data, mimeType: resized.mimeType }
		: placeholder(`${info?.width ?? "?"}x${info?.height ?? "?"} picture could not be resized to fit the model's limits`);
	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
	cache.set(key, out);
	return out;
}

/**
 * Last line of defence before a request: every picture in the conversation (attachments, tool results, generated
 * images, and ones stored by older versions) is brought within the pixel and size limits. Providers reject the whole
 * request with a 400 when one picture is too large, and the same history is resent on every retry, so a single big
 * picture would otherwise keep a session failing for good. The stored history is left untouched.
 */
export async function fitImagesInContext(messages: AgentMessage[], limits: Partial<ResizeLimits> = {}, signal?: AbortSignal): Promise<AgentMessage[]> {
	// A model may allow more, but providers reject many-image requests above 3000px per side: never exceed the default.
	const lim: ResizeLimits = { ...DEFAULT_LIMITS, ...limits };
	lim.maxWidth = Math.min(lim.maxWidth, DEFAULT_LIMITS.maxWidth);
	lim.maxHeight = Math.min(lim.maxHeight, DEFAULT_LIMITS.maxHeight);
	lim.maxBytes = Math.min(lim.maxBytes, DEFAULT_LIMITS.maxBytes);
	let changed = false;
	const out: AgentMessage[] = [];
	for (const m of messages) {
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content) || !content.some((c) => (c as Block)?.type === "image")) {
			out.push(m);
			continue;
		}
		const next: Block[] = [];
		let touched = false;
		for (const c of content as Block[]) {
			if (c?.type !== "image") { next.push(c); continue; }
			const fitted = await fit(c, lim, signal);
			if (fitted !== c) touched = true;
			next.push(fitted);
		}
		if (touched) { changed = true; out.push({ ...m, content: next } as AgentMessage); } else out.push(m);
	}
	return changed ? out : messages;
}
