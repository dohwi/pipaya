import { getSupportedThinkingLevels, type Api, type CredentialStore, type Model, type MutableModels, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { THINKING_LEVELS, type ThinkingLevel } from "./store.ts";

import type { ServiceTier } from "./openrouter-catalog.ts";
import { badRequest, HttpError } from "./errors.ts";

/** Match the actual transport destination, not the provider name (custom connections can shadow built-ins). */
export const isOpenRouterChat = (m: Pick<Model<Api>, "api" | "baseUrl"> | undefined) => !!m && /^https:\/\/(?:us\.|eu\.)?openrouter\.ai\/api(?:\/v1)?\/?$/.test(m.baseUrl) && ["openai-completions", "openai-responses", "anthropic-messages"].includes(m.api);

/** The OpenAI request formats that carry `service_tier` as is; a proxy speaking Anthropic Messages would read it differently. */
export const PROXY_TIER_APIS: readonly string[] = ["openai-completions", "openai-responses"];

type TierTarget = Pick<Model<Api>, "api" | "baseUrl"> | undefined;
const isProxy = (m: TierTarget): m is Pick<Model<Api>, "api" | "baseUrl"> => !!m && !isOpenRouterChat(m) && PROXY_TIER_APIS.includes(m.api);

/**
 * The speeds the owner listed for this proxy model (a CLIProxyAPI GPT model takes `priority`): `undefined` = none listed,
 * so it follows the OpenRouter model it is matched to; `[]` = switched off. pi-ai's `Model` has no slot for it, so the
 * configuration carries it on the model object; an OpenRouter model reads its speeds from the catalog, so it never has one.
 */
export function ownTiers(m: TierTarget): ServiceTier[] | undefined {
	if (!isProxy(m)) return undefined;
	const v = (m as { serviceTiers?: unknown }).serviceTiers;
	return Array.isArray(v) ? v.filter((t): t is ServiceTier => t === "flex" || t === "priority" || t === "ultrafast") : undefined;
}

/** The OpenRouter model whose speeds a proxy model follows (set by the configuration when it has a match and no own list). */
export function tierCatalogId(m: TierTarget): string | undefined {
	if (!isProxy(m) || ownTiers(m)) return undefined;
	const v = (m as { tierCatalogId?: unknown }).tierCatalogId;
	return typeof v === "string" && v ? v : undefined;
}

/** A model a speed can be sent to: a direct OpenRouter chat, or a proxy model with its own speeds or an OpenRouter match. */
export const takesServiceTier = (m: TierTarget) => isOpenRouterChat(m) || !!ownTiers(m)?.length || !!tierCatalogId(m);

const NO_TIER = "service tier requires an OpenRouter connection, or a proxy model matched to OpenRouter or with listed speeds";

/** OpenRouter accepts service_tier on all three chat APIs; a proxy model on the OpenAI formats. Check the final, auth-resolved target too. */
export function withServiceTier(opts: SimpleStreamOptions | undefined, tier: ServiceTier): SimpleStreamOptions {
	return { ...opts, onPayload: async (body, target) => {
		if (!takesServiceTier(target)) throw badRequest(NO_TIER);
		const payload = await opts?.onPayload?.(body, target) ?? body;
		return { ...(payload as object), service_tier: tier };
	} };
}

/** Hosts that reject request fields they do not know (`include_reasoning` would fail the whole call). */
const STRICT_OPENAI_HOST = /(?:^|\.)(?:api\.openai\.com|openai\.azure\.com)$/i;

/**
 * Whether a call to this model asks for its thoughts to be streamed. Only the owner's own Chat Completions connections
 * (configuration marks them): a proxy like CLIProxyAPI reads `reasoning_effort` as depth only and leaves Claude's thinking
 * hidden unless the request says to show it, so the thinking line would stay empty until the answer starts.
 */
export function showsReasoning(m: Pick<Model<Api>, "api" | "baseUrl"> | undefined): boolean {
	if (!m || m.api !== "openai-completions" || isOpenRouterChat(m) || !(m as { streamReasoning?: unknown }).streamReasoning) return false;
	try {
		return !STRICT_OPENAI_HOST.test(new URL(m.baseUrl).hostname);
	} catch {
		return false;
	}
}

/** Adds `include_reasoning: true` to a reasoning call on such a connection, so the thinking arrives as it is written. */
export function withVisibleReasoning(opts: SimpleStreamOptions | undefined, m: Model<Api>): SimpleStreamOptions | undefined {
	if (!opts?.reasoning || !m.reasoning || !showsReasoning(m)) return opts;
	return { ...opts, onPayload: async (body, target) => {
		const payload = await opts.onPayload?.(body, target) ?? body;
		return showsReasoning(target) ? { ...(payload as object), include_reasoning: true } : payload;
	} };
}

/** A proxy model takes standard and its own speeds, else the speeds OpenRouter lists for the model it is matched to. */
export async function checkServiceTier(reg: ModelRegistry, provider: string, id: string, tier: ServiceTier) {
	const m = reg.models.getModel(provider, id);
	if (isOpenRouterChat(m)) return checkAdvertisedTier(reg.serviceTiers, id, tier);
	if (!takesServiceTier(m)) throw badRequest(NO_TIER);
	const own = ownTiers(m);
	if (own) {
		if (tier !== "default" && !own.includes(tier)) throw badRequest("service tier is not available for this model");
		return;
	}
	await checkAdvertisedTier(reg.serviceTiers, tierCatalogId(m)!, tier);
}

/** Standard is an explicit routing instruction, not an optional paid endpoint in the catalog. */
export async function checkAdvertisedTier(lookup: ModelRegistry["serviceTiers"], id: string, tier: ServiceTier) {
	if (tier === "default") return;
	const tiers = await lookup?.(id).catch(() => { throw new HttpError(502, "catalog_unavailable", "OpenRouter endpoint information unavailable"); });
	if (!tiers?.includes(tier)) throw badRequest("service tier is not available for this model");
}

export interface ModelRegistry {
	models: MutableModels;
	serviceTiers?: (id: string) => Promise<ServiceTier[]>;
	/** Whether this model makes pictures (image generation) instead of writing text. */
	isImageModel?: (provider: string, id: string) => boolean;
	/** Persisted defaults take priority over startup environment defaults. */
	defaultSelection?: () => { provider: string; model: string; thinkingLevel?: ThinkingLevel; serviceTier?: ServiceTier | null } | null;
}

/**
 * The `reasoning` option for a model call: "off" means "ask for no reasoning at all" (the provider keeps its own
 * default), so nothing is sent — passing it on would turn thinking *on* for providers that read a level as a switch.
 */
export function reasoningOption(level: ThinkingLevel | undefined, model: Model<Api> | undefined): { reasoning?: Exclude<ThinkingLevel, "off"> } {
	return level && level !== "off" && model?.reasoning ? { reasoning: level } : {};
}

/**
 * The strength a new chat with this model starts at, when its owner chose one. pi-ai's `Model` has no slot for it, so
 * the configuration carries it on the model object it registers.
 */
export function modelDefaultLevel(m: Model<Api>): ThinkingLevel | undefined {
	const v = (m as Model<Api> & { defaultThinkingLevel?: unknown }).defaultThinkingLevel;
	return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevel) : undefined;
}

/** Only a model a speed can be sent to (see `takesServiceTier`) can declare a starting tier. */
export function modelDefaultTier(m: Model<Api> | undefined): ServiceTier | undefined {
	return takesServiceTier(m) ? (m as Model<Api> & { defaultServiceTier?: ServiceTier }).defaultServiceTier : undefined;
}

/** Starts with every pi-ai built-in provider (OpenAI, Anthropic, Google, OpenRouter, Copilot …); Configuration adds the user's own endpoints on top. */
export function createModelRegistry(credentials: CredentialStore): ModelRegistry {
	return { models: builtinModels({ credentials }) };
}

/** A fresh copy of the built-in provider with this id, if there is one (a custom endpoint may have replaced it). */
export function builtinProvider(id: string) {
	return builtinProviders().find((p) => p.id === id);
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	/** Reasoning strengths this model accepts, weakest first. Empty when it has no reasoning. */
	thinkingLevels: ThinkingLevel[];
	openRouterTiers?: boolean;
	/** A proxy model's own speeds besides standard (absent on OpenRouter models, which list theirs from the catalog) */
	serviceTiers?: ServiceTier[];
	/** A proxy model that follows the speeds OpenRouter lists for this catalog id */
	tierCatalogId?: string;
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	/** Makes pictures instead of text */
	imageGeneration: boolean;
	/** Brand mark chosen in the connection settings; absent = picked from the id */
	icon?: string;
	/** Where a new chat with this model starts, when its owner chose a strength (absent = the device's last choice) */
	defaultThinkingLevel?: ThinkingLevel;
	defaultServiceTier?: ServiceTier;
	configured: boolean;
	/** false = the connection's own model list no longer contains this model */
	available: boolean;
}

export async function describeModels(reg: ModelRegistry, provider?: string, unavailable: (provider: string, id: string) => boolean = () => false, icons: ReadonlyMap<string, string> = new Map()): Promise<ModelInfo[]> {
	const available = new Set((await reg.models.getAvailable(provider)).map((m) => `${m.provider}/${m.id}`));
	return reg.models.getModels(provider).map((m: Model<Api>) => ({
		provider: m.provider,
		id: m.id,
		name: m.name,
		api: m.api,
		...(isOpenRouterChat(m) ? { openRouterTiers: true, defaultServiceTier: modelDefaultTier(m) } : {}),
		...(ownTiers(m)?.length ? { serviceTiers: ownTiers(m) } : {}),
		...(tierCatalogId(m) ? { tierCatalogId: tierCatalogId(m) } : {}),
		...(!isOpenRouterChat(m) && modelDefaultTier(m) ? { defaultServiceTier: modelDefaultTier(m) } : {}),
		reasoning: m.reasoning,
		// Every strength the model accepts, `off` included: "empty" means the model has no reasoning at all.
		thinkingLevels: m.reasoning ? getSupportedThinkingLevels(m).filter((l): l is ThinkingLevel => THINKING_LEVELS.includes(l as ThinkingLevel)) : [],
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		vision: m.input.includes("image"),
		imageGeneration: reg.isImageModel?.(m.provider, m.id) ?? false,
		...(icons.has(`${m.provider}/${m.id}`) ? { icon: icons.get(`${m.provider}/${m.id}`) } : {}),
		...(m.reasoning && modelDefaultLevel(m) ? { defaultThinkingLevel: modelDefaultLevel(m)! } : {}),
		configured: available.has(`${m.provider}/${m.id}`),
		available: !unavailable(m.provider, m.id),
	}));
}
