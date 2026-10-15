import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { EventBus } from "./events.ts";
import type { ExtensionSettings } from "./extension-settings.ts";
import { IdParams, Ok, errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

const SettingsObject = Type.Record(Type.String(), Type.Unknown(), { description: "Plain JSON object owned by the extension (max 16000 chars of JSON)" });
const AllSettings = Type.Object({ settings: Type.Record(Type.String(), SettingsObject, { description: "Settings keyed by extension id" }) });
const SaveBody = Type.Object({ settings: SettingsObject });
const SaveResult = Type.Object({ settings: SettingsObject });

/** Generic per-extension settings store shared by every client of this server. */
export function registerExtensionSettingsRoutes(server: FastifyInstance, store: ExtensionSettings, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/extensions/settings", {
		schema: { response: { 200: AllSettings, ...errors(401) } },
		handler: async () => ({ settings: store.list() }),
	});
	app.put("/extensions/:id/settings", {
		schema: { params: IdParams, body: SaveBody, response: { 200: SaveResult, ...errors(400, 401, 409, 413) } },
		handler: async (req) => {
			const settings = store.save(req.params.id, req.body.settings);
			bus.publish(null, "extension_settings_updated", { id: req.params.id, action: "saved" });
			return { settings };
		},
	});
	app.delete("/extensions/:id", {
		schema: { params: IdParams, response: { 200: Ok, ...errors(400, 401) } },
		handler: async (req) => {
			store.delete(req.params.id);
			bus.publish(null, "extension_settings_updated", { id: req.params.id, action: "deleted" });
			return { ok: true };
		},
	});
}
