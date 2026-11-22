import type { FastifyInstance } from "fastify";
import Type from "typebox";
import { isAdminOnlyRoute, PUBLIC_PAIRING_PATH } from "./auth-policy.ts";
import type { DeviceTokens } from "./device-tokens.ts";
import { HttpError } from "./errors.ts";
import type { Pairing } from "./pairing.ts";
import { Ok, errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

export { isAdminOnlyRoute, PUBLIC_PAIRING_PATH };

export function registerPairingRoutes(server: FastifyInstance, pairing: Pairing, devices: DeviceTokens, onRevoke: (id: string) => void = () => {}): void {
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
		schema: { response: { 200: Type.Object({ tokens: Type.Array(DeviceTokenInfo), idleDays: Type.Optional(Type.Integer({ description: "A device silent for this many days must pair again; 0 = never" })) }), ...errors(401, 403) } },
		handler: async () => ({ tokens: devices.list(), idleDays: devices.idleLimitDays }),
	});
	app.delete("/devices/tokens/:id", {
		schema: { params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }), response: { 200: Ok, ...errors(401, 403, 404) } },
		handler: async (req) => {
			onRevoke(req.params.id);
			if (!devices.revoke(req.params.id)) throw new HttpError(404, "not_found", "no such device token");
			return { ok: true };
		},
	});
}
