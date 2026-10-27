/**
 * Which tools a session's agent gets and how they read to the model. Pure over what it is given (no session, store or
 * registry), so the rules can be tested and reused by anything that needs "the tools of a chat".
 */
import type { ContextTool, ToolSource } from "./context.ts";
import type { ToolContext, ToolDef } from "./tools.ts";

export interface ToolPlanEntry { name: string; source: ToolSource; off: boolean }

export interface ToolPlanInput {
	/** The tools chosen for this session. */
	chosen: readonly string[];
	/** Tools every session gets (peers, extension tools marked always). */
	always: readonly string[];
	/** Tools the user switched off in the settings. */
	disabled: readonly string[];
	/** The image tool's name when an image model is set, else undefined. */
	image?: string;
}

/**
 * Every tool a session's agent would get, and why: chosen for the session (`session`), always added (`always`), or added because
 * a feature is on (`image`). A tool the user switched off is still listed, marked `off`, so the context view can say it is withheld.
 * The first reason wins when a tool qualifies twice.
 */
export function planTools({ chosen, always, disabled, image }: ToolPlanInput): ToolPlanEntry[] {
	const plan = new Map<string, ToolSource>();
	const add = (list: readonly string[], source: ToolSource) => list.forEach((n) => plan.has(n) || plan.set(n, source));
	add(chosen, "session");
	add(always, "always");
	if (image) add([image], "image");
	return [...plan].map(([name, source]) => ({ name, source, off: disabled.includes(name) }));
}

/** The names that reach the agent: everything in the plan that is not switched off. */
export const enabledTools = (plan: readonly ToolPlanEntry[]): string[] => plan.filter((t) => !t.off).map((t) => t.name);

/** The tools as the model receives them (name, description, parameter schema), for the context view. */
export function describeTools(plan: readonly ToolPlanEntry[], defs: Record<string, ToolDef>, cwd: string, ctx: ToolContext): ContextTool[] {
	return plan.flatMap((t) => {
		const def = defs[t.name];
		if (!def) return [];
		let parameters: unknown = null;
		try {
			parameters = def.create(cwd, [], ctx).parameters ?? null;
		} catch {
			/* a tool that cannot be built here still shows its name and description */
		}
		const json = JSON.stringify({ name: def.name, description: def.description, parameters });
		// Cloned through the JSON that is measured anyway: unlike structuredClone it tolerates a schema carrying a function (an extension's).
		const plain = (JSON.parse(json) as { parameters?: unknown }).parameters ?? null;
		return [{ name: t.name, description: def.description, parameters: plain, source: t.source, enabled: !t.off, bytes: Buffer.byteLength(json) }];
	});
}
