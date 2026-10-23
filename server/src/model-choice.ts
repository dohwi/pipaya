import Type, { type Static } from "typebox";
import { Thinking } from "./schemas.ts";

/**
 * A model together with the reasoning strength to run it at. The two are always chosen as a pair, so every setting
 * that picks a model (new-chat default, compaction summary) stores this one shape.
 * `thinkingLevel` is ignored by a model without reasoning; left out it means "that setting's own default".
 */
export const ModelChoice = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		thinkingLevel: Type.Optional(Thinking),
	},
	{ additionalProperties: false },
);
export type ModelChoiceValue = Static<typeof ModelChoice>;
