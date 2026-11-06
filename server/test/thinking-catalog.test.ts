import { describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { catalogThinkingLevelMap } from "../src/thinking-catalog.ts";

const levels = (id: string) => getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: catalogThinkingLevelMap(id) } as Model<any>);

describe("thinking levels looked up by model name", () => {
	test("a full catalog id and the bare name give the same strengths", () => {
		// gpt-5 cannot be told to skip reasoning (its map marks "off" unsupported), so it is not offered.
		expect(levels("openai/gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
		expect(levels("gpt-5")).toEqual(levels("openai/gpt-5"));
	});
	test("a model without 'minimal' does not offer it", () => {
		expect(levels("gpt-5.1")).not.toContain("minimal");
	});
	test("an unknown name changes nothing", () => {
		expect(catalogThinkingLevelMap("no-such-model-xyz")).toBeUndefined();
		expect(levels("no-such-model-xyz")).toEqual(["off", "minimal", "low", "medium", "high"]);
	});
	test("lookup is case-insensitive", () => {
		expect(levels("GPT-5")).toEqual(levels("gpt-5"));
	});
});

test("a reasoning model without a catalog map still matches and offers the default strengths", async () => {
	const { catalogMatch } = await import("../src/thinking-catalog.ts");
	expect(catalogMatch("anthropic/claude-sonnet-4.5")?.id).toBe("anthropic/claude-sonnet-4.5");
	expect(levels("claude-sonnet-4.5")).toEqual(["off", "minimal", "low", "medium", "high"]);
});

test("measured strengths override the OpenRouter catalog", () => {
	for (const id of ["mistral-large-4", "mistralai/mistral-large-4-0"]) expect(levels(id)).toEqual(["low", "medium", "high"]);
	for (const id of ["glm-5.3", "z-ai/glm-5.3"]) expect(levels(id)).toEqual(["low", "high", "max"]);
	for (const id of ["deepseek-4.1-flash", "deepseek/deepseek-v4.1-flash"]) expect(levels(id)).toEqual(["off", "low", "high", "xhigh", "max"]);
});

test("catalogEntries lists image generation models too", async () => {
	const { catalogEntries } = await import("../src/thinking-catalog.ts");
	const e = catalogEntries().find((c) => c.id === "google/gemini-3.1-flash-image");
	expect(e).toBeDefined();
	expect(e!.reasoning).toBe(false);
	expect(catalogEntries().filter((c) => c.id === "google/gemini-3.1-flash-image")).toHaveLength(1);
});
