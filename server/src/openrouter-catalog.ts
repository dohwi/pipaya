import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { OPENROUTER_IMAGE_MODELS, OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { THINKING_LEVELS, type ThinkingLevel } from "./store.ts";

type LevelMap = NonNullable<Model<any>["thinkingLevelMap"]>;

/**
 * The OpenRouter model list the settings screens autocomplete from.
 *
 * pi-ai ships a generated snapshot of `https://openrouter.ai/api/v1/models`, so a model OpenRouter added last week is
 * missing from the picker until a pipaya release bumps that dependency. This module keeps the snapshot as the floor and
 * puts the live list on top: fetched from OpenRouter, cached in `<dataDir>/openrouter-catalog.json`, and reused for
 * `CACHE_MS`, so a settings dialog never waits on the network twice. A failed fetch keeps serving the cache (or the
 * bundled snapshot), so the picker never goes empty.
 *
 * The live list wins for what it knows (ids, names, limits, modalities); the bundled snapshot keeps the reasoning
 * strengths it already carries (they are hand-checked, see `STRENGTH_OVERRIDES`) and fills in what the API does not say.
 */

export interface CatalogEntry {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	vision: boolean;
	/** A model that makes pictures (run by an extension) */
	image: boolean;
	/** Reasoning strengths, weakest first; empty without reasoning */
	levels: ThinkingLevel[];
}

export interface CatalogMatch {
	/** The catalog's own id, e.g. "google/gemini-3.1-pro-preview" */
	id: string;
	map: LevelMap;
}

/** Where the chat list is read from. `PIPAYA_OPENROUTER_URL` points it elsewhere (a mirror, or a test server). */
const DEFAULT_URL = "https://openrouter.ai/api/v1/models";
/** The picture-making models are listed apart from the chat ones: `/api/v1/models` -> `/api/v1/images/models`. */
const imagesUrl = (chatUrl: string) => chatUrl.replace(/\/models\/?$/, "") + "/images/models";
const FETCH_TIMEOUT_MS = 8_000;
/** How long a fetched list is reused before a settings screen asks OpenRouter again. */
export const CACHE_MS = 6 * 3600_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The bundled image catalog lists no limits; these are used for picture-making models. */
const IMAGE_CONTEXT_WINDOW = 65_536;
const IMAGE_MAX_TOKENS = 32_768;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * "vendor/Model-1:batch" and "Model-1-preview" name the same model for our purposes: compare only the last path
 * segment, without a `:variant` suffix or a trailing `-preview`.
 */
const normalize = (id: string) => id.split("/").pop()!.split(":")[0]!.toLowerCase().replace(/-preview$/, "");

const listable = (id: string) => !id.includes(":") && !id.startsWith("~");

/**
 * Strengths measured against the real APIs that win over OpenRouter's (stale or incomplete) catalog. Keys are normalized
 * names (last path segment, lowercase); list every spelling a gateway may expose. Checked 2026-11-06.
 */
const STRENGTH_OVERRIDES: Record<string, LevelMap> = {
	// low/medium/high only; "none" is rejected
	...Object.fromEntries(["mistral-large-4", "mistral-large-4-0"].map((k) => [k, { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } as LevelMap])),
	// low/high/max
	...Object.fromEntries(["glm-5.3", "zai-glm-5-3"].map((k) => [k, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } as LevelMap])),
	// low/high/xhigh/max (no off, by policy)
	...Object.fromEntries(["deepseek-4.1-flash", "deepseek-v4.1-flash", "deepseek-v4-1-flash-1017"].map((k) => [k, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: "xhigh", max: "max" } as LevelMap])),
};

/** The strengths a model offers, from a map: a level the map marks null is not offered. */
const levelsOf = (m: Model<any>): ThinkingLevel[] =>
	getSupportedThinkingLevels(m).filter((l): l is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(l));

const withOverride = (id: string, map: LevelMap): LevelMap => STRENGTH_OVERRIDES[normalize(id)] ?? map;

/** One entry of OpenRouter's `/api/v1/models` or `/api/v1/images/models` (only the fields we read). */
interface LiveModel {
	id: string;
	name?: string;
	context_length?: number | null;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	top_provider?: { max_completion_tokens?: number | null } | null;
	reasoning?: { mandatory?: boolean; supported_efforts?: string[] | null } | null;
	supported_parameters?: string[] | null;
}

/**
 * The strengths OpenRouter's own metadata implies. A `mandatory` model cannot be told to stop reasoning, so "off" is
 * not offered; the efforts it lists are the ones it accepts ("none" is the wire value for off).
 */
function liveMap(live: LiveModel): LevelMap | undefined {
	const r = live.reasoning;
	if (!r) return undefined;
	const efforts = new Set(r.supported_efforts ?? []);
	const map: Record<string, string | null> = { off: r.mandatory ? null : "none" };
	// No effort levels listed: pi-ai's default set (off through high), minus off when reasoning is mandatory.
	if (!efforts.size) return map;
	for (const level of THINKING_LEVELS) {
		if (level === "off") continue;
		map[level] = efforts.has(level) ? level : null;
	}
	return map;
}

/** The bundled snapshot: chat entries, image entries, and the reasoning map each chat model carries. */
function bundled() {
	const entries = new Map<string, CatalogEntry>();
	const maps = new Map<string, LevelMap>();
	for (const m of Object.values(OPENROUTER_MODELS as Record<string, Model<any>>)) {
		if (!listable(m.id)) continue;
		const map = withOverride(m.id, m.thinkingLevelMap ?? {});
		entries.set(m.id, {
			id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
			reasoning: Boolean(m.reasoning), vision: m.input.includes("image"), image: false,
			levels: m.reasoning ? levelsOf({ ...m, thinkingLevelMap: map } as Model<any>) : [],
		});
		if (m.reasoning) maps.set(m.id, map);
	}
	// A model listed as both chat and image keeps its chat entry (it has real limits).
	for (const m of Object.values(OPENROUTER_IMAGE_MODELS as Record<string, { id: string; name: string; input: readonly string[] }>)) {
		if (!listable(m.id) || entries.has(m.id)) continue;
		entries.set(m.id, {
			id: m.id, name: m.name, contextWindow: IMAGE_CONTEXT_WINDOW, maxTokens: IMAGE_MAX_TOKENS,
			reasoning: false, vision: m.input.includes("image"), image: true, levels: [],
		});
	}
	return { entries, maps };
}

let floor: ReturnType<typeof bundled> | undefined;
const base = () => (floor ??= bundled());

/** A chat model from the live list, the bundled snapshot filling in what OpenRouter does not say. */
function fromLive(live: LiveModel, bundledEntry: CatalogEntry | undefined, bundledMap: LevelMap | undefined): CatalogEntry {
	const input = live.architecture?.input_modalities ?? [];
	// pi-ai marks a model reasoning-capable either way: the metadata object, or the parameter it accepts.
	const reasoning = Boolean(live.reasoning) || (live.supported_parameters ?? []).includes("reasoning");
	const contextWindow = live.context_length ?? bundledEntry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = Math.min(live.top_provider?.max_completion_tokens ?? bundledEntry?.maxTokens ?? DEFAULT_MAX_TOKENS, contextWindow);
	// The bundled map is hand-checked and wins; the live metadata only answers for models it does not know.
	const map = reasoning ? withOverride(live.id, bundledMap ?? liveMap(live) ?? {}) : undefined;
	return {
		id: live.id,
		name: live.name ?? bundledEntry?.name ?? live.id,
		contextWindow,
		maxTokens,
		reasoning,
		vision: input.includes("image"),
		image: false,
		levels: reasoning && map ? levelsOf({ reasoning: true, thinkingLevelMap: map } as Model<any>) : [],
	};
}

interface CacheFile {
	/** When the lists were fetched (ms since the epoch). */
	fetchedAt: number;
	chat: LiveModel[];
	images: LiveModel[];
}

export interface CatalogOptions {
	/** Where the cache file lives (`<dataDir>`). */
	dataDir?: string;
	/** The chat list's URL; defaults to OpenRouter, or `PIPAYA_OPENROUTER_URL`. */
	url?: string;
	/** How long a fetched list is reused; defaults to `CACHE_MS` (tests shorten it). */
	cacheMs?: number;
	now?: () => number;
	/** Replaceable in tests. */
	fetch?: typeof fetch;
	/** false = never fetch: the bundled snapshot answers (offline installs, tests). */
	enabled?: boolean;
}

/**
 * The OpenRouter catalog: the bundled snapshot, with the live lists fetched and cached on top. One instance per server;
 * every settings screen reads the same entries, and at most one fetch runs at a time.
 */
export class OpenRouterCatalog {
	private readonly file: string | undefined;
	private readonly url: string;
	private readonly cacheMs: number;
	private readonly now: () => number;
	private readonly doFetch: typeof fetch;
	private readonly enabled: boolean;

	private chat: LiveModel[] | undefined;
	private images: LiveModel[] | undefined;
	private fetchedAt = 0;
	private entries: CatalogEntry[] | undefined;
	private byId = new Map<string, CatalogEntry>();
	private byName = new Map<string, CatalogMatch | null>();
	private exact = new Map<string, CatalogMatch>();
	private pending: Promise<void> | null = null;
	/** Why the last fetch failed, for the settings screen to say so; cleared by the next success. */
	lastError: string | undefined;

	constructor(opts: CatalogOptions = {}) {
		this.file = opts.dataDir ? join(opts.dataDir, "openrouter-catalog.json") : undefined;
		this.url = opts.url ?? process.env.PIPAYA_OPENROUTER_URL ?? DEFAULT_URL;
		this.cacheMs = opts.cacheMs ?? CACHE_MS;
		this.now = opts.now ?? Date.now;
		this.doFetch = opts.fetch ?? fetch;
		this.enabled = opts.enabled ?? true;
		this.loadCache();
	}

	/** When the live list in hand was fetched (0 = none yet: the bundled snapshot is all we have). */
	get updatedAt(): number {
		return this.fetchedAt;
	}

	/** Whether the entries in hand came from OpenRouter itself rather than the bundled snapshot. */
	get isLive(): boolean {
		return this.chat !== undefined;
	}

	/** Whether the list in hand is older than `cacheMs` (so a settings screen should ask for a fresh one). */
	get stale(): boolean {
		return this.chat === undefined || this.now() - this.fetchedAt > this.cacheMs;
	}

	private loadCache() {
		if (!this.file || !existsSync(this.file)) return;
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			const c = parsed as Partial<CacheFile> | null;
			if (!c || typeof c.fetchedAt !== "number" || !Array.isArray(c.chat)) return;
			const clean = (list: unknown) => (Array.isArray(list) ? list.filter((m): m is LiveModel => typeof (m as LiveModel)?.id === "string" && (m as LiveModel).id.length <= 200) : undefined);
			const chat = clean(c.chat);
			if (!chat?.length) return;
			this.chat = chat;
			this.images = clean(c.images) ?? [];
			this.fetchedAt = c.fetchedAt;
		} catch {
			/* a corrupt cache is no cache: the bundled snapshot still answers */
		}
	}

	private saveCache() {
		if (!this.file || this.chat === undefined) return;
		try {
			mkdirSync(join(this.file, ".."), { recursive: true });
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, chat: this.chat, images: this.images ?? [] } satisfies CacheFile));
			renameSync(tmp, this.file);
		} catch {
			/* read-only data dir: the list still works, it is just fetched again next start */
		}
	}

	/**
	 * Rebuild the lookup tables. With a live list in hand it is the whole catalog (a model OpenRouter dropped is gone); the
	 * bundled snapshot only supplies what the API does not say (names, and the hand-checked reasoning maps). Without one,
	 * the bundled snapshot answers on its own.
	 */
	private rebuild() {
		const bundled = base();
		const byId = new Map<string, CatalogEntry>();
		if (this.chat === undefined) for (const [id, e] of bundled.entries) byId.set(id, e);
		for (const m of this.chat ?? []) {
			if (!listable(m.id)) continue;
			byId.set(m.id, fromLive(m, bundled.entries.get(m.id), bundled.maps.get(m.id)));
		}
		// OpenRouter's image endpoint is the authority on what can draw. A router (`openrouter/auto` and friends) is listed
		// there too because it may return a picture, but it answers chats: it stays a chat model.
		for (const m of this.images ?? []) {
			if (!listable(m.id) || m.id.startsWith("openrouter/")) continue;
			const chatEntry = byId.get(m.id);
			const vision = (m.architecture?.input_modalities ?? []).includes("image");
			byId.set(m.id, chatEntry
				? { ...chatEntry, image: true, reasoning: false, levels: [], vision: vision || chatEntry.vision }
				: { id: m.id, name: m.name ?? m.id, contextWindow: IMAGE_CONTEXT_WINDOW, maxTokens: IMAGE_MAX_TOKENS, reasoning: false, vision, image: true, levels: [] });
		}
		this.byId = byId;
		this.entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
		this.exact = new Map();
		this.byName = new Map();
		for (const e of this.entries) {
			if (!e.reasoning) continue;
			// A reasoning model without a map is still a match: it takes pi-ai's default strengths (off through high).
			const match = { id: e.id, map: bundled.maps.get(e.id) ?? liveMap((this.chat ?? []).find((m) => m.id === e.id) ?? { id: e.id }) ?? {} };
			this.exact.set(e.id.toLowerCase(), match);
			const key = normalize(e.id);
			const seen = this.byName.get(key);
			// Same name from several vendors with different maps: ambiguous, so nothing is guessed.
			if (seen === null) continue;
			if (seen && JSON.stringify(seen.map) !== JSON.stringify(match.map)) this.byName.set(key, null);
			else if (!seen) this.byName.set(key, match);
		}
	}

	private ensureBuilt() {
		if (!this.entries) this.rebuild();
	}

	/** Every model in the catalog (chat and picture-making, no `:variant` ids), for autocomplete when registering a model. */
	list(): CatalogEntry[] {
		this.ensureBuilt();
		return this.entries!;
	}

	/** The catalog entry with this exact id. */
	entry(id: string): CatalogEntry | undefined {
		this.ensureBuilt();
		return this.byId.get(id);
	}

	/** The catalog entry (and its reasoning strengths) for this model id, or `undefined` when it is unknown or ambiguous. */
	match(id: string): CatalogMatch | undefined {
		this.ensureBuilt();
		const hit = this.exact.get(id.toLowerCase()) ?? this.byName.get(normalize(id)) ?? undefined;
		const forced = STRENGTH_OVERRIDES[normalize(id)];
		// Keep the catalog id (limits and capabilities still come from it); only the strengths are replaced.
		if (forced) return { id: hit?.id ?? id, map: forced };
		return hit;
	}

	/** The reasoning strengths the catalog lists for this model id, or `undefined` when it is unknown or ambiguous. */
	thinkingLevelMap(id: string): LevelMap | undefined {
		return this.match(id)?.map;
	}

	/**
	 * Bring the live list up to date when it is stale, then answer. Never throws: a failed fetch keeps the cache (or the
	 * bundled snapshot) and records `lastError`, so the model picker still works offline. `force` refetches even when the
	 * cache is fresh (the refresh button).
	 */
	async refresh(force = false): Promise<void> {
		if (!this.enabled) return;
		if (!force && !this.stale) return;
		if (this.pending) return this.pending;
		this.pending = this.fetchLists().finally(() => {
			this.pending = null;
		});
		return this.pending;
	}

	private async getList(url: string): Promise<LiveModel[]> {
		const res = await this.doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
		if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
		const text = await res.text();
		if (text.length > MAX_BODY_BYTES) throw new Error("OpenRouter's model list was too large");
		const body = JSON.parse(text) as { data?: unknown };
		if (!Array.isArray(body?.data)) throw new Error("OpenRouter's model list was not in the expected shape");
		const models = (body.data as LiveModel[]).filter((m) => typeof m?.id === "string" && m.id.length > 0 && m.id.length <= 200);
		if (!models.length) throw new Error("OpenRouter's model list was empty");
		return models;
	}

	private async fetchLists(): Promise<void> {
		try {
			// The chat list is what the picker is for; the picture-making one is a bonus, so its failure does not matter.
			const chat = await this.getList(this.url);
			const images = await this.getList(imagesUrl(this.url)).catch(() => this.images ?? []);
			this.chat = chat;
			this.images = images;
			this.fetchedAt = this.now();
			this.lastError = undefined;
			this.rebuild();
			this.saveCache();
		} catch (e) {
			// The bundled snapshot (or an older cache) keeps answering; the settings screen shows why it is not live.
			this.lastError = e instanceof Error ? e.message : "the model list could not be read";
		}
	}
}

/**
 * The catalog one server uses: its own instance, so a test server never shares the cache file of another.
 * `PIPAYA_OPENROUTER=0` keeps it on the bundled snapshot: no request leaves the server (an offline install, a test run).
 */
export function createOpenRouterCatalog(dataDir?: string): OpenRouterCatalog {
	return new OpenRouterCatalog({ dataDir, enabled: process.env.PIPAYA_OPENROUTER !== "0" });
}
