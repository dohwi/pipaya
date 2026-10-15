import { describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { catalogThinkingLevelMap } from "../src/thinking-catalog.ts";

const levels = (id: string) => getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: catalogThinkingLevelMap(id) } as Model<any>).filter((l) => l !== "off");

describe("thinking levels looked up by model name", () => {
	test("a full catalog id and the bare name give the same strengths", () => {
		expect(levels("openai/gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
		expect(levels("gpt-5")).toEqual(levels("openai/gpt-5"));
	});
	test("a model without 'minimal' does not offer it", () => {
		expect(levels("gpt-5.1")).not.toContain("minimal");
	});
	test("an unknown name changes nothing", () => {
		expect(catalogThinkingLevelMap("no-such-model-xyz")).toBeUndefined();
		expect(levels("no-such-model-xyz")).toEqual(["minimal", "low", "medium", "high"]);
	});
	test("lookup is case-insensitive", () => {
		expect(levels("GPT-5")).toEqual(levels("gpt-5"));
	});
});
