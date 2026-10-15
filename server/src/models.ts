import { createModels, getSupportedThinkingLevels, type Api, type CredentialStore, type Model, type MutableModels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./store.ts";

export interface ModelRegistry {
	models: MutableModels;
	/** Persisted defaults take priority over startup environment defaults. */
	defaultSelection?: () => { provider: string; model: string; thinkingLevel?: ThinkingLevel } | null;
}

/** Starts empty. Configuration loads only user-registered endpoints and models. */
export function createModelRegistry(credentials: CredentialStore): ModelRegistry {
	return { models: createModels({ credentials }) };
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
}

export async function describeModels(reg: ModelRegistry, provider?: string): Promise<ModelInfo[]> {
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
	}));
}
