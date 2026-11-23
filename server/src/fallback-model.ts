import type { Database } from "bun:sqlite";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { badRequest } from "./errors.ts";
import type { ModelRegistry } from "./models.ts";
import { ModelChoice, type ModelChoiceValue } from "./model-choice.ts";

/**
 * Automatic fallback model used when a chat or subagent call repeatedly ends in a zero-output upstream failure
 * (e.g. `502 upstream stream closed with zero output`). `null` turns automatic fallback off.
 */
export const FallbackModelSchema = Type.Object(
	{ model: Type.Union([ModelChoice, Type.Null()], { description: "Model (and reasoning strength) used when the primary model fails repeatedly with zero output. null = off" }) },
	{ additionalProperties: false },
);
export type FallbackModelValue = Static<typeof FallbackModelSchema>;
export const FallbackModelResult = Type.Object({ settings: FallbackModelSchema, defaults: FallbackModelSchema });
export const DEFAULT_FALLBACK_MODEL = (): FallbackModelValue => ({ model: null });

const KEY = "fallback_model";

export class FallbackModelSettings {
	constructor(private db: Database, private registry: ModelRegistry) {}

	get(): FallbackModelValue {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		if (!row) return DEFAULT_FALLBACK_MODEL();
		try {
			const parsed = JSON.parse(row.data);
			return Value.Check(FallbackModelSchema, parsed) ? parsed : DEFAULT_FALLBACK_MODEL();
		} catch {
			return DEFAULT_FALLBACK_MODEL();
		}
	}

	set(next: FallbackModelValue): FallbackModelValue {
		if (next.model) {
			if (!this.registry.models.getModel(next.model.provider, next.model.model)) {
				throw badRequest(`unknown model ${next.model.provider}/${next.model.model}`);
			}
			if (this.registry.isImageModel?.(next.model.provider, next.model.model)) {
				throw badRequest(`${next.model.provider}/${next.model.model} is an image model`);
			}
		}
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(next) });
		return this.get();
	}

	/**
	 * The configured fallback model while it still exists and is a chat model; `null` when off, missing, or identical
	 * to the failing primary model.
	 */
	resolve(primary?: { provider: string; model: string }): ModelChoiceValue | null {
		const chosen = this.get().model;
		if (!chosen) return null;
		if (primary && chosen.provider === primary.provider && chosen.model === primary.model) return null;
		if (!this.registry.models.getModel(chosen.provider, chosen.model)) return null;
		if (this.registry.isImageModel?.(chosen.provider, chosen.model)) return null;
		return chosen;
	}
}
