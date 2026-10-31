import { describe, expect, test } from "bun:test";
import { ALL_LEVELS, applyMatch, collectModels, formFromProvider, headerError, ctxLabel, newForm, newRow, shownLevels, slug, snapshot, toggleLevel, type Form } from "../src/lib/connection-form";
import type { CatalogModel, CustomProvider } from "../src/lib/types";

const filled = (over: Partial<Form> = {}): Form => ({ ...newForm(), name: "Proxy", id: "proxy", baseUrl: "http://x/v1", ...over });
const row = (over = {}) => ({ ...newRow(), id: "m1", ...over });
const none = () => undefined;

describe("connection id", () => {
	test("slug lowercases, starts with a letter and drops trailing dashes", () => {
		expect(slug("My Proxy!")).toBe("my-proxy");
		expect(slug("123 abc")).toBe("abc");
		expect(slug("a--")).toBe("a");
		expect(slug("x".repeat(100))).toHaveLength(64);
	});
	test("header checks name, id and address in that order", () => {
		expect(headerError(filled())).toBeNull();
		expect(headerError(filled({ name: " " }))).toContain("이름");
		expect(headerError(filled({ id: "9bad" }))).toContain("ID");
		expect(headerError(filled({ baseUrl: "" }))).toContain("Endpoint");
	});
});

describe("collecting models", () => {
	test("a valid row becomes a payload with trimmed fields", () => {
		const f = filled({ rows: [row({ name: " Nice ", id: " m1 " })] });
		const res = collectModels(f, true, none, false);
		expect(res).toEqual({ out: [{ id: "m1", name: "Nice", contextWindow: 128000, maxTokens: 8192, reasoning: false, vision: false }] });
	});
	test("catalogId follows the match, and 'manual' is only recorded once the catalog loaded", () => {
		const f = filled({ rows: [row()] });
		expect((collectModels(f, true, () => "a/b", false) as any).out[0].catalogId).toBe("a/b");
		expect((collectModels(f, true, none, true) as any).out[0].catalogId).toBeNull();
		expect("catalogId" in (collectModels(f, true, none, false) as any).out[0]).toBe(false);
	});
	test("thinking levels are kept in canonical order and only when reasoning", () => {
		const f = filled({ rows: [row({ reasoning: true, thinkingLevels: ["high", "low"] }), row({ id: "m2", reasoning: false, thinkingLevels: ["low"] })] });
		const out = (collectModels(f, true, none, false) as any).out;
		expect(out[0].thinkingLevels).toEqual(["low", "high"]);
		expect("thinkingLevels" in out[1]).toBe(false);
	});
	test("strict reports the model to fix; lenient skips a blank one", () => {
		const f = filled({ rows: [row(), newRow()] });
		expect(collectModels(f, true, none, false)).toMatchObject({ at: 1 });
		expect((collectModels(f, false, none, false) as any).out).toHaveLength(1);
	});
	test("limits are validated", () => {
		const bad = (over: object) => collectModels(filled({ rows: [row(over)] }), true, none, false);
		expect(bad({ contextWindow: "100" })).toHaveProperty("error");
		expect(bad({ maxTokens: "0" })).toHaveProperty("error");
		expect(bad({ contextWindow: "1000", maxTokens: "2000" })).toHaveProperty("error");
		expect(bad({ contextWindow: "1.5" })).toHaveProperty("error");
	});
	test("duplicate ids are rejected", () => {
		expect(collectModels(filled({ rows: [row(), row()] }), true, none, false)).toHaveProperty("error");
	});
});

describe("catalog match and editing", () => {
	const c = { id: "a/b", name: "b", contextWindow: 1000, maxTokens: 5000, reasoning: true, vision: true } as CatalogModel;
	test("a match fills limits (output capped by context) and capabilities", () => {
		const r = row({ thinkingLevels: ["low"] });
		applyMatch(r, c);
		expect(r).toMatchObject({ catalogId: "a/b", contextWindow: "1000", maxTokens: "1000", reasoning: true, vision: true, thinkingLevels: [] });
		applyMatch(r, null);
		expect(r.catalogId).toBeNull();
	});
	test("an edited provider round-trips and is clean until changed", () => {
		const p = { id: "p", name: "P", baseUrl: "http://x", api: "openai-completions", authRequired: false, models: [{ id: "m", contextWindow: 4096, maxTokens: 512, reasoning: false, vision: false }] } as unknown as CustomProvider;
		const f = formFromProvider(p);
		const before = snapshot(f);
		expect(f.isNew).toBe(false);
		expect(f.rows[0]).toMatchObject({ id: "m", contextWindow: "4096", name: "" });
		expect(snapshot(f)).toBe(before);
		f.rows[0]!.vision = true;
		expect(snapshot(f)).not.toBe(before);
	});
	test("model meta summarises context and capabilities", () => {
		expect(ctxLabel(row({ contextWindow: "128000", reasoning: true }))).toBe("128k");
		expect(ctxLabel(row({ contextWindow: "abc" }))).toBe("");
	});
});

describe("a model's starting strength", () => {
	test("is sent only for a reasoning chat model", () => {
		const f = filled({ rows: [row({ reasoning: true, defaultThinkingLevel: "high" }), row({ id: "m2", reasoning: false, defaultThinkingLevel: "low" }), row({ id: "m3", reasoning: true, imageGeneration: true, defaultThinkingLevel: "low" })] });
		const out = (collectModels(f, true, none, true) as any).out;
		expect(out.map((m: any) => m.defaultThinkingLevel)).toEqual(["high", undefined, undefined]);
	});
	test("is dropped when the model's own strengths do not include it", () => {
		const f = filled({ rows: [row({ reasoning: true, thinkingLevels: ["low", "high"] as any, defaultThinkingLevel: "max" })] });
		expect("defaultThinkingLevel" in (collectModels(f, true, none, true) as any).out[0]).toBe(false);
	});
	test("survives a round trip through the dialog's form", () => {
		const p = { id: "p", name: "P", baseUrl: "http://x", api: "openai-completions", authRequired: false, models: [{ id: "m", contextWindow: 4096, maxTokens: 512, reasoning: true, vision: false, defaultThinkingLevel: "low" }] } as unknown as CustomProvider;
		expect(formFromProvider(p).rows[0]!.defaultThinkingLevel).toBe("low");
	});
	test("is dropped when a match is picked whose catalog does not offer it", () => {
		const r = row({ reasoning: true, defaultThinkingLevel: "minimal" as const });
		applyMatch(r, { id: "a/b", name: "b", contextWindow: 1000, maxTokens: 500, reasoning: true, vision: true, image: false, levels: ["low", "high"] } as CatalogModel);
		expect(r.defaultThinkingLevel).toBeUndefined();
	});
});

describe("image generation models", () => {
	const img: CatalogModel = { id: "google/gemini-3.1-flash-image", name: "Gemini Image", contextWindow: 65536, maxTokens: 32768, reasoning: false, vision: true, image: true, levels: [] };
	test("matching an image model in the catalog turns image generation on, and a text model turns it off", () => {
		const r = row({ reasoning: true });
		applyMatch(r, img);
		expect(r.imageGeneration).toBe(true);
		expect(r.reasoning).toBe(false);
		applyMatch(r, { ...img, image: false });
		expect(r.imageGeneration).toBe(false);
	});
	test("the payload carries the flag and never reasoning", () => {
		const out = collectModels(filled({ rows: [row({ imageGeneration: true, reasoning: true, thinkingLevels: ["low"] })] }), true, none, true);
		expect("out" in out && out.out[0]).toMatchObject({ imageGeneration: true, reasoning: false });
		expect("out" in out && "thinkingLevels" in out.out[0]!).toBe(false);
	});
	test("a text model's payload has no flag", () => {
		const out = collectModels(filled({ rows: [row()] }), true, none, true);
		expect("out" in out && "imageGeneration" in out.out[0]!).toBe(false);
	});
});

describe("reasoning strengths of a matched model", () => {
	const c = { id: "anthropic/claude-haiku-5.5", name: "Haiku 5.5", contextWindow: 1e6, maxTokens: 1e5, reasoning: true, vision: true, image: false, levels: ["low", "medium", "high", "xhigh", "max"] } as CatalogModel;
	test("no own list: the matched catalog's strengths are shown", () => {
		expect(shownLevels(row(), c)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(shownLevels(row(), null)).toEqual([]);
	});
	test("the own list wins over the catalog, in canonical order", () => {
		expect(shownLevels(row({ thinkingLevels: ["high", "low"] }), c)).toEqual(["low", "high"]);
	});
	test("narrowing a matched model records the owner's own list", () => {
		const r = row();
		toggleLevel(r, c, "xhigh");
		expect(r.thinkingLevels).toEqual(["low", "medium", "high", "max"]);
		toggleLevel(r, c, "max");
		expect(r.thinkingLevels).toEqual(["low", "medium", "high"]);
	});
	test("picking the catalog's levels again means 'follow the catalog' (an empty list)", () => {
		const r = row({ thinkingLevels: ["low", "medium", "high", "max"] });
		toggleLevel(r, c, "xhigh");
		expect(r.thinkingLevels).toEqual([]);
	});
	test("switching a level off drops a default that lives on it", () => {
		const r = row({ defaultThinkingLevel: "max" as const });
		toggleLevel(r, c, "max");
		expect(r.defaultThinkingLevel).toBeUndefined();
		const kept = row({ defaultThinkingLevel: "high" as const });
		toggleLevel(kept, c, "max");
		expect(kept.defaultThinkingLevel).toBe("high");
	});
	test("an unmatched model keeps today's behaviour: on/off, and empty when none is left", () => {
		const r = row();
		toggleLevel(r, null, "max");
		expect(r.thinkingLevels).toEqual(["max"]);
		toggleLevel(r, null, "max");
		expect(r.thinkingLevels).toEqual([]);
	});
});

describe("thinking levels", () => {
	test("every strength the server accepts is offered on the chips, weakest first", () => {
		// The server pins this list to pi-ai's own set (server/test/thinking.test.ts); a new level there lands here.
		expect(ALL_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});
});
