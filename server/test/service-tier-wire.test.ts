import { expect, test } from "bun:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as messages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { checkAdvertisedTier, withServiceTier } from "../src/models.ts";

// The real SDK serializes each request. The transport never opens a network connection.
for (const api of ["openai-completions", "anthropic-messages"] as const) {
	test(`OpenRouter ${api}: selected tier reaches the wire, standard is explicit, auto sends none`, async () => {
		const model = builtinProviders().find(p => p.id === "openrouter")!.getModels().find(m => m.api === api)!;
		const bodies: Record<string, unknown>[] = [];
		const opts: SimpleStreamOptions = { apiKey: "fixture", reasoning: "high", maxRetries: 0,
			onPayload: body => ({ ...(body as object), metadata: { fixture: true } }),
			fetch: (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 400 }); }) as typeof fetch };
		const ctx = normalizeContext({ messages: [{ role: "user" as const, content: "test", timestamp: 0 }] });
		for (const options of [withServiceTier(opts, "priority"), withServiceTier(opts, "default"), opts]) {
			const stream = api === "openai-completions" ? completions(model as Model<"openai-completions">, ctx, options) : messages(model as Model<"anthropic-messages">, ctx, options);
			await stream.result();
		}
		expect(bodies).toHaveLength(3);
		expect(bodies[0]).toMatchObject({ service_tier: "priority", metadata: { fixture: true } });
		expect(bodies[1]).toEqual({ ...bodies[2], service_tier: "default" });
		expect(bodies[2]).not.toHaveProperty("service_tier");
		await expect(withServiceTier(opts, "priority").onPayload!({}, { ...model, baseUrl: "https://proxy.invalid/v1" })).rejects.toThrow("OpenRouter");
	});
}

test("explicit standard does not require catalog availability; advertised tiers do", async () => {
	let lookups = 0;
	const offline = async () => { lookups++; throw new Error("offline"); };
	await checkAdvertisedTier(offline, "openai/test", "default");
	expect(lookups).toBe(0);
	await expect(checkAdvertisedTier(offline, "openai/test", "priority")).rejects.toThrow("OpenRouter endpoint information unavailable");
	expect(lookups).toBe(1);
});
