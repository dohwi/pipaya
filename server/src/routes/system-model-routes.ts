import type { FastifyInstance } from "fastify";
import type { EventBus } from "../events.ts";
import { errors } from "../schemas.ts";
import { DEFAULT_SYSTEM_MODEL, SystemModelBody, SystemModelResult, type SystemModelSettings } from "../system-model.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";

/** The light model that runs background jobs (session title, role, @name, group name, follow-up suggestions; null = off). */
export function registerSystemModelRoutes(
	server: FastifyInstance,
	settings: SystemModelSettings,
	bus: EventBus,
	onChange: () => void = () => {},
	onFollowUpChange: (enabled: boolean) => void = () => {},
): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const view = () => ({ settings: settings.get(), defaults: DEFAULT_SYSTEM_MODEL() });
	app.get("/system-model", {
		schema: { response: { 200: SystemModelResult, ...errors(401) } },
		handler: async () => view(),
	});
	app.put("/system-model", {
		schema: { body: SystemModelBody, response: { 200: SystemModelResult, ...errors(400, 401) } },
		handler: async (req) => {
			const prev = settings.get();
			const next = settings.set(req.body);
			bus.publish(null, "configuration_updated", { scope: "system-model" });
			const modelChanged =
				prev.model?.provider !== next.model?.provider ||
				prev.model?.model !== next.model?.model ||
				prev.model?.thinkingLevel !== next.model?.thinkingLevel;
			const backfillTaskEnabled =
				(!prev.tasks.sessionTitle && next.tasks.sessionTitle) ||
				(!prev.tasks.sessionPurpose && next.tasks.sessionPurpose);
			if (next.model && (modelChanged || backfillTaskEnabled)) {
				onChange(); // sessions that already talked get their title/role now, not only on their next message
			}
			const prevFollowUp = Boolean(prev.model) && prev.tasks.followUpSuggestions;
			const nextFollowUp = Boolean(next.model) && next.tasks.followUpSuggestions;
			if (!nextFollowUp && prevFollowUp) {
				onFollowUpChange(false);
			} else if (nextFollowUp && (!prevFollowUp || modelChanged)) {
				onFollowUpChange(true);
			}
			return view();
		},
	});
}
