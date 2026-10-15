import type { FastifyInstance } from "fastify";
import Type from "typebox";
import { badRequest, HttpError } from "./errors.ts";
import { NotificationService } from "./notifications.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";
const id = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9._-]+$" });
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const owner = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z][a-z0-9.-]*$" });
const spec = Type.Object({ title: text(183), body: Type.Optional(text(300)), kind: Type.Optional(Type.Union((["task_completed", "task_failed", "approval_required", "user_request", "info"] as const).map(value => Type.Literal(value)))), sessionId: Type.Optional(id), key: Type.Optional(text(160)) }, { additionalProperties: false });
export function registerNotificationRoutes(server: FastifyInstance, service: NotificationService, sessionExists: (id: string) => boolean) {
  const app = server.withTypeProvider<TypeBoxProvider>();
  app.get("/notifications/status", async () => ({ pushConfigured: service.pushConfigured, providers: service.providers }));
  app.get("/notifications/devices", async () => ({ devices: service.devices() }));
  app.put("/notifications/devices/:id", {
    schema: { params: Type.Object({ id }), body: Type.Object({
      platform: Type.Union((["desktop", "android", "ios", "web"] as const).map(value => Type.Literal(value))), focused: Type.Boolean(), enabled: Type.Boolean(), visibleSessionIds: Type.Array(id, { maxItems: 20 }), lang: Type.Optional(text(16)), name: Type.Optional(text(60)), os: Type.Optional(text(60)), app: Type.Optional(text(60)),
      push: Type.Optional(Type.Union([Type.Null(), Type.Object({ provider: Type.Union([Type.Literal("fcm"), Type.Literal("apns")]), token: text(4096) }, { additionalProperties: false })])),
    }, { additionalProperties: false }) },
    handler: async req => {
      if (req.body.push && !["android", "ios"].includes(req.body.platform)) throw badRequest("push registration requires a mobile platform");
      if (req.body.push?.provider === "apns" && req.body.platform !== "ios") throw badRequest("APNs requires iOS");
      service.heartbeat(req.params.id, req.body, req.body.push); return { ok: true };
    },
  });
  app.post("/notifications/devices/:id/test", { schema: { params: Type.Object({ id }) }, handler: async req => service.test(req.params.id) });
  app.delete("/notifications/devices/:id", { schema: { params: Type.Object({ id }) }, handler: async req => { service.forget(req.params.id); return { ok: true }; } });
  app.post("/notifications/:id/received", { schema: { params: Type.Object({ id }) }, handler: async req => { service.acknowledge(req.params.id); return { ok: true }; } });
  app.post("/notifications", {
    schema: { body: Type.Object({ source: owner, notification: spec }, { additionalProperties: false }) },
    handler: async req => {
      if (req.body.source === "harness") throw badRequest("source \"harness\" is reserved for built-in notifications");
      if (req.body.notification.sessionId && !sessionExists(req.body.notification.sessionId)) throw badRequest("unknown notification session");
      try { return service.send(req.body.source, req.body.notification); } catch { throw new HttpError(429, "notification_limit", "notification rate limit reached"); }
    },
  });
  app.put("/notifications/rules/:owner/:id", {
    schema: { params: Type.Object({ owner, id }), body: Type.Object({ event: Type.Union([Type.Literal("run_finished"), Type.Literal("approval_requested")]), title: text(100), body: Type.Optional(text(300)) }, { additionalProperties: false }) },
    handler: async req => { if (req.params.owner === "harness") throw badRequest("owner \"harness\" is reserved"); try { service.setRule(req.params.owner, req.params.id, req.body); } catch { throw badRequest("notification rule limit reached"); } return { ok: true }; },
  });
  app.delete("/notifications/rules/:owner", { schema: { params: Type.Object({ owner }) }, handler: async req => { service.removeRules(req.params.owner); return { ok: true }; } });
  app.delete("/notifications/rules/:owner/:id", { schema: { params: Type.Object({ owner, id }) }, handler: async req => { service.removeRule(req.params.owner, req.params.id); return { ok: true }; } });
}
