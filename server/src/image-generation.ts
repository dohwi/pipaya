import type { Database } from "bun:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, ImageModel, ImagesInputContent, Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { badRequest } from "./errors.ts";
import { mimeOf } from "./file-routes.ts";
import { sniffImage } from "./image-file.ts";
import type { ModelRegistry } from "./models.ts";
import { safePath, type ToolDef } from "./tools.ts";

/**
 * Image generation. An image model (a connection's model marked `imageGeneration`) never runs a chat. The server's
 * "image model" setting picks one, and while it is set the agent gets the `generate_image` tool: it describes a picture
 * (and may pass pictures in the folder to edit), the picture is saved in the working directory and the tool answers
 * with its path and the picture itself.
 */

/** Where generated pictures land, relative to the session's working directory. */
export const GENERATED_DIR = ".pipaya/generated";
/** The image API every image model of a connection is called through (chat completions with `modalities`). */
export const IMAGE_API = "openrouter-images";
export const IMAGE_TOOL = "generate_image";
const MAX_INPUT_IMAGES = 4;
const TIMEOUT_MS = 180_000;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export const ImageModelSchema = Type.Object(
	{
		model: Type.Union([Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) }, { additionalProperties: false }), Type.Null()], {
			description: "The image model agents draw with (the generate_image tool). null = off: no agent gets the tool",
		}),
	},
	{ additionalProperties: false },
);
export type ImageModelValue = Static<typeof ImageModelSchema>;
export const ImageModelResult = Type.Object({ settings: ImageModelSchema, defaults: ImageModelSchema });
export const DEFAULT_IMAGE_MODEL = (): ImageModelValue => ({ model: null });
const KEY = "image_model";

export class ImageModelSettings {
	constructor(private db: Database, private registry: ModelRegistry) {}

	get(): ImageModelValue {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		if (!row) return DEFAULT_IMAGE_MODEL();
		try {
			const parsed = JSON.parse(row.data);
			return Value.Check(ImageModelSchema, parsed) ? parsed : DEFAULT_IMAGE_MODEL();
		} catch {
			return DEFAULT_IMAGE_MODEL();
		}
	}

	set(next: ImageModelValue): ImageModelValue {
		if (next.model) {
			if (!this.registry.models.getModel(next.model.provider, next.model.model)) throw badRequest(`unknown model ${next.model.provider}/${next.model.model}`);
			if (!this.registry.isImageModel?.(next.model.provider, next.model.model)) throw badRequest(`${next.model.provider}/${next.model.model} is not an image model`);
		}
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(next) });
		return this.get();
	}

	/** The chosen model while it still exists and is still an image model; anything else turns the tool off. */
	resolve(): Model<Api> | undefined {
		const chosen = this.get().model;
		if (!chosen || !this.registry.isImageModel?.(chosen.provider, chosen.model)) return undefined;
		return this.registry.models.getModel(chosen.provider, chosen.model);
	}
}

/** The image-model view of a connection's model entry: same endpoint and key, called through the image API. */
export function asImageModel(m: Model<Api>): ImageModel<string> {
	return { type: "image", id: m.id, name: m.name, api: IMAGE_API, provider: m.provider, baseUrl: m.baseUrl, input: m.input, cost: m.cost, output: ["image", "text"], ...(m.headers ? { headers: m.headers } : {}) };
}

export interface GeneratedImage {
	/** Relative to the working directory, under GENERATED_DIR. */
	path: string;
	mimeType: string;
	data: string;
}

/** One request to the image model; the pictures are written under GENERATED_DIR in `cwd`. */
export async function generateImages(
	registry: ModelRegistry,
	model: Model<Api>,
	cwd: string,
	prompt: string,
	inputs: ImageContent[],
	signal?: AbortSignal,
): Promise<{ text: string; images: GeneratedImage[] }> {
	const input: ImagesInputContent[] = [{ type: "text", text: prompt }, ...inputs];
	const result = await registry.models.generateImages(asImageModel(model), { input }, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
	if (result.stopReason === "aborted") throw new Error("aborted");
	if (result.stopReason === "error") throw new Error(result.errorMessage ?? "image generation failed");
	const texts: string[] = [];
	const images: GeneratedImage[] = [];
	for (const c of result.output) {
		if (c.type === "text") {
			if (c.text.trim()) texts.push(c.text.trim());
			continue;
		}
		const bytes = Buffer.from(c.data, "base64");
		const mimeType = sniffImage(bytes)?.mimeType ?? c.mimeType;
		const path = `${GENERATED_DIR}/${Date.now().toString(36)}-${randomUUID().slice(0, 6)}.${EXT[mimeType] ?? "png"}`;
		const abs = safePath(cwd, path);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, bytes);
		images.push({ path, mimeType, data: c.data });
	}
	if (!images.length) throw new Error(texts.length ? `the model returned no picture: ${texts.join(" ").slice(0, 300)}` : "the model returned no picture");
	return { text: texts.join("\n"), images };
}

const DESCRIPTION =
	"Draw a picture with the image model and save it in the working directory (under .pipaya/generated). Describe the whole picture in `prompt`. " +
	"To edit or build on existing pictures, pass their paths in `images` (files in the working directory, e.g. one this tool made).";

/** Shown with the saved path: the model reads it right when it decides what to write next. */
const SHOWN_NOTE = "(show it in your reply with ![description](path), then describe it briefly)";

/** The `generate_image` tool, given while an image model is set. */
export function imageTool(registry: ModelRegistry, settings: ImageModelSettings): ToolDef {
	return {
		name: IMAGE_TOOL,
		description: DESCRIPTION,
		create(cwd): AgentTool<any> {
			return {
				name: IMAGE_TOOL,
				label: "Generate image",
				description: DESCRIPTION,
				parameters: Type.Object({
					prompt: Type.String({ minLength: 1, maxLength: 4000, description: "What the picture shows, in full" }),
					images: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: MAX_INPUT_IMAGES, description: "Paths of pictures to edit or use as reference" })),
				}),
				executionMode: "sequential",
				async execute(_id, raw, signal) {
					const params = raw as { prompt: string; images?: string[] };
					const model = settings.resolve();
					if (!model) throw new Error("no image model is set (Settings → agent → image model)");
					const inputs: ImageContent[] = [];
					for (const p of params.images ?? []) {
						const mimeType = mimeOf(p);
						if (!mimeType.startsWith("image/")) throw new Error(`${p} is not a picture`);
						inputs.push({ type: "image", data: (await readFile(safePath(cwd, p))).toString("base64"), mimeType });
					}
					const out = await generateImages(registry, model, cwd, params.prompt, inputs, signal);
					const lines = [...out.images.map((i) => `Saved ${i.path} ${SHOWN_NOTE}`), ...(out.text ? [`Model note: ${out.text}`] : [])];
					return {
						content: [{ type: "text", text: lines.join("\n") }, ...out.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))],
						details: { model: `${model.provider}/${model.id}`, paths: out.images.map((i) => i.path) },
					};
				},
			};
		},
	};
}
