import { t } from "./i18n";
import type { ServiceTier } from "./types";

export const tierLabel = (tier: ServiceTier) => tier === "default" ? t("표준") : ({ flex: "flex", priority: "fast", ultrafast: "ultrafast" })[tier];

export type TierMeta = { requestedTier?: ServiceTier; servedTier?: ServiceTier };

export type ReplySpeed =
	| { kind: "none" }
	| { kind: "fell"; asked: ServiceTier; served: ServiceTier; label: string }
	| { kind: "tier"; tier: ServiceTier; confirmed: boolean; label: string };

/**
 * The speed to show on an assistant reply, or "none" when it ran at standard/default speed.
 * A fallback (requested !== served) is always shown even if it fell back to default; otherwise
 * the served tier (direct OpenRouter) or requested tier (proxies without servedTier) is shown
 * only when it is not `"default"`.
 */
export function replySpeed(parts: readonly TierMeta[], tail: TierMeta | undefined): ReplySpeed {
	const fell = parts.find((p) => p.requestedTier && p.servedTier && p.servedTier !== p.requestedTier);
	if (fell?.requestedTier && fell.servedTier) {
		return { kind: "fell", asked: fell.requestedTier, served: fell.servedTier, label: `${tierLabel(fell.requestedTier)} → ${tierLabel(fell.servedTier)}` };
	}
	const tier = tail?.servedTier ?? tail?.requestedTier;
	if (!tier || tier === "default") return { kind: "none" };
	return { kind: "tier", tier, confirmed: Boolean(tail?.servedTier), label: tierLabel(tier) };
}

/** Mirrors the server transport check for the connection editor; the server validates again on save. */
export const directRouter = (baseUrl: string) => /^https:\/\/(?:us\.|eu\.)?openrouter\.ai\/api(?:\/v1)?\/?$/i.test(baseUrl.trim());

/** The speeds besides standard, slow to fast, as the speed rows list them. */
export const EXTRA_TIERS = ["flex", "priority", "ultrafast"] as const satisfies readonly ServiceTier[];

/** The request formats a proxy passes `service_tier` on as is (the server checks the same list). */
export const proxyTierApi = (api: string) => api === "openai-completions" || api === "openai-responses";

/** A model a speed can be chosen for: a direct OpenRouter chat, or a proxy model with its own speeds or an OpenRouter match. */
export const takesTier = (m: { openRouterTiers?: boolean; serviceTiers?: readonly ServiceTier[]; tierCatalogId?: string } | null | undefined) =>
	!!m && (!!m.openRouterTiers || !!m.serviceTiers?.length || !!m.tierCatalogId);
