import { describe, expect, test } from "bun:test";
import { bareName, indexCatalog } from "../src/lib/catalog-match";
import type { CatalogModel } from "../src/lib/types";

const entry = (id: string): CatalogModel => ({ id, name: id, contextWindow: 1000, maxTokens: 100, reasoning: false, vision: false }) as CatalogModel;

describe("catalog matching", () => {
	test("bare names drop the vendor, tags and -preview", () => {
		expect(bareName("openai/GPT-4o:free")).toBe("gpt-4o");
		expect(bareName("google/gemini-2.5-pro-preview")).toBe("gemini-2.5-pro");
	});
	test("an exact id wins, else a unique bare name", () => {
		const idx = indexCatalog([entry("openai/gpt-4o"), entry("anthropic/claude-x")]);
		expect(idx.match("openai/gpt-4o")?.id).toBe("openai/gpt-4o");
		expect(idx.match("gpt-4o")?.id).toBe("openai/gpt-4o");
		expect(idx.match("  Claude-X  ")?.id).toBe("anthropic/claude-x");
		expect(idx.match("")).toBeUndefined();
	});
	test("a bare name several vendors share matches nothing", () => {
		const idx = indexCatalog([entry("a/llama-3"), entry("b/llama-3")]);
		expect(idx.match("llama-3")).toBeUndefined();
		expect(idx.match("b/llama-3")?.id).toBe("b/llama-3");
	});
	test("byId is exact, case-insensitive", () => {
		const idx = indexCatalog([entry("openai/gpt-4o")]);
		expect(idx.byId("OpenAI/GPT-4o")?.id).toBe("openai/gpt-4o");
		expect(idx.byId("gpt-4o")).toBeUndefined();
	});
});
