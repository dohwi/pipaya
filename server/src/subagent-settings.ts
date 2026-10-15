import type { Database } from "bun:sqlite";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { badRequest } from "./errors.ts";
import { ModelChoice, type ModelChoiceValue } from "./model-choice.ts";
import type { ModelRegistry } from "./models.ts";
import type { ThinkingLevel } from "./store.ts";
import { loadAgentFiles } from "./subagent-files.ts";

/** Helpers search and quote; unless the owner asks for more, thinking stays at the cheapest level. */
export const DEFAULT_SUBAGENT_THINKING: ThinkingLevel = "minimal";

/**
 * Tools a sub-agent may be given. `delegate` is absent so a helper cannot start another helper, and `ask_user` is
 * absent because a helper has no user to ask. A helper holding a tool in MUTATING_SUBAGENT_TOOLS goes through the
 * same approval policy as the main agent (see `SubAgents.mutates`).
 */
export const SUBAGENT_TOOL_CHOICES = ["read", "grep", "ls", "write", "edit", "bash"] as const;
export const READ_ONLY_SUBAGENT_TOOLS = ["read", "grep", "ls"] as const;
export const MUTATING_SUBAGENT_TOOLS = ["write", "edit", "bash"] as const;
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_AGENTS = 10;
export const TURNS_RANGE = { min: 2, max: 30 } as const;
export const DEFAULT_MAX_TURNS = 12;

export const SubAgentDef = Type.Object(
	{
		name: Type.String({ pattern: AGENT_NAME.source, description: "What the main agent passes as `agent`" }),
		description: Type.String({ minLength: 1, maxLength: 200, description: "Shown to the main agent so it knows when to pick this helper" }),
		enabled: Type.Boolean(),
		model: Type.Union([ModelChoice, Type.Null()], {
			description: `Model and reasoning strength this helper runs on (strength left out = ${DEFAULT_SUBAGENT_THINKING}). null = the model of the conversation that called it`,
		}),
		tools: Type.Array(Type.Union([Type.Literal("read"), Type.Literal("grep"), Type.Literal("ls"), Type.Literal("write"), Type.Literal("edit"), Type.Literal("bash")]), { minItems: 1, maxItems: SUBAGENT_TOOL_CHOICES.length }),
		maxTurns: Type.Integer({ minimum: TURNS_RANGE.min, maximum: TURNS_RANGE.max, description: "Model calls before the helper is stopped" }),
		prompt: Type.String({ maxLength: 2000, description: "Extra instructions appended to the built-in helper prompt" }),
	},
	{ additionalProperties: false },
);
export type SubAgentDefinition = Static<typeof SubAgentDef>;

export const SubAgentSettingsSchema = Type.Object(
	{
		enabled: Type.Boolean({ description: "Master switch for the `delegate` tool" }),
		agents: Type.Array(SubAgentDef, { maxItems: MAX_AGENTS }),
	},
	{ additionalProperties: false },
);
export type SubAgentSettingsValue = Static<typeof SubAgentSettingsSchema>;

export const SubAgentSettingsBody = Type.Object({ settings: SubAgentSettingsSchema }, { additionalProperties: false });
export const SubAgentSettingsResult = Type.Object({
	settings: SubAgentSettingsSchema,
	defaults: SubAgentSettingsSchema,
	toolChoices: Type.Array(Type.String()),
});

export const defaultAgent = (model: ModelChoiceValue | null = null): SubAgentDefinition => ({
	name: "explore",
	description: "Searches and reads the codebase and reports back with path:line citations",
	enabled: true,
	model,
	tools: [...READ_ONLY_SUBAGENT_TOOLS],
	maxTurns: DEFAULT_MAX_TURNS,
	prompt: "",
});
/** The built-in "explore" helper is only a template the owner can add; a fresh server has no helpers at all. */
export const DEFAULT_SUBAGENT_SETTINGS = (): SubAgentSettingsValue => ({ enabled: true, agents: [] });

const KEY = "subagents";

/**
 * Older saved shapes: `{enabled, model}` (one helper) and `{enabled, agents: [{role|model, thinkingLevel, maxReportChars, ...}]}`
 * (several helpers, each with a model role). Both become the current shape; a role is looked up in the role table.
 */
function fromLegacy(db: Database, parsed: any): SubAgentSettingsValue | null {
	if (!parsed || typeof parsed !== "object") return null;
	if (!Array.isArray(parsed.agents)) {
		if (!("model" in parsed) || typeof parsed.enabled !== "boolean") return null;
		const next = { enabled: parsed.enabled, agents: [defaultAgent(parsed.model ?? null)] };
		return Value.Check(SubAgentSettingsSchema, next) ? next : null;
	}
	const roles = (): Record<string, any> => {
		const row = db.query("SELECT data FROM settings WHERE key = 'model_roles'").get() as { data: string } | null;
		try { return row ? JSON.parse(row.data) ?? {} : {}; } catch { return {}; }
	};
	const agents: SubAgentDefinition[] = [];
	for (const a of parsed.agents) {
		if (!a || typeof a !== "object") continue;
		let pick: { provider?: unknown; model?: unknown } | null = a.model ?? null;
		if (!pick && typeof a.role === "string") pick = roles()[a.role] ?? null;
		let model: ModelChoiceValue | null = null;
		if (pick && typeof pick.provider === "string" && typeof pick.model === "string") {
			model = { provider: pick.provider, model: pick.model, ...(typeof a.thinkingLevel === "string" ? { thinkingLevel: a.thinkingLevel } : {}) } as ModelChoiceValue;
		}
		const def = { name: a.name, description: a.description, enabled: a.enabled, model, tools: a.tools, maxTurns: a.maxTurns, prompt: a.prompt };
		if (Value.Check(SubAgentDef, def) && !agents.some((x) => x.name === def.name)) agents.push(def);
	}
	const next = { enabled: parsed.enabled !== false, agents };
	return Value.Check(SubAgentSettingsSchema, next) ? next : null;
}

export class SubAgentSettings {
	constructor(private db: Database, private registry: ModelRegistry, private opts: { home?: string } = {}) {}

	/** Stored settings, or the defaults when nothing usable is stored. */
	get(): SubAgentSettingsValue {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		if (!row) return DEFAULT_SUBAGENT_SETTINGS();
		try {
			const parsed = JSON.parse(row.data);
			if (Value.Check(SubAgentSettingsSchema, parsed)) return parsed;
			return fromLegacy(this.db, parsed) ?? DEFAULT_SUBAGENT_SETTINGS();
		} catch {
			return DEFAULT_SUBAGENT_SETTINGS();
		}
	}

	/** Replaces everything. Rules the schema cannot express are checked here so a bad save changes nothing. */
	set(next: SubAgentSettingsValue): SubAgentSettingsValue {
		const names = new Set<string>();
		for (const a of next.agents) {
			if (names.has(a.name)) throw badRequest(`duplicate sub-agent name "${a.name}"`);
			names.add(a.name);
			if (a.model && !this.registry.models.getModel(a.model.provider, a.model.model)) {
				throw badRequest(`sub-agent "${a.name}": unknown model ${a.model.provider}/${a.model.model}`);
			}
			if (new Set(a.tools).size !== a.tools.length) throw badRequest(`sub-agent "${a.name}": duplicate tools`);
		}
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(next) });
		return this.get();
	}

	/**
	 * Helpers the main agent may pick: the ones saved on the server, then agent files (global, then project files
	 * for `cwd`). A file with the same name replaces the saved helper. Empty when nothing is defined anywhere.
	 */
	available(cwd?: string): SubAgentDefinition[] {
		const s = this.get();
		if (!s.enabled) return [];
		const merged = new Map<string, SubAgentDefinition>(s.agents.map((a) => [a.name, a]));
		for (const { source: _s, path: _p, ...a } of loadAgentFiles(cwd, this.opts.home).agents) {
			merged.delete(a.name);
			merged.set(a.name, a);
		}
		return [...merged.values()].filter((a) => a.enabled);
	}

	/**
	 * The model a helper runs on: the one set for that helper while it still exists, otherwise the calling session's
	 * own model (a deleted model falls back instead of failing the call). The strength is always set.
	 */
	resolve(agent: Pick<SubAgentDefinition, "model">, session: { provider: string; model: string }): { provider: string; model: string; thinkingLevel: ThinkingLevel; custom: boolean } {
		const chosen = agent.model;
		if (chosen && this.registry.models.getModel(chosen.provider, chosen.model)) {
			return { provider: chosen.provider, model: chosen.model, thinkingLevel: chosen.thinkingLevel ?? DEFAULT_SUBAGENT_THINKING, custom: true };
		}
		return { provider: session.provider, model: session.model, thinkingLevel: DEFAULT_SUBAGENT_THINKING, custom: false };
	}
}
