import type { Database } from "bun:sqlite";
import Type, { type Static } from "typebox";
import { notFound } from "./errors.ts";
import { ModelChoice } from "./model-choice.ts";
import type { ModelRegistry } from "./models.ts";
import type { ThinkingLevel } from "./store.ts";
import { loadAgentFiles } from "./subagent-files.ts";

/** Helpers search and quote; unless the owner asks for more, thinking stays at the cheapest level. */
export const DEFAULT_SUBAGENT_THINKING: ThinkingLevel = "minimal";

/**
 * Tools a sub-agent may be given. `delegate` is absent so a helper cannot start another helper, and `ask_user` (an extension) is
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

/** What is stored: the master switch and the names of file helpers the owner switched off. The helpers themselves are files. */
export const SubAgentSettingsSchema = Type.Object(
	{
		enabled: Type.Boolean({ description: "Master switch for the `delegate` tool" }),
		disabled: Type.Array(Type.String(), { maxItems: 200, description: "Helpers switched off here, by name" }),
	},
	{ additionalProperties: false },
);
export type SubAgentSettingsValue = Static<typeof SubAgentSettingsSchema>;

export const SubAgentSwitchBody = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
export const SubAgentListQuery = Type.Object({ cwd: Type.Optional(Type.String({ maxLength: 4096 })) });
export const SubAgentInfo = Type.Object(
	{
		...SubAgentDef.properties,
		fileEnabled: Type.Boolean({ description: "`enabled` as written in the file; a helper the file disables cannot be switched on here" }),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
		path: Type.String(),
	},
	{ additionalProperties: false },
);
export const SubAgentListResult = Type.Object({
	enabled: Type.Boolean(),
	agents: Type.Array(SubAgentInfo),
	warnings: Type.Array(Type.Object({ path: Type.String(), message: Type.String() })),
	toolChoices: Type.Array(Type.String()),
});
export type SubAgentListValue = Static<typeof SubAgentListResult>;

export const DEFAULT_SUBAGENT_SETTINGS = (): SubAgentSettingsValue => ({ enabled: true, disabled: [] });

const KEY = "subagents";

export class SubAgentSettings {
	constructor(private db: Database, private registry: ModelRegistry, private opts: { home?: string } = {}) {}

	/** Stored switches, or the defaults. Older saves also held the helpers themselves; those are ignored (helpers are files now). */
	get(): SubAgentSettingsValue {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		if (!row) return DEFAULT_SUBAGENT_SETTINGS();
		try {
			const parsed = JSON.parse(row.data);
			if (!parsed || typeof parsed !== "object" || typeof parsed.enabled !== "boolean") return DEFAULT_SUBAGENT_SETTINGS();
			const disabled = Array.isArray(parsed.disabled) ? parsed.disabled.filter((n: unknown): n is string => typeof n === "string") : [];
			return { enabled: parsed.enabled, disabled };
		} catch {
			return DEFAULT_SUBAGENT_SETTINGS();
		}
	}

	private save(next: SubAgentSettingsValue): void {
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(next) });
	}

	/** The master switch. */
	setEnabled(enabled: boolean): void {
		this.save({ ...this.get(), enabled });
	}

	/** Switches one file helper on or off for the whole server. Unknown names are a 404. */
	setAgentEnabled(name: string, enabled: boolean, cwd?: string): void {
		const s = this.get();
		const known = loadAgentFiles(cwd, this.opts.home).agents.some((a) => a.name === name);
		if (!known && !s.disabled.includes(name)) throw notFound(`sub-agent "${name}"`);
		const disabled = s.disabled.filter((n) => n !== name);
		if (!enabled) disabled.push(name);
		this.save({ ...s, disabled });
	}

	/** Every helper file visible from `cwd` with its effective state, for the settings screen. */
	list(cwd?: string): Omit<SubAgentListValue, "toolChoices"> {
		const s = this.get();
		const { agents, warnings } = loadAgentFiles(cwd, this.opts.home);
		return {
			enabled: s.enabled,
			agents: agents.map(({ source, ...a }) => ({ ...a, scope: source, fileEnabled: a.enabled, enabled: a.enabled && !s.disabled.includes(a.name) })),
			warnings,
		};
	}

	/** Helpers the main agent may pick: enabled agent files for `cwd` (global, then project; the nearest wins). Empty when none exist. */
	available(cwd?: string): SubAgentDefinition[] {
		const s = this.get();
		if (!s.enabled) return [];
		return loadAgentFiles(cwd, this.opts.home).agents
			.filter((a) => a.enabled && !s.disabled.includes(a.name))
			.map(({ source: _s, path: _p, ...a }) => a);
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
