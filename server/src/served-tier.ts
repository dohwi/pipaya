import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { HttpError } from "./errors.ts";
import { checkServiceTier, isOpenRouterChat, withServiceTier, type ModelRegistry } from "./models.ts";
import type { ServiceTier } from "./openrouter-catalog.ts";

/** What a reply records about its speed: the tier it asked for (absent = OpenRouter's own routing) and the one that served it. */
export interface TierStamp { requestedTier?: ServiceTier; servedTier?: ServiceTier }

const KNOWN: Record<string, ServiceTier> = { default: "default", standard: "default", flex: "flex", priority: "priority", fast: "priority", ultrafast: "ultrafast" };
const tierOf = (v: unknown): ServiceTier | undefined => (typeof v === "string" ? KNOWN[v.toLowerCase()] : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);

/**
 * The tier OpenRouter reports in one raw stream event, if it carries one. pi-ai parses these events but keeps no tier,
 * so this reads them as they pass (`onProviderStreamEvent`):
 * Chat Completions chunks carry `service_tier` at the top; Responses events inside `response`; Anthropic Messages inside
 * `usage` (`message_start` and `message_delta`), as `standard` for the base tier and with `speed: "fast"` beside a
 * priority answer. `null` (no tier known upstream) and unknown values are ignored.
 */
export function servedTierOf(event: unknown): ServiceTier | undefined {
	const e = obj(event);
	if (!e) return undefined;
	const usage = obj(e.usage) ?? obj(obj(e.message)?.usage);
	return tierOf(e.service_tier) ?? tierOf(obj(e.response)?.service_tier) ?? tierOf(usage?.service_tier) ?? (usage?.speed === "fast" ? "priority" : undefined);
}

/** Before each call the transport must still be OpenRouter, but a catalog outage does not stop a chat whose speed was checked when it was chosen. */
export async function checkRunTier(reg: ModelRegistry, provider: string, id: string, tier: ServiceTier) {
	try {
		await checkServiceTier(reg, provider, id, tier);
	} catch (e) {
		if (!(e instanceof HttpError && e.code === "catalog_unavailable")) throw e;
	}
}

/**
 * One streamed model call at a chosen speed (null = send none). On a direct OpenRouter connection the final reply is
 * stamped with the requested and the served tier, so a quiet fallback (Ultrafast to Fast, Fast to standard) is visible.
 */
export async function streamAtTier(reg: ModelRegistry, m: Model<Api>, ctx: Context, opts: SimpleStreamOptions | undefined, tier: ServiceTier | null): Promise<AssistantMessageEventStream> {
	if (tier) await checkRunTier(reg, m.provider, m.id, tier);
	else if (!isOpenRouterChat(m)) return reg.models.streamSimple(m, ctx, opts);
	let served: ServiceTier | undefined;
	const observer = opts?.onProviderStreamEvent;
	const base: SimpleStreamOptions = { ...opts, onProviderStreamEvent: (data, model) => {
		served = servedTierOf(data) ?? served;
		return observer?.(data, model);
	} };
	const inner = reg.models.streamSimple(m, ctx, tier ? withServiceTier(base, tier) : base);
	return stampTier(inner, () => ({ ...(tier ? { requestedTier: tier } : {}), ...(served ? { servedTier: served } : {}) }));
}

/** Passes a stream through and adds the stamp to its final message (the same object the caller's result resolves to). */
export function stampTier(src: AssistantMessageEventStream, stamp: () => TierStamp): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		for await (const ev of src) {
			if (ev.type === "done") Object.assign(ev.message, stamp());
			else if (ev.type === "error") Object.assign(ev.error, stamp());
			out.push(ev);
		}
		out.end();
	})().catch((e) => {
		const error = { role: "assistant", content: [], stopReason: "error", errorMessage: e instanceof Error ? e.message : String(e), timestamp: Date.now() } as unknown as AssistantMessage;
		out.push({ type: "error", reason: "error", error });
		out.end(error);
	});
	return out;
}
