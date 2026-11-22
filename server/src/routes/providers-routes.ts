import type { Database } from "bun:sqlite";
import type { FastifyInstance } from "fastify";
import { AccountEmails } from "../account-email.ts";
import type { Configuration } from "../configuration.ts";
import type { SqliteCredentialStore } from "../credential-store.ts";
import { notFound } from "../errors.ts";
import type { EventBus } from "../events.ts";
import { builtinProvider, type ModelRegistry } from "../models.ts";
import { deviceId, ProviderLogins } from "../provider-login.ts";
import * as S from "../schemas.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";

export interface ProviderRoutesDeps {
	db: Database;
	registry: ModelRegistry;
	credentials: SqliteCredentialStore;
	configuration: Configuration;
	bus: EventBus;
}

/** Provider catalog, interactive login flows, and API key credential routes. */
export function registerProviderRoutes(server: FastifyInstance, deps: ProviderRoutesDeps): void {
	const { db, registry, credentials, configuration, bus } = deps;
	const app = server.withTypeProvider<TypeBoxProvider>();

	const accountEmails = new AccountEmails(db);
	const logins = new ProviderLogins(
		registry.models,
		async (id) => {
			const credential = await credentials.read(id).catch(() => undefined);
			if (credential) await accountEmails.refresh(id, credential);
			bus.publish(null, "provider_updated", { id, configured: Boolean(await registry.models.checkAuth(id).catch(() => undefined)) });
		},
		{ agentName: "Pipaya", deviceId: () => deviceId(db) },
	);

	app.get("/providers", {
		schema: { response: { 200: S.ProviderList, ...S.errors(401) } },
		handler: async () => {
			const stored = new Map((await credentials.list()).map((c) => [c.providerId, c.type]));
			const custom = new Set(configuration.list().map((c) => c.id));
			return {
				providers: await Promise.all(
					registry.models.getProviders().map(async (p) => ({
						id: p.id,
						name: p.name ?? p.id,
						configured: Boolean(await registry.models.checkAuth(p.id).catch(() => undefined)),
						storedCredential: stored.get(p.id) ?? null,
						...(stored.get(p.id) === "oauth"
							? await accountEmails.backfill(p.id, () => credentials.read(p.id)).then((email) => (email ? { accountEmail: email } : {}))
							: {}),
						loginMethods: [...(p.auth.apiKey?.login ? ["api_key" as const] : []), ...(p.auth.oauth ? ["oauth" as const] : [])],
						...(p.auth.oauth ? { oauthLabel: p.auth.oauth.loginLabel ?? p.auth.oauth.name } : {}),
						builtin: !custom.has(p.id) && builtinProvider(p.id) !== undefined,
					})),
				),
			};
		},
	});

	app.post("/providers/:id/login", {
		schema: { params: S.IdParams, body: S.LoginStartBody, response: { 200: S.LoginState, ...S.errors(400, 401, 404) } },
		handler: async (req) => logins.start(req.params.id, req.body.type),
	});
	app.get("/logins/:id", {
		schema: { params: S.IdParams, response: { 200: S.LoginState, ...S.errors(401, 404) } },
		handler: async (req) => logins.get(req.params.id),
	});
	app.post("/logins/:id/answer", {
		schema: { params: S.IdParams, body: S.LoginAnswerBody, response: { 200: S.LoginState, ...S.errors(401, 404, 409) } },
		handler: async (req) => logins.answer(req.params.id, req.body.promptId, req.body.value),
	});
	app.post("/logins/:id/cancel", {
		schema: { params: S.IdParams, response: { 200: S.LoginState, ...S.errors(401, 404) } },
		handler: async (req) => logins.cancel(req.params.id),
	});

	app.put("/providers/:id/credential", {
		schema: { params: S.IdParams, body: S.CredentialBody, response: { 200: S.Ok, ...S.errors(400, 401, 404) } },
		handler: async (req) => {
			const { id } = req.params;
			if (!registry.models.getProvider(id)) throw notFound("provider");
			await credentials.modify(id, async () => ({ type: "api_key", key: req.body.key }));
			accountEmails.clear(id);
			bus.publish(null, "provider_updated", { id, configured: true });
			return { ok: true };
		},
	});
	app.delete("/providers/:id/credential", {
		schema: { params: S.IdParams, response: { 200: S.Ok, ...S.errors(401) } },
		handler: async (req) => {
			const { id } = req.params;
			await credentials.delete(id);
			accountEmails.clear(id);
			bus.publish(null, "provider_updated", { id, configured: Boolean(await registry.models.checkAuth(id)) });
			return { ok: true };
		},
	});
}
