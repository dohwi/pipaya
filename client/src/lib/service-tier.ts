import { t } from "./i18n";
import type { ServiceTier } from "./types";

export const tierLabel = (tier: ServiceTier) => tier === "default" ? t("표준") : ({ flex: "Flex", priority: "Fast", ultrafast: "Ultrafast" })[tier];

/** Mirrors the server transport check for the connection editor; the server validates again on save. */
export const directRouter = (baseUrl: string) => /^https:\/\/(?:us\.|eu\.)?openrouter\.ai\/api(?:\/v1)?\/?$/i.test(baseUrl.trim());

/** The speeds besides standard, slow to fast, as the speed rows list them. */
export const EXTRA_TIERS = ["flex", "priority", "ultrafast"] as const satisfies readonly ServiceTier[];

/** The request formats a proxy passes `service_tier` on as is (the server checks the same list). */
export const proxyTierApi = (api: string) => api === "openai-completions" || api === "openai-responses";

/** A model a speed can be chosen for: a direct OpenRouter chat, or a proxy model whose owner listed its speeds. */
export const takesTier = (m: { openRouterTiers?: boolean; serviceTiers?: readonly ServiceTier[] } | null | undefined) => !!m && (!!m.openRouterTiers || !!m.serviceTiers?.length);
