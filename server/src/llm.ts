import Type, { type Static } from "typebox";
import { badRequest, HttpError } from "./errors.ts";
import type { ModelRegistry } from "./models.ts";
import { ModelRoles, ROLE_NAME } from "./model-roles.ts";

export const MAX_INPUT_CHARS = 200_000;
export const MAX_SYSTEM_CHARS = 20_000;
export const DEFAULT_MAX_TOKENS = 1024;
export const MAX_MAX_TOKENS = 8192;

export const CompleteBody = Type.Object(
	{
		role: Type.Optional(Type.String({ pattern: ROLE_NAME.source, description: "Model role from /model-roles. Without a mapping the default model is used" })),
		provider: Type.Optional(Type.String({ minLength: 1, description: "Explicit model instead of a role (needs `model` too)" })),
		model: Type.Optional(Type.String({ minLength: 1 })),
		system: Type.Optional(Type.String({ maxLength: MAX_SYSTEM_CHARS })),
		input: Type.String({ minLength: 1, maxLength: MAX_INPUT_CHARS, description: "The text to work on. Sessions are never read implicitly" }),
		maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MAX_TOKENS, description: `Output cap, default ${DEFAULT_MAX_TOKENS}` })),
	},
	{ additionalProperties: false },
);
export type CompleteInput = Static<typeof CompleteBody>;

export const CompleteResult = Type.Object({
	text: Type.String(),
	provider: Type.String(),
	model: Type.String(),
	role: Type.Union([Type.String(), Type.Null()]),
	stopReason: Type.String(),
	usage: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		totalTokens: Type.Number(),
		cost: Type.Number(),
	}),
});
export type CompleteOutput = Static<typeof CompleteResult>;

/**
 * One-shot text completion on any registered model: no session, no tools, no history. The building block for
 * summaries, titles, classification, translation and for the sub-agent's cheap model. It only ever sees the
 * text the caller passes in.
 */
export class Llm {
	constructor(private registry: ModelRegistry, private roles: ModelRoles) {}

	async complete(input: CompleteInput, signal?: AbortSignal): Promise<CompleteOutput> {
		if ((input.provider === undefined) !== (input.model === undefined)) throw badRequest("provider and model go together");
		if (input.provider !== undefined && input.role !== undefined) throw badRequest("use either role or provider+model, not both");

		let target: { provider: string; model: string };
		if (input.provider !== undefined && input.model !== undefined) {
			target = { provider: input.provider, model: input.model };
		} else {
			const resolved = this.roles.resolve(input.role ?? "default");
			if (!resolved) throw badRequest("no model for this role and no default model is set");
			target = resolved;
		}

		const model = this.registry.models.getModel(target.provider, target.model);
		if (!model) throw badRequest(`unknown model ${target.provider}/${target.model}`);
		if (!(await this.registry.models.checkAuth(target.provider))) throw badRequest(`provider ${target.provider} is not configured; set its API key first`);

		const reply = await this.registry.models.completeSimple(
			model,
			{ systemPrompt: input.system, messages: [{ role: "user", content: input.input, timestamp: Date.now() }] },
			{ maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS, signal },
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			throw new HttpError(502, "upstream_error", reply.errorMessage || `model call ${reply.stopReason}`);
		}
		const text = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
		const u = reply.usage;
		return {
			text,
			provider: target.provider,
			model: target.model,
			role: input.role ?? null,
			stopReason: reply.stopReason,
			usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, cost: u.cost.total },
		};
	}
}
