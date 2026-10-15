import type { FastifyInstance } from "fastify";
import Type from "typebox";
import { MAX_SETTING_BODY, type ClientSettings } from "./client-settings.ts";
import { notFound } from "./errors.ts";
import type { EventBus } from "./events.ts";
import { errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

const Key = Type.Object({ key: Type.String({ minLength: 1, maxLength: 40 }) });
const Setting = Type.Object({ value: Type.Unknown(), updatedAt: Type.Integer() });
const Written = Type.Object({ value: Type.Unknown(), updatedAt: Type.Integer(), applied: Type.Boolean() });
const Body = Type.Object({
	value: Type.Unknown(),
	at: Type.Optional(Type.Integer({ minimum: 0, description: "When the user made the change (ms); defaults to now" })),
	origin: Type.Optional(Type.String({ maxLength: 80, description: "Writing device id, echoed in the event" })),
});

/** Settings that follow the server, not the device: shared live by every client connected to it. */
export function registerClientSettingsRoutes(server: FastifyInstance, store: ClientSettings, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/client-settings", {
		schema: { response: { 200: Type.Object({ settings: Type.Record(Type.String(), Setting) }), ...errors(401) } },
		handler: async () => ({ settings: store.list() }),
	});
	app.get("/client-settings/:key", {
		schema: { params: Key, response: { 200: Setting, ...errors(400, 401, 404) } },
		handler: async (req) => store.get(req.params.key) ?? Promise.reject(notFound("setting")),
	});
	app.put("/client-settings/:key", {
		bodyLimit: MAX_SETTING_BODY, // a route option, not part of `schema`
		schema: { params: Key, body: Body, response: { 200: Written, ...errors(400, 401, 413) } },
		handler: async (req) => {
			const res = store.put(req.params.key, req.body.value, req.body.at);
			if (res.applied) bus.publish(null, "client_settings_updated", { key: req.params.key, updatedAt: res.updatedAt, origin: req.body.origin });
			return res;
		},
	});
}
