import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { DeviceTokens } from "./device-tokens.ts";
import { HttpError } from "./errors.ts";
import type { Pairing } from "./pairing.ts";
import { Ok, errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Paths reachable without the access token (the code is the credential). Keep in step with the auth hook in app.ts. */
export const PUBLIC_PAIRING_PATH = "/pairing/redeem";

/** Only the admin token may open the door for another device: a paired phone must not be able to pair more phones. */
export const isAdminOnlyPath = (method: string, path: string) =>
	(path === "/pairing" && (method === "POST" || method === "DELETE")) || path === "/devices/tokens" || path.startsWith("/devices/tokens/") ||
	// Server extensions execute code in this process; a paired phone may use their methods but never reload or install them.
	((path === "/server-extensions/reload" || path === "/server-extensions/install") && method === "POST") ||
	(path.startsWith("/server-extensions/") && method === "DELETE") ||
	// Replacing the server's own code and restarting it is the owner's call alone.
	path === "/server/update";

export function registerPairingRoutes(server: FastifyInstance, pairing: Pairing, devices: DeviceTokens): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.post("/pairing", {
		schema: { response: { 200: Type.Object({ code: Type.String(), expiresAt: Type.Integer() }), ...errors(401) } },
		handler: async () => pairing.create(),
	});
	app.delete("/pairing", {
		schema: { response: { 200: Ok, ...errors(401) } },
		handler: async () => {
			pairing.clear();
			return { ok: true };
		},
	});
	app.post(PUBLIC_PAIRING_PATH, {
		schema: {
			body: Type.Object({ code: Type.String({ minLength: 8, maxLength: 128 }), name: Type.Optional(Type.String({ maxLength: 120 })) }),
			response: { 200: Type.Object({ token: Type.String() }), ...errors(403, 429) },
		},
		handler: async (req) => ({ token: pairing.redeem(req.body.code, req.ip, req.body.name) }),
	});
	const DeviceTokenInfo = Type.Object({ id: Type.String(), name: Type.String(), createdAt: Type.Integer(), lastUsedAt: Type.Union([Type.Integer(), Type.Null()]) });
	app.get("/devices/tokens", {
		schema: { response: { 200: Type.Object({ tokens: Type.Array(DeviceTokenInfo) }), ...errors(401, 403) } },
		handler: async () => ({ tokens: devices.list() }),
	});
	app.delete("/devices/tokens/:id", {
		schema: { params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }), response: { 200: Ok, ...errors(401, 403, 404) } },
		handler: async (req) => {
			if (!devices.revoke(req.params.id)) throw new HttpError(404, "not_found", "no such device token");
			return { ok: true };
		},
	});
}
