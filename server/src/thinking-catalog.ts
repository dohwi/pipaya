import { OPENROUTER_IMAGE_MODELS, OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";

type LevelMap = NonNullable<Model<any>["thinkingLevelMap"]>;
export interface CatalogMatch {
	/** The catalog's own id, e.g. "google/gemini-3.1-pro-preview" */
	id: string;
	map: LevelMap;
}

/**
 * "vendor/Model-1:batch" and "Model-1-preview" name the same model for our purposes: compare only the last path
 * segment, without a `:variant` suffix or a trailing `-preview`.
 */
const normalize = (id: string) => id.split("/").pop()!.split(":")[0]!.toLowerCase().replace(/-preview$/, "");

function build() {
	const byName = new Map<string, CatalogMatch | null>();
	const exact = new Map<string, CatalogMatch>();
	for (const m of Object.values(OPENROUTER_MODELS as Record<string, Model<any>>)) {
		if (!m.reasoning || m.id.includes(":") || m.id.startsWith("~") || !m.thinkingLevelMap) continue;
		const match = { id: m.id, map: m.thinkingLevelMap };
		exact.set(m.id.toLowerCase(), match);
		const key = normalize(m.id);
		const seen = byName.get(key);
		// Same name from several vendors with different maps: ambiguous, so nothing is guessed.
		if (seen === null) continue;
		if (seen && JSON.stringify(seen.map) !== JSON.stringify(match.map)) byName.set(key, null);
		else if (!seen) byName.set(key, match);
	}
	return { byName, exact };
}

let built: ReturnType<typeof build> | undefined;

/** The OpenRouter catalog entry (and its reasoning strengths) for this model id, or `undefined` when it is unknown or ambiguous. */
export function catalogMatch(id: string): CatalogMatch | undefined {
	built ??= build();
	return built.exact.get(id.toLowerCase()) ?? built.byName.get(normalize(id)) ?? undefined;
}

/** The reasoning strengths OpenRouter's catalog lists for this model id, or `undefined` when it is unknown or ambiguous. */
export const catalogThinkingLevelMap = (id: string): LevelMap | undefined => catalogMatch(id)?.map;

export interface CatalogEntry {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	vision: boolean;
	/** Reasoning strengths, weakest first; empty without reasoning */
	levels: string[];
}

let listed: CatalogEntry[] | undefined;

/** The image catalog lists no limits; these are used for image-generation models. */
const IMAGE_CONTEXT_WINDOW = 65_536;
const IMAGE_MAX_TOKENS = 32_768;

const listable = (id: string) => !id.includes(":") && !id.startsWith("~");

/** Every model in the bundled OpenRouter catalog, chat and image generation (no `:variant` ids), for autocomplete when registering a model. */
export function catalogEntries(): CatalogEntry[] {
	if (listed) return listed;
	const byId = new Map<string, CatalogEntry>();
	for (const m of Object.values(OPENROUTER_MODELS as Record<string, Model<any>>)) {
		if (!listable(m.id)) continue;
		byId.set(m.id, {
			id: m.id,
			name: m.name,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			reasoning: Boolean(m.reasoning),
			vision: m.input.includes("image"),
			levels: m.reasoning ? getSupportedThinkingLevels(m).filter((l) => l !== "off") : [],
		});
	}
	// A model listed as both chat and image keeps its chat entry (it has real limits).
	for (const m of Object.values(OPENROUTER_IMAGE_MODELS as Record<string, { id: string; name: string; input: readonly string[] }>)) {
		if (!listable(m.id) || byId.has(m.id)) continue;
		byId.set(m.id, {
			id: m.id, name: m.name, contextWindow: IMAGE_CONTEXT_WINDOW, maxTokens: IMAGE_MAX_TOKENS,
			reasoning: false, vision: m.input.includes("image"), levels: [],
		});
	}
	listed = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	return listed;
}
