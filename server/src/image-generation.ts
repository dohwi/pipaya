import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type ImageContent, type ImageModel, type ImagesInputContent, type Message, type Model, type SimpleStreamOptions, type TextContent } from "@earendil-works/pi-ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mimeOf } from "./file-routes.ts";
import { sniffImage } from "./image-file.ts";
import type { ModelRegistry } from "./models.ts";
import { safePath } from "./tools.ts";

/** Where generated pictures land, relative to the session's working directory. */
export const GENERATED_DIR = ".pipaya/generated";
/** The image API every image-generation model of a connection is called through (chat completions with `modalities`). */
export const IMAGE_API = "openrouter-images";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const GENERATED_LINK = new RegExp(`\\]\\((${GENERATED_DIR.replace(/[.]/g, "\\.")}/[\\w.-]+)\\)`, "g");

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** The image-model view of a connection's model entry: same endpoint and key, called through the image API. */
export function asImageModel(m: Model<Api>): ImageModel<string> {
	return { type: "image", id: m.id, name: m.name, api: IMAGE_API, provider: m.provider, baseUrl: m.baseUrl, input: m.input, cost: m.cost, output: ["image", "text"], ...(m.headers ? { headers: m.headers } : {}) };
}

function lastUser(messages: readonly Message[]): { text: string; images: ImageContent[] } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return { text: m.content, images: [] };
		const text = m.content.flatMap((c) => (c.type === "text" && !c.text.startsWith("<pipaya-") ? [c.text] : [])).join("\n");
		return { text, images: m.content.filter((c): c is ImageContent => c.type === "image") };
	}
	return { text: "", images: [] };
}

/** The newest picture this session generated, so "make it bluer" edits it instead of starting over. */
async function previousPicture(messages: readonly Message[], cwd: string): Promise<ImageContent | undefined> {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		const text = m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
		const hit = [...text.matchAll(GENERATED_LINK)].pop();
		if (!hit) continue;
		try {
			const bytes = await readFile(safePath(cwd, hit[1]!));
			const mimeType = mimeOf(hit[1]!);
			if (mimeType.startsWith("image/")) return { type: "image", data: bytes.toString("base64"), mimeType };
		} catch { /* the file is gone: generate from the prompt alone */ }
		return undefined;
	}
	return undefined;
}

/**
 * A model reply made by an image-generation model: one request, no tools. It speaks the same stream protocol as a
 * chat model, so the session machinery (storage, events, retry, abort) needs no special case. The pictures are saved
 * into the working directory and the reply refers to them as markdown images, which every client already shows.
 */
export function imageStream(registry: ModelRegistry, model: Model<Api>, messages: readonly Message[], options: SimpleStreamOptions | undefined, cwd: string | undefined): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const msg: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
	stream.push({ type: "start", partial: msg });
	const fail = (reason: "error" | "aborted", message: string) => {
		msg.stopReason = reason;
		msg.errorMessage = message;
		stream.push({ type: "error", reason, error: msg });
	};
	void (async () => {
		try {
			if (!cwd) return fail("error", "session has no working directory");
			const { text, images } = lastUser(messages);
			if (!text.trim() && !images.length) return fail("error", "write what the picture should show");
			const input: ImagesInputContent[] = [{ type: "text", text }, ...images];
			if (!images.length) {
				const earlier = await previousPicture(messages, cwd);
				if (earlier) input.push(earlier);
			}
			const result = await registry.models.generateImages(asImageModel(model), { input }, { ...(options?.signal ? { signal: options.signal } : {}), ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
			if (result.stopReason === "aborted") return fail("aborted", result.errorMessage ?? "aborted");
			if (result.stopReason === "error") return fail("error", result.errorMessage ?? "image generation failed");
			if (result.usage) msg.usage = result.usage;
			if (result.responseId) msg.responseId = result.responseId;
			const lines: string[] = [];
			for (const c of result.output) {
				if (c.type === "text") {
					if (c.text.trim()) lines.push(c.text.trim());
					continue;
				}
				const bytes = Buffer.from(c.data, "base64");
				const mimeType = sniffImage(bytes)?.mimeType ?? c.mimeType;
				const path = `${GENERATED_DIR}/${Date.now().toString(36)}-${randomUUID().slice(0, 6)}.${EXT[mimeType] ?? "png"}`;
				const abs = safePath(cwd, path);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, bytes);
				lines.push(`![${text.trim().replace(/[\[\]\n]/g, " ").slice(0, 80)}](${path})`);
			}
			if (!lines.some((l) => l.startsWith("!["))) return fail("error", "the model returned no picture");
			const body = lines.join("\n\n");
			const block: TextContent = { type: "text", text: "" };
			msg.content = [block];
			stream.push({ type: "text_start", contentIndex: 0, partial: msg });
			block.text = body;
			stream.push({ type: "text_delta", contentIndex: 0, delta: body, partial: msg });
			stream.push({ type: "text_end", contentIndex: 0, content: body, partial: msg });
			stream.push({ type: "done", reason: "stop", message: msg });
		} catch (e) {
			fail(options?.signal?.aborted ? "aborted" : "error", e instanceof Error ? e.message : String(e));
		}
	})();
	return stream;
}
