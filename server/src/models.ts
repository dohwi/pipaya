import { getSupportedThinkingLevels, type Api, type CredentialStore, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "./store.ts";

export interface ModelRegistry {
	models: MutableModels;
	/** Persisted defaults take priority over startup environment defaults. */
	defaultSelection?: () => { provider: string; model: string; thinkingLevel?: ThinkingLevel } | null;
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
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	configured: boolean;
	/** false = the connection's own model list no longer contains this model */
	available: boolean;
}

export async function describeModels(reg: ModelRegistry, provider?: string, unavailable: (provider: string, id: string) => boolean = () => false): Promise<ModelInfo[]> {
	const available = new Set((await reg.models.getAvailable(provider)).map((m) => `${m.provider}/${m.id}`));
	return reg.models.getModels(provider).map((m: Model<Api>) => ({
		provider: m.provider,
		id: m.id,
		name: m.name,
		api: m.api,
		reasoning: m.reasoning,
		thinkingLevels: getSupportedThinkingLevels(m).filter((l): l is ThinkingLevel => l !== "off"),
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		vision: m.input.includes("image"),
		configured: available.has(`${m.provider}/${m.id}`),
		available: !unavailable(m.provider, m.id),
	}));
}
