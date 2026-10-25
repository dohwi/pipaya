import { describe, expect, test } from "bun:test";
import { applyMatch, collectModels, formFromProvider, headerError, ctxLabel, newForm, newRow, slug, snapshot, type Form } from "../src/lib/connection-form";
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
