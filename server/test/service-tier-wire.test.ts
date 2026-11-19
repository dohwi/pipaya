import { expect, test } from "bun:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as messages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { withServiceTier } from "../src/models.ts";

// The real SDK serializes each request. The transport never opens a network connection.
for (const api of ["openai-completions", "anthropic-messages"] as const) {
	test(`OpenRouter ${api}: selected tier reaches the wire, default sends none`, async () => {
		const model = builtinProviders().find(p => p.id === "openrouter")!.getModels().find(m => m.api === api)!;
		const bodies: Record<string, unknown>[] = [];
		const opts: SimpleStreamOptions = { apiKey: "fixture", reasoning: "high", maxRetries: 0,
			onPayload: body => ({ ...(body as object), metadata: { fixture: true } }),
			fetch: (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 400 }); }) as typeof fetch };
		const ctx = normalizeContext({ messages: [{ role: "user" as const, content: "test", timestamp: 0 }] });
		for (const options of [withServiceTier(opts, "priority"), opts]) {
			const stream = api === "openai-completions" ? completions(model as Model<"openai-completions">, ctx, options) : messages(model as Model<"anthropic-messages">, ctx, options);
			await stream.result();
		}
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toMatchObject({ service_tier: "priority", metadata: { fixture: true } });
		expect(bodies[1]).not.toHaveProperty("service_tier");
		await expect(withServiceTier(opts, "priority").onPayload!({}, { ...model, baseUrl: "https://proxy.invalid/v1" })).rejects.toThrow("OpenRouter");
	});
}
