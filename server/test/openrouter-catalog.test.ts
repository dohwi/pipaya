import { afterEach, describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterCatalog, type CatalogOptions } from "../src/openrouter-catalog.ts";

const dirs: string[] = [];
const tempDir = () => {
	const d = mkdtempSync(join(tmpdir(), "pipaya-catalog-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A live list shaped like OpenRouter's `/api/v1/models`. */
const chat = (models: unknown[]) => new Response(JSON.stringify({ data: models }), { headers: { "content-type": "application/json" } });
const images = (models: unknown[]) => new Response(JSON.stringify({ data: models }), { headers: { "content-type": "application/json" } });

const FABLE = {
	id: "anthropic/claude-fable-5.2",
	name: "Anthropic: Claude Fable 5.2",
	context_length: 1_000_000,
	architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
	top_provider: { max_completion_tokens: 128_000 },
	reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low"] },
};

/** A catalog whose fetch answers with `models` (and an empty image list), counting the calls. */
function stub(models: unknown[], opts: CatalogOptions = {}) {
	const calls: string[] = [];
	const catalog = new OpenRouterCatalog({
		...opts,
		fetch:
			opts.fetch ??
			((async (url: string | URL | Request) => {
				const href = String(url);
				calls.push(href);
				return href.endsWith("/images/models") ? images([]) : chat(models);
			}) as unknown as typeof fetch),
	});
	return { catalog, calls };
}

const levelsOf = (catalog: OpenRouterCatalog, id: string) =>
	getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: catalog.thinkingLevelMap(id) } as Model<any>);

describe("looking strengths up by model name", () => {
	test("a full catalog id and the bare name give the same strengths", () => {
		const { catalog } = stub([]);
		// gpt-5 cannot be told to skip reasoning (its map marks "off" unsupported), so it is not offered.
		expect(levelsOf(catalog, "openai/gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
		expect(levelsOf(catalog, "gpt-5")).toEqual(levelsOf(catalog, "openai/gpt-5"));
	});
	test("a model without 'minimal' does not offer it", () => {
		const { catalog } = stub([]);
		expect(levelsOf(catalog, "gpt-5.1")).not.toContain("minimal");
	});
	test("an unknown name changes nothing", () => {
		const { catalog } = stub([]);
		expect(catalog.thinkingLevelMap("no-such-model-xyz")).toBeUndefined();
		expect(levelsOf(catalog, "no-such-model-xyz")).toEqual(["off", "minimal", "low", "medium", "high"]);
	});
	test("lookup is case-insensitive", () => {
		const { catalog } = stub([]);
		expect(levelsOf(catalog, "GPT-5")).toEqual(levelsOf(catalog, "gpt-5"));
	});
	test("a reasoning model without a catalog map still matches and offers the default strengths", () => {
		const { catalog } = stub([]);
		expect(catalog.match("anthropic/claude-sonnet-4.5")?.id).toBe("anthropic/claude-sonnet-4.5");
		expect(levelsOf(catalog, "claude-sonnet-4.5")).toEqual(["off", "minimal", "low", "medium", "high"]);
	});
	test("measured strengths override the OpenRouter catalog", () => {
		const { catalog } = stub([]);
		for (const id of ["mistral-large-4", "mistralai/mistral-large-4-0"]) expect(levelsOf(catalog, id)).toEqual(["low", "medium", "high"]);
		for (const id of ["glm-5.3", "z-ai/glm-5.3"]) expect(levelsOf(catalog, id)).toEqual(["low", "high", "max"]);
		for (const id of ["deepseek-4.1-flash", "deepseek/deepseek-v4.1-flash"]) expect(levelsOf(catalog, id)).toEqual(["low", "high", "xhigh", "max"]);
	});
});

describe("the bundled snapshot", () => {
	test("lists image generation models too", () => {
		const { catalog } = stub([]);
		const e = catalog.list().find((c) => c.id === "google/gemini-3.1-flash-image");
		expect(e).toBeDefined();
		expect(e!.reasoning).toBe(false);
		expect(catalog.list().filter((c) => c.id === "google/gemini-3.1-flash-image")).toHaveLength(1);
	});
	test("answers before anything was fetched, and says it is not live", () => {
		const { catalog } = stub([]);
		expect(catalog.isLive).toBe(false);
		expect(catalog.updatedAt).toBe(0);
		expect(catalog.list().length).toBeGreaterThan(100);
	});
});

describe("the live list", () => {
	test("a model OpenRouter added after the bundled snapshot is offered", async () => {
		const { catalog, calls } = stub([FABLE]);
		expect(catalog.isLive).toBe(false); // the bundled snapshot answers until the first fetch
		await catalog.refresh();
		expect(calls).toHaveLength(2); // chat + images
		expect(catalog.isLive).toBe(true);
		const e = catalog.entry("anthropic/claude-fable-5.2")!;
		expect(e).toMatchObject({ name: "Anthropic: Claude Fable 5.2", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, vision: true, image: false });
		// mandatory: no "off"; the efforts it lists are the ones offered.
		expect(e.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(catalog.match("claude-fable-5.2")?.id).toBe("anthropic/claude-fable-5.2");
	});

	test("a model the live list no longer has is dropped, and a picture model comes from the image list", async () => {
		const { catalog } = stub([FABLE]);
		await catalog.refresh();
		expect(catalog.entry("qwen/qwen-2.5-7b-instruct")).toBeUndefined();
		const { catalog: withImages } = stub([FABLE], {
			fetch: (async (url: string | URL | Request) =>
				String(url).endsWith("/images/models")
					? images([{ id: "black-forest-labs/flux.2-pro", name: "Black Forest Labs: FLUX.2 Pro", architecture: { input_modalities: ["text"], output_modalities: ["image"] } }])
					: chat([FABLE])) as unknown as typeof fetch,
		});
		await withImages.refresh();
		expect(withImages.entry("black-forest-labs/flux.2-pro")).toMatchObject({ image: true, reasoning: false, levels: [] });
	});

	test("a model without effort levels keeps the default strengths", async () => {
		const { catalog } = stub([{ id: "some/new-model", name: "New", context_length: 200_000, reasoning: { mandatory: false } }]);
		await catalog.refresh();
		expect(catalog.entry("some/new-model")!.levels).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	test("a failed fetch keeps the cache and records why", async () => {
		const dir = tempDir();
		const { catalog } = stub([FABLE], { dataDir: dir });
		await catalog.refresh();
		expect(catalog.isLive).toBe(true);

		// A later start reads the cache file: same entries, no fetch yet.
		const offline = new OpenRouterCatalog({ dataDir: dir, fetch: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch });
		expect(offline.entry("anthropic/claude-fable-5.2")).toBeDefined();
		expect(offline.isLive).toBe(true);
		await offline.refresh(true);
		expect(offline.lastError).toContain("503");
		expect(offline.entry("anthropic/claude-fable-5.2")).toBeDefined(); // still answers
	});

	test("a fresh list is reused until the cache window passes", async () => {
		let now = 1_000;
		const { catalog, calls } = stub([FABLE], { now: () => now, cacheMs: 1000 });
		await catalog.refresh();
		expect(calls).toHaveLength(2);
		now += 500;
		await catalog.refresh();
		expect(calls).toHaveLength(2); // still fresh
		now += 2000;
		expect(catalog.stale).toBe(true);
		await catalog.refresh();
		expect(calls).toHaveLength(4);
		await catalog.refresh(true); // the refresh button ignores the window
		expect(calls).toHaveLength(6);
	});

	test("concurrent refreshes share one fetch", async () => {
		const { catalog, calls } = stub([FABLE]);
		await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
		expect(calls).toHaveLength(2);
	});
});
