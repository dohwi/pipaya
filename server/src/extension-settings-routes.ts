import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { EventBus } from "./events.ts";
import type { ExtensionSettings } from "./extension-settings.ts";
import { notFound } from "./errors.ts";
import { IdParams, Ok, errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

const SettingsObject = Type.Record(Type.String(), Type.Unknown(), { description: "Plain JSON object owned by the extension (max 16000 chars of JSON)" });
const Stored = Type.Object({
	value: SettingsObject,
	updatedAt: Type.Integer({ description: "Unix ms of the write that produced this value" }),
});
const AllSettings = Type.Object({ settings: Type.Record(Type.String(), Stored, { description: "Settings keyed by extension id" }) });
const SaveBody = Type.Object({
	settings: SettingsObject,
	at: Type.Optional(Type.Integer({ minimum: 0, description: "When the user made the change (ms); defaults to now. An older write does not replace a newer value" })),
	origin: Type.Optional(Type.String({ maxLength: 80, description: "Writing device id, echoed in the event" })),
});
const SaveResult = Type.Object({
	value: SettingsObject,
	updatedAt: Type.Integer(),
	applied: Type.Boolean({ description: "false when a newer value was already stored; the caller should adopt the returned one" }),
});

/** Generic per-extension settings store shared by every client of this server. */
export function registerExtensionSettingsRoutes(server: FastifyInstance, store: ExtensionSettings, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/extensions/settings", {
		schema: { response: { 200: AllSettings, ...errors(401) } },
		handler: async () => ({ settings: store.listStored() }),
	});
	app.get("/extensions/:id/settings", {
		schema: { params: IdParams, response: { 200: Stored, ...errors(400, 401, 404) } },
		handler: async (req) => store.getStored(req.params.id) ?? Promise.reject(notFound("settings")),
	});
	app.put("/extensions/:id/settings", {
		schema: { params: IdParams, body: SaveBody, response: { 200: SaveResult, ...errors(400, 401, 409, 413) } },
		handler: async (req) => {
			const res = store.save(req.params.id, req.body.settings, req.body.at);
			if (res.applied) bus.publish(null, "extension_settings_updated", { id: req.params.id, action: "saved", updatedAt: res.updatedAt, origin: req.body.origin });
			return res;
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
