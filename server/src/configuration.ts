import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createProvider, getSupportedThinkingLevels, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { APPROVAL_POLICIES, type ApprovalPolicy, type Config } from "./config.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { builtinProvider, type ModelRegistry } from "./models.ts";
import { Approval, Thinking } from "./schemas.ts";
import { catalogMatch, catalogThinkingLevelMap } from "./thinking-catalog.ts";
import { isInside } from "./tools.ts";
import { THINKING_LEVELS, type SqliteCredentialStore, type ThinkingLevel } from "./store.ts";
import Type, { type Static } from "typebox";

export const CustomProviderBody = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 100 }),
	baseUrl: Type.String({ minLength: 1, maxLength: 2000, description: "HTTP(S) API base URL, e.g. http://host:11434/v1. Server-side requests; use only trusted endpoints." }),
	api: Type.Union([Type.Literal("openai-completions"), Type.Literal("openai-responses"), Type.Literal("anthropic-messages")]),
	authRequired: Type.Boolean(),
	models: Type.Array(Type.Object({
		id: Type.String({ minLength: 1, maxLength: 200 }),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		contextWindow: Type.Integer({ minimum: 128, maximum: 10_000_000 }),
		maxTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
		reasoning: Type.Boolean(),
		vision: Type.Boolean(),
		fromUpstream: Type.Optional(Type.Boolean({ description: "The model came from the upstream's own model list, so its id is fixed (not editable)." })),
		thinkingLevels: Type.Optional(Type.Array(Thinking, { uniqueItems: true, description: "Reasoning strengths this model accepts. Left out or empty: looked up in the bundled catalog (by catalogId, else by name), else minimal..high." })),
		catalogId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()], { description: "The OpenRouter catalog model this upstream model corresponds to. null = deliberately none (manual values); left out = match by name." })),
	}), { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });
/** The model's `thinkingLevelMap`: a level that is not listed is marked unsupported (null), the others pass through unchanged. */
function thinkingMapFor(m: { id: string; thinkingLevels?: readonly string[] }): { thinkingLevelMap?: NonNullable<Model<any>["thinkingLevelMap"]> } {
	if (m.thinkingLevels?.length) {
		const map: Record<string, string | null> = {};
		for (const level of THINKING_LEVELS) map[level] = m.thinkingLevels.includes(level) ? level : null;
		return { thinkingLevelMap: map };
	}
	const found = catalogThinkingLevelMap(m.id);
	return found ? { thinkingLevelMap: found } : {};
}
export const DiscoverBody = Type.Object({
	baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
	api: CustomProviderBody.properties.api,
	providerId: Type.Optional(Type.String({ description: "Existing connection whose stored API key is used for the request" })),
}, { additionalProperties: false });
export const DiscoverResult = Type.Object({ models: Type.Array(Type.Object({ id: Type.String(), name: Type.Optional(Type.String()) })) });
export const Selection = Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) }, { additionalProperties: false });
/** What new sessions start with: a model and, optionally, the thinking level to start it at. */
export const DefaultSelection = Type.Object({
	provider: Type.String({ minLength: 1 }),
	model: Type.String({ minLength: 1 }),
	thinkingLevel: Type.Optional(Thinking),
}, { additionalProperties: false });
export const DefaultsBody = Type.Union([DefaultSelection, Type.Null()]);
/** Where a model's reasoning strengths come from (response only): the owner's own list, a catalog match by name, or the plain default. */
export const ThinkingSource = Type.Object({
	kind: Type.Union([Type.Literal("custom"), Type.Literal("catalog"), Type.Literal("default")]),
	catalogId: Type.Optional(Type.String({ description: "The bundled OpenRouter catalog id the name was matched to (kind \"catalog\")" })),
	levels: Type.Array(Thinking, { description: "The strengths the model offers, weakest first; empty without reasoning" }),
});
const PublicModel = Type.Object({ ...CustomProviderBody.properties.models.items.properties, thinkingSource: ThinkingSource });
export const CustomProviderPublic = Type.Object({
	...CustomProviderBody.properties,
	models: Type.Array(PublicModel),
	id: Type.String(),
	configured: Type.Boolean(),
	hasStoredKey: Type.Boolean(),
});
export const WorkdirBody = Type.Object({ path: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()], { description: "Absolute directory that already exists; null restores the startup default" }) }, { additionalProperties: false });
export const WorkdirInfo = Type.Object({
	saved: Type.Union([Type.String(), Type.Null()]),
	effective: Type.String({ description: "Where a session without an explicit cwd starts, and what relative cwd values resolve against" }),
	fallback: Type.String({ description: "Startup default (PIPAYA_WORKSPACE), used when nothing is saved" }),
});
export const DefaultsResult = Type.Object({ defaults: DefaultsBody, effectiveDefaults: DefaultsBody });
export const ApprovalBody = Type.Object({ approval: Type.Union([Approval, Type.Null()], { description: "Default tool approval for new sessions; null restores the startup default (PIPAYA_APPROVAL)" }) }, { additionalProperties: false });
export const ApprovalInfo = Type.Object({ saved: Type.Union([Approval, Type.Null()]), effective: Approval, fallback: Approval });
export const ConfigurationResult = Type.Object({ providers: Type.Array(CustomProviderPublic), ...DefaultsResult.properties, workdir: WorkdirInfo, approval: Type.Optional(ApprovalInfo) });
export const ConnectionResult = Type.Object({ ok: Type.Boolean(), durationMs: Type.Integer(), text: Type.Optional(Type.String()), error: Type.Optional(Type.String()) });
export type CustomProvider = Static<typeof CustomProviderBody> & { id: string };
export type ModelSelection = Static<typeof Selection>;
export type DefaultModelSelection = Static<typeof DefaultSelection>;

const implementations: Record<CustomProvider["api"], () => ProviderStreams> = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
};

/** Persisted user model configuration. Secrets live only in the separate CredentialStore. */
export class Configuration {
	constructor(
		private db: Database,
		private cfg: Config,
		private registry: ModelRegistry,
		private credentials: SqliteCredentialStore,
	) {
		for (const p of this.list()) this.registry.models.setProvider(this.buildProvider(p));
		registry.defaultSelection = () => this.effectiveDefaults();
	}

	/** The tool approval new sessions start with. Saved on the server, so every client sees the same one. */
	approvalInfo(): { saved: ApprovalPolicy | null; effective: ApprovalPolicy; fallback: ApprovalPolicy } {
		const row = this.db.query("SELECT data FROM settings WHERE key = 'default_approval'").get() as { data: string } | null;
		const parsed: unknown = row ? JSON.parse(row.data) : null;
		const saved = APPROVAL_POLICIES.find((p) => p === parsed) ?? null;
		// The startup value (PIPAYA_APPROVAL) is the fallback; a value saved on the server wins.
		return { saved, effective: saved ?? this.cfg.defaultApproval, fallback: this.cfg.defaultApproval };
	}

	setApproval(approval: ApprovalPolicy | null) {
		if (approval === null) this.db.query("DELETE FROM settings WHERE key = 'default_approval'").run();
		else this.db.query("INSERT INTO settings (key, data) VALUES ('default_approval', $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ data: JSON.stringify(approval) });
		return this.approvalInfo();
	}

	list(): CustomProvider[] {
		const rows = this.db.query("SELECT id, data FROM custom_providers ORDER BY id").all() as { id: string; data: string }[];
		return rows.map((r) => ({ ...JSON.parse(r.data), id: r.id }));
	}

	private get(id: string): CustomProvider | undefined { return this.list().find((p) => p.id === id); }

	defaults(): DefaultModelSelection | null {
		const row = this.db.query("SELECT data FROM settings WHERE key = 'default_model'").get() as { data: string } | null;
		return row ? JSON.parse(row.data) : null;
	}

	/** The directory new sessions start in. Saved on the server, so every client sees the same one. */
	workdirInfo(): Static<typeof WorkdirInfo> {
		const row = this.db.query("SELECT data FROM settings WHERE key = 'default_workdir'").get() as { data: string } | null;
		const saved: string | null = row ? JSON.parse(row.data) : null;
		return { saved, effective: saved ?? this.cfg.workspaceRoot, fallback: this.cfg.workspaceRoot };
	}

	defaultWorkdir(): string { return this.workdirInfo().effective; }

	setWorkdir(path: string | null) {
		if (path === null) {
			this.db.query("DELETE FROM settings WHERE key = 'default_workdir'").run();
			return this.workdirInfo();
		}
		const abs = resolve(path);
		if (!isAbsolute(path)) throw badRequest("the default working directory must be an absolute path");
		let ok = false;
		try { ok = statSync(abs).isDirectory(); } catch { /* reported below */ }
		if (!ok) throw badRequest(`not an existing directory: ${abs}`);
		if (this.cfg.restrictWorkspace && !isInside(this.cfg.workspaceRoot, abs)) throw badRequest(`the working directory must be inside the workspace (${this.cfg.workspaceRoot})`);
		this.db.query("INSERT INTO settings (key, data) VALUES ('default_workdir', $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ data: JSON.stringify(abs) });
		return this.workdirInfo();
	}

	effectiveDefaults(): DefaultModelSelection | null {
		const selection = this.defaults() ?? (this.cfg.defaultProvider && this.cfg.defaultModel
			? { provider: this.cfg.defaultProvider, model: this.cfg.defaultModel } : null);
		return selection && this.registry.models.getModel(selection.provider, selection.model) ? selection : null;
	}

	async snapshot() {
		return {
			providers: await Promise.all(this.list().map((p) => this.describe(p))),
			defaults: this.defaults(), effectiveDefaults: this.effectiveDefaults(), workdir: this.workdirInfo(), approval: this.approvalInfo(),
		};
	}

	private thinkingSource(providerId: string, m: CustomProvider["models"][number]): { kind: "custom" | "catalog" | "default"; catalogId?: string; levels: ThinkingLevel[] } {
		const live = this.registry.models.getModel(providerId, m.id);
		const levels = live ? getSupportedThinkingLevels(live).filter((l): l is ThinkingLevel => l !== "off") : [];
		if (!m.reasoning) return { kind: "default", levels: [] };
		const match = catalogMatch(m.id);
		if (m.thinkingLevels?.length) return { kind: "custom", ...(match ? { catalogId: match.id } : {}), levels };
		return match ? { kind: "catalog", catalogId: match.id, levels } : { kind: "default", levels };
	}

	async describe(p: CustomProvider) {
		const c = await this.credentials.read(p.id);
		const models = p.models.map((m) => ({ ...m, thinkingSource: this.thinkingSource(p.id, m) }));
		return { ...p, models, configured: Boolean(await this.registry.models.checkAuth(p.id)), hasStoredKey: c?.type === "api_key" && Boolean(c.key) };
	}

	async save(id: string, input: Static<typeof CustomProviderBody>) {
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw badRequest("provider id must be lowercase letters, digits, _ or - (start with a letter, max 64)");
		let url: URL;
		try { url = new URL(input.baseUrl); } catch { throw badRequest("baseUrl must be a valid HTTP(S) URL"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
			throw badRequest("baseUrl must be HTTP(S) without embedded credentials, query or fragment");
		}
		const ids = input.models.map((m) => m.id.trim());
		if (ids.some((m) => !m) || new Set(ids).size !== ids.length) throw badRequest("model ids must be nonempty and unique");
		if (input.models.some((m) => m.maxTokens > m.contextWindow)) throw badRequest("maxTokens must not exceed contextWindow");
		if (!input.name.trim()) throw badRequest("name must not be blank");
		const p: CustomProvider = { ...input, id, name: input.name.trim(), baseUrl: url.toString().replace(/\/$/, ""), models: input.models.map((m) => ({ ...m, id: m.id.trim() })) };
		const defaultModel = this.effectiveDefaults();
		if (defaultModel?.provider === id && !ids.includes(defaultModel.model)) throw conflict("cannot remove the default model; change defaults first");
		const referenced = this.db.query("SELECT DISTINCT model FROM sessions WHERE provider = $id").all({ id }) as { model: string }[];
		if (referenced.some((r) => !ids.includes(r.model))) throw conflict("cannot remove a model referenced by a session");
		const runtime = this.buildProvider(p); // build before writing so invalid configs never persist
		this.db.query("INSERT INTO custom_providers (id, data) VALUES ($id, $data) ON CONFLICT(id) DO UPDATE SET data = $data")
			.run({ id, data: JSON.stringify(p) });
		this.registry.models.setProvider(runtime);
		return this.describe(p);
	}

	/** Ask the upstream for its own model list (GET {baseUrl}/models), using the connection's stored key when it has one. */
	async discover(input: Static<typeof DiscoverBody>): Promise<Static<typeof DiscoverResult>> {
		let url: URL;
		try { url = new URL(input.baseUrl); } catch { throw badRequest("baseUrl must be a valid HTTP(S) URL"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
			throw badRequest("baseUrl must be HTTP(S) without embedded credentials, query or fragment");
		}
		const key = input.providerId ? (await this.credentials.read(input.providerId)) : undefined;
		const apiKey = key?.type === "api_key" ? key.key : undefined;
		const headers: Record<string, string> = { accept: "application/json" };
		if (apiKey) {
			if (input.api === "anthropic-messages") { headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; }
			else headers.authorization = `Bearer ${apiKey}`;
		}
		const target = `${url.toString().replace(/\/$/, "")}/models`;
		let res: Response;
		try {
			res = await fetch(target, { headers, signal: AbortSignal.timeout(10_000), redirect: "error" });
		} catch {
			throw badRequest("Could not reach the endpoint's /models. Check the URL and that the server is running.");
		}
		if (res.status === 401 || res.status === 403) throw badRequest("The endpoint rejected the request (401/403). Save the API key first, then try again.");
		if (!res.ok) throw badRequest(`The endpoint's /models answered ${res.status}. It may not offer a model list; add models by hand.`);
		let body: any;
		try { body = await res.json(); } catch { throw badRequest("The endpoint's /models did not return JSON."); }
		const list: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
		const seen = new Set<string>();
		const models: { id: string; name?: string }[] = [];
		for (const item of list) {
			const o = item as { id?: unknown; display_name?: unknown } | null | undefined;
			const id = typeof o === "string" ? o : typeof o?.id === "string" ? o.id : undefined;
			if (!id || id.length > 200 || seen.has(id)) continue;
			seen.add(id);
			const name = typeof o?.display_name === "string" && o.display_name && o.display_name !== id ? o.display_name.slice(0, 200) : undefined;
			models.push({ id, ...(name ? { name } : {}) });
			if (models.length >= 100) break;
		}
		if (!models.length) throw badRequest("The endpoint's /models returned no models.");
		return { models };
	}

	async delete(id: string) {
		if (!this.get(id)) throw notFound("custom provider");
		if (this.effectiveDefaults()?.provider === id) throw conflict("change the default model before deleting its provider");
		if (this.db.query("SELECT id FROM sessions WHERE provider = $id LIMIT 1").get({ id })) throw conflict("provider is referenced by a session; change or delete those sessions first");
		await this.credentials.deleteWithCleanup(id, () => {
			// Recheck after waiting for any credential mutation; no concurrent default/session can slip in.
			if (this.effectiveDefaults()?.provider === id || this.db.query("SELECT id FROM sessions WHERE provider = $id LIMIT 1").get({ id })) {
				throw conflict("provider became referenced by defaults or a session");
			}
			this.db.query("DELETE FROM custom_providers WHERE id = $id").run({ id });
		});
		this.registry.models.deleteProvider(id);
		const builtin = builtinProvider(id); // a custom endpoint may have shadowed a built-in provider: bring it back
		if (builtin) this.registry.models.setProvider(builtin);
	}

	setDefaults(selection: DefaultModelSelection | null) {
		if (selection && !this.registry.models.getModel(selection.provider, selection.model)) throw badRequest("unknown provider/model");
		if (selection) this.db.query("INSERT INTO settings (key, data) VALUES ('default_model', $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ data: JSON.stringify(selection) });
		else this.db.query("DELETE FROM settings WHERE key = 'default_model'").run();
		return { defaults: this.defaults(), effectiveDefaults: this.effectiveDefaults() };
	}

	async test(selection: ModelSelection) {
		const model = this.registry.models.getModel(selection.provider, selection.model);
		if (!model) throw notFound("model");
		const start = Date.now();
		if (!(await this.registry.models.checkAuth(selection.provider))) return { ok: false, durationMs: Date.now() - start, error: "API key is not configured" };
		// Model inference, NOT just a health check. A small request may incur upstream charges.
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, 30_000);
			});
			const result = await Promise.race([
				this.registry.models.completeSimple(model, { messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] }, { signal: controller.signal, maxTokens: Math.min(32, model.maxTokens) }),
				timeout,
			]);
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				// Do not reflect upstream errors: they may contain auth headers or submitted secrets.
				return { ok: false, durationMs: Date.now() - start, error: "Model request failed. Check URL, API format, key and model ID." };
			}
			return { ok: true, durationMs: Date.now() - start, text: result.content.filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 500) };
		} catch {
			return { ok: false, durationMs: Date.now() - start, error: controller.signal.aborted ? "Connection test timed out (30s)" : "Connection test failed. Check provider settings." };
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}

	private buildProvider(p: CustomProvider) {
		const models: Model<CustomProvider["api"]>[] = p.models.map((m) => ({
			id: m.id, name: m.name ?? m.id, api: p.api, provider: p.id, baseUrl: p.baseUrl,
			reasoning: m.reasoning, input: m.vision ? ["text", "image"] : ["text"],
			// Strengths the owner listed win; otherwise they are looked up by name in the bundled OpenRouter catalog, and unknown names keep the defaults.
			...(m.reasoning ? thinkingMapFor(m) : {}),
			contextWindow: m.contextWindow, maxTokens: m.maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
		return createProvider({
			id: p.id, name: p.name, baseUrl: p.baseUrl, models, api: implementations[p.api](),
			auth: { apiKey: {
				name: `${p.name} API key`,
				resolve: async ({ credential }) => {
					if (p.authRequired && !credential?.key) return undefined;
					// OpenAI SDK needs a nonempty apiKey even on keyless local endpoints.
					return { auth: { apiKey: credential?.key ?? "keyless-local" } };
				},
			} },
		});
	}
}
