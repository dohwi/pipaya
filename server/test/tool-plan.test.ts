import { describe, expect, test } from "bun:test";
import { describeTools, enabledTools, planTools } from "../src/tool-plan.ts";
import type { ToolContext, ToolDef } from "../src/tools.ts";

const base = { chosen: ["read", "bash"], always: ["peer_send"], disabled: [] as string[] };

describe("planTools", () => {
	test("lists the session's tools first, then the always-on ones, then the image tool", () => {
		expect(planTools({ ...base, image: "generate_image" })).toEqual([
			{ name: "read", source: "session", off: false },
			{ name: "bash", source: "session", off: false },
			{ name: "peer_send", source: "always", off: false },
			{ name: "generate_image", source: "image", off: false },
		]);
	});

	test("a tool that qualifies twice keeps its first reason", () => {
		const plan = planTools({ chosen: ["read", "peer_send"], always: ["peer_send", "read"], disabled: [] });
		expect(plan.map((t) => [t.name, t.source])).toEqual([["read", "session"], ["peer_send", "session"]]);
	});

	test("a switched-off tool stays listed but is withheld from the agent", () => {
		const plan = planTools({ ...base, disabled: ["bash", "peer_send"] });
		expect(plan.filter((t) => t.off).map((t) => t.name)).toEqual(["bash", "peer_send"]);
		expect(enabledTools(plan)).toEqual(["read"]);
	});

	test("without an image model there is no image tool", () => {
		expect(planTools(base).some((t) => t.source === "image")).toBe(false);
	});
});

describe("describeTools", () => {
	const ctx = {} as ToolContext;
	const def = (over: Partial<ToolDef> & { parameters?: unknown; throws?: boolean }): ToolDef =>
		({ name: "t", description: "d", create: () => { if (over.throws) throw new Error("not here"); return { parameters: over.parameters } as never; }, ...over }) as ToolDef;

	test("reports name, source, state, parameters and the size the model pays for", () => {
		const plan = planTools({ chosen: ["a", "b"], always: [], disabled: ["b"] });
		const out = describeTools(plan, { a: def({ name: "a", description: "does a", parameters: { type: "object" } }), b: def({ name: "b" }) }, "/w", ctx);
		expect(out.map((t) => [t.name, t.enabled])).toEqual([["a", true], ["b", false]]);
		expect(out[0]).toMatchObject({ description: "does a", parameters: { type: "object" }, source: "session" });
		expect(out[0]!.bytes).toBe(Buffer.byteLength(JSON.stringify({ name: "a", description: "does a", parameters: { type: "object" } })));
	});

	test("a tool without a definition is skipped, and one that cannot be built still shows", () => {
		const plan = planTools({ chosen: ["known", "broken", "missing"], always: [], disabled: [] });
		const out = describeTools(plan, { known: def({ name: "known" }), broken: def({ name: "broken", throws: true }) }, "/w", ctx);
		expect(out.map((t) => t.name)).toEqual(["known", "broken"]);
		expect(out[1]!.parameters).toBeNull();
	});

	test("a schema that carries a function is copied as plain data", () => {
		const plan = planTools({ chosen: ["x"], always: [], disabled: [] });
		const out = describeTools(plan, { x: def({ name: "x", parameters: { type: "object", check: () => true } }) }, "/w", ctx);
		expect(out[0]!.parameters).toEqual({ type: "object" });
	});
});
