import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantImages, ImagesContext, Model } from "@earendil-works/pi-ai";
import { imageStream } from "../src/image-generation.ts";
import type { ModelRegistry } from "../src/models.ts";

// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const model = { id: "google/gemini-3.1-flash-image", name: "n", api: "openai-completions", provider: "or", baseUrl: "http://x", input: ["text"], reasoning: false, contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<Api>;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pipaya-imggen-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const registry = (result: Partial<AssistantImages>, seen: ImagesContext[] = []) => ({
	models: { generateImages: async (_m: unknown, ctx: ImagesContext) => { seen.push(ctx); return { api: "x", provider: "or", model: "m", output: [], stopReason: "stop", timestamp: 0, ...result }; } },
}) as unknown as ModelRegistry;

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

async function run(reg: ModelRegistry, messages: any[]) {
	const events: string[] = [];
	const s = imageStream(reg, model, messages, undefined, dir);
	for await (const e of s) events.push(e.type);
	return { events, message: await s.result() };
}

describe("imageStream", () => {
	test("saves the picture and answers with a markdown image", async () => {
		const seen: ImagesContext[] = [];
		const { events, message } = await run(registry({ output: [{ type: "text", text: "Here you go" }, { type: "image", mimeType: "image/png", data: PNG }] }, seen), [user("a red cat")]);
		expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(message.stopReason).toBe("stop");
		const text = (message.content[0] as { text: string }).text;
		const path = /\]\((\.pipaya\/generated\/[^)]+\.png)\)/.exec(text)?.[1];
		expect(path).toBeDefined();
		expect(readFileSync(join(dir, path!)).toString("base64")).toBe(PNG);
		expect(seen[0]!.input[0]).toEqual({ type: "text", text: "a red cat" });
	});

	test("edits the previous picture when the new request has none", async () => {
		const first = await run(registry({ output: [{ type: "image", mimeType: "image/png", data: PNG }] }), [user("a cat")]);
		const seen: ImagesContext[] = [];
		await run(registry({ output: [{ type: "image", mimeType: "image/png", data: PNG }] }, seen), [user("a cat"), first.message, user("make it blue")]);
		expect(seen[0]!.input.map((c) => c.type)).toEqual(["text", "image"]);
	});

	test("a failed request ends as an error and writes nothing", async () => {
		const { events, message } = await run(registry({ stopReason: "error", errorMessage: "no credit" }), [user("x")]);
		expect(events).toEqual(["start", "error"]);
		expect(message.errorMessage).toBe("no credit");
		expect(existsSync(join(dir, ".pipaya"))).toBe(false);
	});

	test("a reply without any picture is an error", async () => {
		const { message } = await run(registry({ output: [{ type: "text", text: "sorry" }] }), [user("x")]);
		expect(message.stopReason).toBe("error");
	});
});
