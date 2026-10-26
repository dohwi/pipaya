import { t } from "./i18n";
import { compact } from "./format";
import type { ApiFormat, CatalogModel, CustomModel, CustomProvider, ThinkingLevel } from "./types";

/** One model line of the connection dialog, as typed (numbers are strings until validated). */
export interface Row {
	id: string;
	name: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	vision: boolean;
	/** Makes pictures instead of text */
	imageGeneration: boolean;
	/** Chosen brand mark; undefined = automatic (from the id) */
	icon?: string;
	/** Listed by the upstream itself: the id is fixed and cannot be edited */
	fromUpstream?: boolean;
	/** Empty = automatic (looked up by name on the server) */
	thinkingLevels: ThinkingLevel[];
	/** OpenRouter model this upstream model is matched to. null = manual; undefined = not chosen yet (matched by name). */
	catalogId?: string | null;
	/** What the server matched this model to, for display only */
	thinkingSource?: CustomModel["thinkingSource"];
	/** The upstream's model list no longer contains it */
	unavailable?: boolean;
}

export interface Form {
	isNew: boolean;
	id: string;
	idTouched: boolean;
	name: string;
	baseUrl: string;
	api: ApiFormat;
	authRequired: boolean;
	/** Typed into a new connection; sent to the server only on save (never kept in the list). */
	apiKey: string;
	rows: Row[];
}

export const ALL_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Local runtimes that speak the OpenAI-compatible API without a key. The URL is reached from the server, so localhost means the server's machine. */
export const localPresets = [
	{ name: "Ollama", id: "ollama", baseUrl: "http://localhost:11434/v1" },
	{ name: "LM Studio", id: "lm-studio", baseUrl: "http://localhost:1234/v1" },
	{ name: "llama.cpp", id: "llama-cpp", baseUrl: "http://localhost:8080/v1" },
	{ name: "vLLM", id: "vllm", baseUrl: "http://localhost:8000/v1" },
];
export type LocalPreset = (typeof localPresets)[number];

export const newRow = (): Row => ({ id: "", name: "", contextWindow: "128000", maxTokens: "8192", reasoning: false, vision: false, imageGeneration: false, thinkingLevels: [] });

/** A connection id suggested from its name: lowercase, starts with a letter, only `a-z 0-9 _ -`. */
export const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/-+$/, "")
		.slice(0, 64);

export const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export function newForm(preset?: LocalPreset): Form {
	return {
		isNew: true,
		id: preset?.id ?? "",
		idTouched: Boolean(preset),
		name: preset?.name ?? "",
		baseUrl: preset?.baseUrl ?? "",
		api: "openai-completions",
		authRequired: false,
		apiKey: "",
		rows: [],
	};
}

export function formFromProvider(p: CustomProvider): Form {
	return {
		isNew: false,
		id: p.id,
		idTouched: true,
		name: p.name,
		baseUrl: p.baseUrl,
		api: p.api,
		authRequired: p.authRequired,
		apiKey: "",
		rows: p.models.map((m) => ({
			id: m.id,
			name: m.name ?? "",
			contextWindow: String(m.contextWindow),
			maxTokens: String(m.maxTokens),
			reasoning: m.reasoning,
			vision: m.vision,
			imageGeneration: m.imageGeneration === true,
			icon: m.icon,
			fromUpstream: m.fromUpstream,
			thinkingLevels: m.thinkingLevels ?? [],
			catalogId: m.catalogId,
			thinkingSource: m.thinkingSource,
			unavailable: m.unavailable,
		})),
	};
}

/** Choosing an OpenRouter match only fills limits and capabilities from it; the upstream model id is never touched. */
export function applyMatch(r: Row, c: CatalogModel | null) {
	if (!c) {
		r.catalogId = null;
		return;
	}
	r.catalogId = c.id;
	r.contextWindow = String(c.contextWindow);
	r.maxTokens = String(Math.min(c.maxTokens, c.contextWindow));
	r.vision = c.vision;
	r.reasoning = c.reasoning;
	r.imageGeneration = c.image;
	r.thinkingLevels = [];
}

/** "128k": the context size under a model's name. */
export function ctxLabel(r: Row): string {
	const ctx = Number(r.contextWindow);
	return Number.isFinite(ctx) && ctx > 0 ? compact(ctx) : "";
}

/** The first problem with the connection's own fields (name, id, address), or null. */
export function headerError(f: Pick<Form, "name" | "id" | "baseUrl">): string | null {
	if (!f.name.trim()) return t("이름을 입력하세요.");
	if (!ID_PATTERN.test(f.id)) return t("ID는 영문 소문자로 시작하고 소문자·숫자·-·_ 만 쓸 수 있습니다.");
	if (!f.baseUrl.trim()) return t("Endpoint URL을 입력하세요.");
	return null;
}

/**
 * Validate the form and build the models payload. `strict` (explicit save) also rejects a blank model and reports
 * its index in `at` so the dialog can jump to the model that needs fixing.
 * `matchedId` resolves the OpenRouter id a row is matched to; `catalogLoaded` says whether "no match" is meaningful.
 */
export function collectModels(
	f: Form,
	strict: boolean,
	matchedId: (r: Row) => string | undefined,
	catalogLoaded: boolean,
): { out: CustomModel[] } | { error: string; at?: number } {
	const head = headerError(f);
	if (head) return { error: head };
	const out: CustomModel[] = [];
	for (const [i, r] of f.rows.entries()) {
		if (!strict && !r.id.trim() && !r.name.trim()) continue; // a blank model still being typed
		const ctx = Number(r.contextWindow);
		const max = Number(r.maxTokens);
		const bad = (error: string) => ({ error, at: i });
		if (!r.id.trim()) return bad(t("{n}번째 모델의 ID를 입력하세요.", { n: i + 1 }));
		if (!Number.isInteger(ctx) || ctx < 128) return bad(t("{id}: 컨텍스트 크기는 128 이상의 정수여야 합니다.", { id: r.id }));
		if (!Number.isInteger(max) || max < 1) return bad(t("{id}: 최대 출력은 1 이상의 정수여야 합니다.", { id: r.id }));
		if (max > ctx) return bad(t("{id}: 최대 출력은 컨텍스트 크기를 넘을 수 없습니다.", { id: r.id }));
		const hit = matchedId(r);
		out.push({
			id: r.id.trim(),
			...(r.fromUpstream ? { fromUpstream: true } : {}),
			...(hit ? { catalogId: hit } : catalogLoaded ? { catalogId: null } : {}),
			...(r.name.trim() ? { name: r.name.trim() } : {}),
			contextWindow: ctx,
			maxTokens: max,
			reasoning: r.reasoning && !r.imageGeneration,
			vision: r.vision,
			...(r.imageGeneration ? { imageGeneration: true } : {}),
			...(r.icon ? { icon: r.icon } : {}),
			...(r.reasoning && !r.imageGeneration && r.thinkingLevels.length ? { thinkingLevels: ALL_LEVELS.filter((l) => r.thinkingLevels.includes(l)) } : {}),
		} as CustomModel);
	}
	if (new Set(out.map((m) => m.id)).size !== out.length) return { error: t("모델 ID가 중복되었습니다.") };
	return { out };
}

/** Everything the user can change, as one string: the dialog is "dirty" when it differs from the one taken on open. */
export const snapshot = (f: Form) => JSON.stringify([f.name, f.id, f.baseUrl, f.api, f.authRequired, f.apiKey, f.rows]);
