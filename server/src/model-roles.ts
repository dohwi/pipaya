import type { Database } from "bun:sqlite";
import Type, { type Static } from "typebox";
import { badRequest } from "./errors.ts";
import type { ModelRegistry } from "./models.ts";

/**
 * Named model slots ("light", "summary", "explore", ...). The server and extensions refer to a ROLE, never to a
 * concrete model, so swapping the cheap model later means changing one row here. Names are free-form on purpose:
 * nothing in the server assumes a fixed set, a role without a mapping falls back to the default model.
 */
export const ROLE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_ROLES = 20;

export const RoleSelection = Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const RolesBody = Type.Object(
	{ roles: Type.Record(Type.String(), RoleSelection, { description: `Role name (${ROLE_NAME.source}) to model. Replaces the whole table.` }) },
	{ additionalProperties: false },
);
export const RolesResult = Type.Object({ roles: Type.Record(Type.String(), RoleSelection) });
export type RoleTable = Static<typeof RolesResult>["roles"];

export class ModelRoles {
	constructor(private db: Database, private registry: ModelRegistry) {}

	list(): RoleTable {
		const row = this.db.query("SELECT data FROM settings WHERE key = 'model_roles'").get() as { data: string } | null;
		return row ? (JSON.parse(row.data) as RoleTable) : {};
	}

	/** Replaces the table. Every entry must name a model that exists now, so a typo fails here and not mid-run. */
	set(roles: RoleTable): RoleTable {
		const names = Object.keys(roles);
		if (names.length > MAX_ROLES) throw badRequest(`at most ${MAX_ROLES} roles`);
		for (const name of names) {
			if (!ROLE_NAME.test(name)) throw badRequest(`invalid role name "${name}": use ${ROLE_NAME.source}`);
			const { provider, model } = roles[name]!;
			if (!this.registry.models.getModel(provider, model)) throw badRequest(`role "${name}": unknown model ${provider}/${model}`);
		}
		if (names.length === 0) this.db.query("DELETE FROM settings WHERE key = 'model_roles'").run();
		else this.db.query("INSERT INTO settings (key, data) VALUES ('model_roles', $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ data: JSON.stringify(roles) });
		return this.list();
	}

	/**
	 * The model for a role: its mapping if it has one and the model still exists, else the default model.
	 * `null` only when neither is available.
	 */
	resolve(role: string): { provider: string; model: string; viaRole: boolean } | null {
		const mapped = this.list()[role];
		if (mapped && this.registry.models.getModel(mapped.provider, mapped.model)) return { ...mapped, viaRole: true };
		const fallback = this.registry.defaultSelection?.();
		return fallback ? { ...fallback, viaRole: false } : null;
	}
}
