import { expect, test } from "bun:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as messages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext, type Api, type AssistantMessage, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { checkAdvertisedTier, withServiceTier, type ModelRegistry } from "../src/models.ts";
import { servedTierOf, streamAtTier, type TierStamp } from "../src/served-tier.ts";
import { HttpError } from "../src/errors.ts";

const APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
type ChatApi = (typeof APIS)[number];

/** The built-in OpenRouter catalog has no Responses model; the same model on OpenRouter's Responses endpoint stands in. */
function routerModel(api: ChatApi): Model<Api> {
	const models = builtinProviders().find(p => p.id === "openrouter")!.getModels();
	const found = models.find(m => m.api === api);
	return found ?? { ...models.find(m => m.api === "openai-completions")!, api };
}

type Ctx = ReturnType<typeof normalizeContext>;

function callApi(model: Model<Api>, ctx: Ctx, options: SimpleStreamOptions) {
	if (model.api === "openai-completions") return completions(model as Model<"openai-completions">, ctx, options);
	if (model.api === "openai-responses") return responses(model as Model<"openai-responses">, ctx, options);
	return messages(model as Model<"anthropic-messages">, ctx, options);
}

const ctx = normalizeContext({ messages: [{ role: "user" as const, content: "test", timestamp: 0 }] });

// The real SDK serializes each request. The transport never opens a network connection.
for (const api of APIS) {
	test(`OpenRouter ${api}: selected tier reaches the wire, standard is explicit, auto sends none`, async () => {
		const model = routerModel(api);
		const bodies: Record<string, unknown>[] = [];
		const opts: SimpleStreamOptions = { apiKey: "fixture", reasoning: "high", maxRetries: 0,
			onPayload: body => ({ ...(body as object), metadata: { fixture: true } }),
			fetch: (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 400 }); }) as typeof fetch };
		for (const options of [withServiceTier(opts, "priority"), withServiceTier(opts, "default"), opts]) await callApi(model, ctx, options).result();
		expect(bodies).toHaveLength(3);
		expect(bodies[0]).toMatchObject({ service_tier: "priority", metadata: { fixture: true } });
		expect(bodies[1]).toEqual({ ...bodies[2], service_tier: "default" });
		expect(bodies[2]).not.toHaveProperty("service_tier");
		await expect(withServiceTier(opts, "priority").onPayload!({}, { ...model, baseUrl: "https://proxy.invalid/v1" })).rejects.toThrow("OpenRouter");
	});
}

/** One short streamed answer per API, reporting `served` the way OpenRouter does (Messages: inside usage, "standard" for the base tier). */
function sse(api: ChatApi, served: string | null): string {
	const lines = (events: object[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
	if (api === "openai-completions") {
		const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m", service_tier: served };
		return lines([
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
		]) + "data: [DONE]\n\n";
	}
	if (api === "openai-responses") {
		const msg = { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] };
		const response = (status: string, output: object[]) => ({ id: "r1", object: "response", status, model: "m", output, service_tier: served, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
		return lines([
			{ type: "response.created", sequence_number: 0, response: response("in_progress", []) },
			{ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...msg, status: "in_progress", content: [] } },
			{ type: "response.content_part.added", sequence_number: 2, output_index: 0, item_id: "m1", content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
			{ type: "response.output_text.delta", sequence_number: 3, output_index: 0, item_id: "m1", content_index: 0, delta: "hi" },
			{ type: "response.output_item.done", sequence_number: 4, output_index: 0, item: msg },
			{ type: "response.completed", sequence_number: 5, response: response("completed", [msg]) },
		]);
	}
	const usage = { input_tokens: 1, output_tokens: 1, service_tier: served, ...(served === "priority" ? { speed: "fast" } : {}) };
	const events: [string, object][] = [
		["message_start", { type: "message_start", message: { id: "a1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([name, e]) => `event: ${name}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function registry(model: Model<Api>, tiers: () => Promise<string[]>): ModelRegistry {
	return { models: { getModel: () => model, streamSimple: (m: Model<Api>, c: Ctx, o?: SimpleStreamOptions) => callApi(m, c, o ?? {}) } as unknown as ModelRegistry["models"], serviceTiers: tiers as ModelRegistry["serviceTiers"] };
}

for (const api of APIS) {
	test(`OpenRouter ${api}: the reply records the tier asked for and the tier that served it`, async () => {
		const model = routerModel(api);
		const reg = registry(model, async () => ["priority", "ultrafast"]);
		let served = "priority";
		let observed = 0;
		const opts: SimpleStreamOptions = { apiKey: "fixture", maxRetries: 0, onProviderStreamEvent: () => { observed++; },
			fetch: (async () => new Response(sse(api, served), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch };
		const fellBack = await (await streamAtTier(reg, model, ctx, opts, "ultrafast")).result();
		expect(fellBack.stopReason).toBe("stop");
		expect(fellBack).toMatchObject({ requestedTier: "ultrafast", servedTier: "priority" });
		expect(observed).toBeGreaterThan(0); // the caller's own observer still runs
		served = api === "anthropic-messages" ? "standard" : "default";
		expect(await (await streamAtTier(reg, model, ctx, opts, "priority")).result()).toMatchObject({ requestedTier: "priority", servedTier: "default" });
		// No tier chosen: nothing asked, but what OpenRouter routed to is still recorded.
		served = "priority";
		const auto: AssistantMessage & TierStamp = await (await streamAtTier(reg, model, ctx, opts, null)).result();
		expect(auto.servedTier).toBe("priority");
		expect(auto).not.toHaveProperty("requestedTier");
	});
}

test("served tier: every API's spelling, null and unknown values are not guesses", () => {
	expect(servedTierOf({ service_tier: "priority", choices: [] })).toBe("priority");
	expect(servedTierOf({ type: "response.completed", response: { service_tier: "flex" } })).toBe("flex");
	expect(servedTierOf({ type: "message_start", message: { usage: { service_tier: "standard" } } })).toBe("default");
	expect(servedTierOf({ type: "message_delta", usage: { speed: "fast" } })).toBe("priority");
	expect(servedTierOf({ service_tier: null })).toBeUndefined();
	expect(servedTierOf({ service_tier: "scale" })).toBeUndefined();
	expect(servedTierOf("data")).toBeUndefined();
});

test("a catalog outage does not stop a chat at its chosen speed; a wrong transport or an unoffered tier still does", async () => {
	const model = routerModel("openai-completions");
	const bodies: Record<string, unknown>[] = [];
	const opts: SimpleStreamOptions = { apiKey: "fixture", maxRetries: 0,
		fetch: (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(sse("openai-completions", "priority"), { headers: { "content-type": "text/event-stream" } }); }) as typeof fetch };
	const offline = registry(model, async () => { throw new Error("offline"); });
	expect(await (await streamAtTier(offline, model, ctx, opts, "priority")).result()).toMatchObject({ stopReason: "stop", servedTier: "priority" });
	expect(bodies.at(-1)).toMatchObject({ service_tier: "priority" });
	await expect(streamAtTier(registry(model, async () => []), model, ctx, opts, "priority")).rejects.toThrow("not available");
	const proxy = { ...model, baseUrl: "https://proxy.invalid/v1" };
	await expect(streamAtTier(registry(proxy, async () => ["priority"]), proxy, ctx, opts, "priority")).rejects.toBeInstanceOf(HttpError);
});

test("explicit standard does not require catalog availability; advertised tiers do", async () => {
	let lookups = 0;
	const offline = async () => { lookups++; throw new Error("offline"); };
	await checkAdvertisedTier(offline, "openai/test", "default");
	expect(lookups).toBe(0);
	await expect(checkAdvertisedTier(offline, "openai/test", "priority")).rejects.toThrow("OpenRouter endpoint information unavailable");
	expect(lookups).toBe(1);
});
