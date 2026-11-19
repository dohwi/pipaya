import { t } from "./i18n";
import type { ServiceTier } from "./types";

export const tierLabel = (tier: ServiceTier) => tier === "default" ? t("표준") : ({ flex: "Flex", priority: "Fast", ultrafast: "Ultrafast" })[tier];

/** Mirrors the server transport check for the connection editor; the server validates again on save. */
export const directRouter = (baseUrl: string) => /^https:\/\/(?:us\.|eu\.)?openrouter\.ai\/api(?:\/v1)?\/?$/i.test(baseUrl.trim());
