import type { FastifyInstance } from "fastify";
import type { EventBus } from "./events.ts";
import { DEFAULT_IMAGE_MODEL, ImageModelResult, ImageModelSchema, type ImageModelSettings } from "./image-generation.ts";
import { errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** The image model agents draw with (`generate_image`); null = off. */
export function registerImageModelRoutes(server: FastifyInstance, settings: ImageModelSettings, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const view = () => ({ settings: settings.get(), defaults: DEFAULT_IMAGE_MODEL() });
	app.get("/image-model", {
		schema: { response: { 200: ImageModelResult, ...errors(401) } },
		handler: async () => view(),
	});
	app.put("/image-model", {
		schema: { body: ImageModelSchema, response: { 200: ImageModelResult, ...errors(400, 401) } },
		handler: async (req) => {
			settings.set(req.body);
			bus.publish(null, "configuration_updated", { scope: "image-model" });
			return view();
		},
	});
}
