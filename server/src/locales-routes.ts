import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { EventBus } from "./events.ts";
import type { LocaleStore } from "./locales.ts";
import { MAX_LOCALE_MESSAGES } from "./locales.ts";
import { Ok, errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

const Tag = Type.Object({ tag: Type.String({ description: "BCP 47 language tag, e.g. ja or pt-br (case-insensitive)" }) });
const Summary = Type.Object({
	tag: Type.String(),
	name: Type.String({ description: "Language name in that language" }),
	owner: Type.Optional(Type.String({ description: "Extension id that published the pack" })),
	messages: Type.Integer({ description: "Number of translated strings" }),
	updatedAt: Type.Integer({ description: "Unix ms; clients re-download a pack when this changes" }),
});
const Pack = Type.Object({
	tag: Type.String(),
	name: Type.String(),
	owner: Type.Optional(Type.String()),
	messages: Type.Record(Type.String(), Type.String(), { description: "Korean source string -> translation (`{n}` parameters and `{n#one|many}` plurals are kept as in the source)" }),
	updatedAt: Type.Integer(),
});
const Save = Type.Object({
	name: Type.String({ description: "Language name in that language" }),
	messages: Type.Record(Type.String(), Type.String(), { description: `Up to ${MAX_LOCALE_MESSAGES} entries` }),
	owner: Type.Optional(Type.String({ description: "Extension id publishing the pack" })),
}, { additionalProperties: false });

/** Language packs for the client UI. Built-in languages (ko, en) ship with the client and are not stored here. */
export function registerLocaleRoutes(server: FastifyInstance, store: LocaleStore, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/locales", {
		schema: { response: { 200: Type.Object({ locales: Type.Array(Summary) }), ...errors(401) } },
		handler: async () => ({ locales: store.list() }),
	});
	app.get("/locales/:tag", {
		schema: { params: Tag, response: { 200: Pack, ...errors(400, 401, 404) } },
		handler: async (req) => store.get(req.params.tag),
	});
	app.put("/locales/:tag", {
		schema: { params: Tag, body: Save, response: { 200: Pack, ...errors(400, 401, 409, 413) } },
		handler: async (req) => {
			const { pack, changed } = store.save(req.params.tag, req.body);
			if (changed) bus.publish(null, "locales_updated", { tag: pack.tag, action: "saved", updatedAt: pack.updatedAt });
			return pack;
		},
	});
	app.delete("/locales/:tag", {
		schema: { params: Tag, querystring: Type.Object({ owner: Type.Optional(Type.String({ description: "Only remove the pack if this extension published it" })) }), response: { 200: Ok, ...errors(400, 401) } },
		handler: async (req) => {
			if (store.delete(req.params.tag, req.query.owner)) bus.publish(null, "locales_updated", { tag: req.params.tag.toLowerCase(), action: "deleted", updatedAt: Date.now() });
			return { ok: true };
		},
	});
}
