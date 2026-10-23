import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { EventBus, type PipayaEvent } from "../src/events.ts";
import { NotificationService, type DevicePresence, type NotificationPayload, type PushTransports } from "../src/notifications.ts";
import { buildApp } from "../src/app.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
function setup(transports: PushTransports = {}, escalateMs = 0) {
  const db = openDb(":memory:"); const bus = new EventBus(db); let now = 1000; const policy = { escalateMs };
  const service = new NotificationService(db, bus, transports, () => now, 5, () => policy.escalateMs);
  const events: PipayaEvent[] = []; bus.subscribe(e => { if (e.type === "notification") events.push(e); });
  disposals.push(async () => { await service.close(); db.close(); });
  return { db, bus, service, events, policy, advance: () => { now += 46_000; }, tick: (ms: number) => { now += ms; } };
}
const presence = (platform: DevicePresence["platform"], focused = false, enabled = true): DevicePresence => ({ platform, focused, enabled, visibleSessionIds: [] });
describe("notification policy", () => {
  test("any attended window suppresses OS/push, even if its own notifications are disabled", () => {
    const { service, events } = setup();
    service.heartbeat("pc", presence("desktop", true, false)); service.heartbeat("phone", presence("ios"));
    expect(service.send("ext", { title: "test" }).suppressed).toBe(true); expect(events).toHaveLength(0);
  });
  test("unattended desktop wins over phones and other tabs; ephemeral notification is not replayed", () => {
    const { service, events, bus } = setup();
    service.heartbeat("phone", presence("android")); service.heartbeat("web", presence("web")); service.heartbeat("pc", presence("desktop"));
    expect(service.send("ext", { title: "test" }).delivered).toBe(1);
    expect(events).toHaveLength(1); expect((events[0]!.data as any).deviceId).toBe("pc"); expect(events[0]!.id).toBe(0);
    expect(bus.history({ after: 0, limit: 20 })).toHaveLength(0);
  });
  test("expired presence no longer suppresses; dedupe is owner-scoped", () => {
    const { service, advance } = setup(); service.heartbeat("pc", presence("desktop", true)); advance();
    expect(service.send("a", { title: "test", key: "key" }).suppressed).toBe(false);
    expect(service.send("a", { title: "test", key: "key" }).suppressed).toBe(true);
    expect(service.send("b", { title: "test", key: "key" }).suppressed).toBe(false);
  });
  test("aborted runs do not notify; a notice carries a short result or reason, never raw usage or file contents", () => {
    const { service, bus, events } = setup(); service.heartbeat("pc", presence("desktop"));
    bus.publish("s1", "run_finished", { status: "aborted" }); expect(events).toHaveLength(0);
    bus.publish("s1", "run_finished", { status: "error", error: "quota exceeded", usage: { cost: "USAGE-SECRET" } });
    bus.publish("s1", "question_requested", { toolCallId: "c", question: "Which file?", options: ["FILE-SECRET"] });
    expect(events).toHaveLength(2);
    const all = JSON.stringify(events);
    expect(all).not.toContain("USAGE-SECRET"); expect(all).not.toContain("FILE-SECRET");
    expect((events[0]!.data as any).notification.body).toBe("quota exceeded");
    expect((events[1]!.data as any).notification.kind).toBe("user_request");
    expect((events[1]!.data as any).notification.body).toBe("Which file?");
  });
  test("durable rules override the default event notice, and revoke is owner-scoped", () => {
    const { service, bus, db, events } = setup(); service.heartbeat("pc", presence("desktop"));
    service.setRule("a", "done", { event: "run_finished", title: "custom" });
    service.setRule("b", "ask", { event: "question_requested", title: "ask" });
    bus.publish("s1", "run_finished", { status: "ok" });
    expect(events).toHaveLength(1); expect((events[0]!.data as any).notification.title).toBe("[a] custom");
    service.removeRules("a"); expect((db.query("SELECT owner FROM notification_rules").all() as any[]).map(r => r.owner)).toEqual(["b"]);
  });
  test("browser refreshes do not exhaust durable mobile registrations", () => {
    const { service, advance, db } = setup();
    for (let i = 0; i < 150; i++) { service.heartbeat(`web-${i}`, presence("web")); advance(); }
    service.heartbeat("phone", presence("ios"), { provider: "fcm", token: "phone" });
    expect((db.query("SELECT COUNT(*) AS n FROM notification_devices").get() as any).n).toBe(1);
  });
  test("rate limit does not affect agent events", () => {
    const { service, bus } = setup(); for (let i = 0; i < 5; i++) service.send("a", { title: "test" });
    expect(() => service.send("a", { title: "test" })).toThrow();
    for (let i = 0; i < 10; i++) expect(() => bus.publish("s", "run_finished", { status: "ok" })).not.toThrow();
  });
  test("every finished run is notified: the flood limit is for extensions, not for the server's own notices", () => {
    const { service, bus, events } = setup(); service.heartbeat("pc", presence("desktop"));
    for (let i = 0; i < 12; i++) bus.publish(`s${i}`, "run_finished", { status: "ok" });
    expect(events).toHaveLength(12);
    for (let i = 0; i < 5; i++) service.send("ext", { title: "x" });
    expect(() => service.send("ext", { title: "x" })).toThrow(); // an extension is still held to five
  });
  test("FCM android and APNs ios use separate adapters; invalid tokens removed", async () => {
    const sent: string[] = [];
    const { service, db } = setup({ fcm: { send: async (token, _payload, platform) => { sent.push(`${platform}:${token}`); return "sent"; } }, apns: { send: async (token, _payload, platform) => { sent.push(`${platform}:${token}`); return "invalid"; } } });
    service.heartbeat("android", presence("android"), { provider: "fcm", token: "a" });
    service.heartbeat("ios", presence("ios"), { provider: "apns", token: "i" });
    service.forget("android"); // re-add with expired presence to simulate a killed process
    service.heartbeat("android", presence("android"), { provider: "fcm", token: "a" });
    // Push fallback is independent of a live mobile event stream until a receipt arrives.
    service.send("ext", { title: "test" }); await pause();
    expect(sent.sort()).toEqual(["android:a", "ios:i"]);
    expect((db.query("SELECT token FROM notification_devices WHERE id = 'ios'").get() as any).token).toBeNull();
  });
  test("receipt from desktop prevents duplicate mobile push; stale sockets without a receipt fall back", async () => {
    const sent: NotificationPayload[] = [];
    const { service } = setup({ fcm: { send: async (_token, payload) => { sent.push(payload); return "sent"; } } });
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" }); service.heartbeat("pc", presence("desktop"));
    const notice = service.send("a", { title: "test" }); service.acknowledge(notice.id); await pause(); expect(sent).toHaveLength(0);
    service.send("a", { title: "no receipt" }); await pause(); expect(sent).toHaveLength(1);
  });
  test("focusing PC during mobile delay cancels push; muted phones and removed devices do not receive", async () => {
    const sent: string[] = [];
    const { service } = setup({ fcm: { send: async token => { sent.push(token); return "sent"; } } });
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "a" }); service.send("a", { title: "test" }); service.heartbeat("pc", presence("desktop", true));
    await pause(); expect(sent).toHaveLength(0);
    service.forget("pc"); service.heartbeat("phone", presence("android", false, false)); service.send("a", { title: "muted" }); await pause(); expect(sent).toHaveLength(0);
  });
  test("answered questions, new runs and rule revocation cancel obsolete pending pushes", async () => {
    let calls = 0; const { service, bus, advance } = setup({ fcm: { send: async () => { calls++; return "sent"; } } });
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" }); advance();
    bus.publish("s", "question_requested", {}); bus.publish("s", "question_resolved", {});
    bus.publish("s", "run_finished", { status: "ok" }); bus.publish("s", "run_started", {});
    service.setRule("ext", "done", { event: "run_finished", title: "done" });
    bus.publish("s", "run_finished", { status: "ok" }); service.removeRules("ext");
    await pause(); expect(calls).toBe(0);
  });
  test("reading a pushed session on another device withdraws the phone's notification, once", async () => {
    const cleared: string[] = [];
    const { service } = setup({ fcm: { send: async () => "sent", clear: async (token, sid) => { cleared.push(`${token}:${sid}`); return "sent"; } } });
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "p" }); service.send("a", { title: "done", sessionId: "s1", kind: "task_completed" });
    await pause();
    service.heartbeat("pc", { ...presence("desktop", true), visibleSessionIds: ["s2"] }); await pause(); expect(cleared).toEqual([]);
    service.heartbeat("pc", { ...presence("desktop", true), visibleSessionIds: ["s1"] }); await pause(); expect(cleared).toEqual(["p:s1"]);
    service.heartbeat("pc", { ...presence("desktop", true), visibleSessionIds: ["s1"] }); await pause(); expect(cleared).toEqual(["p:s1"]);
  });
  test("the phone that read the session is not asked to clear it, and a new run withdraws a finished notice", async () => {
    const cleared: string[] = [];
    const { service, bus, advance } = setup({ fcm: { send: async () => "sent", clear: async (_t, sid) => { cleared.push(sid); return "sent"; } } });
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "p" }); service.send("a", { title: "done", sessionId: "s1", kind: "task_completed" }); await pause();
    service.heartbeat("phone", { ...presence("android", true), visibleSessionIds: ["s1"] }); await pause(); expect(cleared).toEqual([]);
    advance(); service.heartbeat("phone", presence("android"), { provider: "fcm", token: "p" });
    service.send("a", { title: "again", sessionId: "s1", key: "k2", kind: "task_completed" }); await pause();
    bus.publish("s1", "run_started", {}); await pause(); expect(cleared).toEqual(["s1"]);
  });
  test("a phone that can be pushed is pushed at once, not after waiting for a local notification it may be too frozen to show", async () => {
    const sent: string[] = []; const { service, events } = setup({ fcm: { send: async token => { sent.push(token); return "sent"; } } });
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" });
    service.send("a", { title: "test" }); expect(events).toHaveLength(0); // no local notification is sent to a phone that has a push token
    await pause(); expect(sent).toEqual(["phone"]);
  });
  test("a phone's stale 'focused' report stops silencing notifications after a short while", () => {
    const { service, tick } = setup();
    service.heartbeat("phone", presence("android", true)); // the app went to the background before it could report that
    expect(service.send("a", { title: "now" }).suppressed).toBe(true);
    tick(30_000); expect(service.send("a", { title: "later" }).suppressed).toBe(false);
  });
  test("a PC left focused keeps suppressing for as long as it keeps reporting", () => {
    const { service, tick } = setup();
    service.heartbeat("pc", presence("desktop", true)); tick(30_000);
    expect(service.send("a", { title: "test" }).suppressed).toBe(true);
  });
  test("shutdown cancels delayed push", async () => {
    let calls = 0; const { service } = setup({ fcm: { send: async () => { calls++; return "sent"; } } });
    service.heartbeat("phone", presence("ios"), { provider: "fcm", token: "i" }); service.send("a", { title: "test" }); await service.close(); await pause(); expect(calls).toBe(0);
  });
});

describe("unread on the PC: escalate to the phone (Discord style)", () => {
  const pushed = () => { const sent: string[] = []; return { sent, transports: { fcm: { send: async (token: string) => { sent.push(token); return "sent" as const; } } } satisfies PushTransports }; };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const shown = (service: NotificationService, title = "test") => { const n = service.send("a", { title }); service.acknowledge(n.id); return n; };

  test("a notification shown on the PC but never looked at is pushed to the phone after the wait", async () => {
    const { sent, transports } = pushed(); const { service } = setup(transports, 60);
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" }); service.heartbeat("pc", presence("desktop"));
    shown(service);
    await wait(30); expect(sent).toHaveLength(0); // the PC showed it: the phone is not bothered yet
    await wait(80); expect(sent).toEqual(["phone"]); // still unread: now it is
  });

  test("looking at the PC during the wait cancels the push", async () => {
    const { sent, transports } = pushed(); const { service } = setup(transports, 60);
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" }); service.heartbeat("pc", presence("desktop"));
    shown(service); await wait(30);
    service.heartbeat("pc", presence("desktop", true)); // came back to the PC
    service.heartbeat("pc", presence("desktop", false)); // and walked away again
    await wait(100); expect(sent).toHaveLength(0);
  });

  test("with the wait set to 0 a PC that showed it is enough", async () => {
    const { sent, transports } = pushed(); const { service } = setup(transports, 0);
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" }); service.heartbeat("pc", presence("desktop"));
    shown(service); await wait(120); expect(sent).toHaveLength(0);
  });

  test("a phone that showed it needs no second push", async () => {
    const { sent, transports } = pushed(); const { service } = setup(transports, 20);
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" });
    shown(service); await wait(80); expect(sent).toHaveLength(0);
  });

  test("the wait is read per notification, so changing the setting applies at once", async () => {
    const { sent, transports } = pushed(); const { service, policy } = setup(transports, 10_000);
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" }); service.heartbeat("pc", presence("desktop"));
    policy.escalateMs = 20; shown(service); await wait(90); expect(sent).toEqual(["phone"]);
  });

  test("an answered question or a new run cancels the waiting escalation", async () => {
    const { sent, transports } = pushed(); const { service, bus } = setup(transports, 60);
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" }); service.heartbeat("pc", presence("desktop"));
    bus.publish("s", "question_requested", {});
    const [id] = [...(service as any).queued.keys()] as string[]; service.acknowledge(id!); // the PC showed it
    await wait(20); bus.publish("s", "question_resolved", {});
    await wait(100); expect(sent).toHaveLength(0);
  });

  test("an escalation survives a server restart, and one that is long overdue is dropped", async () => {
    const { sent, transports } = pushed(); const db = openDb(":memory:"); const bus = new EventBus(db); let now = 1000;
    const first = new NotificationService(db, bus, transports, () => now, 5, () => 200);
    first.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" }); first.heartbeat("pc", presence("desktop"));
    shown(first); await wait(30);
    expect((db.query("SELECT COUNT(*) AS n FROM notification_escalations").get() as any).n).toBe(1);
    await first.close(); expect(sent).toHaveLength(0);
    now += 150; const second = new NotificationService(db, bus, transports, () => now, 5, () => 200);
    await wait(120); expect(sent).toEqual(["phone"]); // came due after the restart
    expect((db.query("SELECT COUNT(*) AS n FROM notification_escalations").get() as any).n).toBe(0);
    await second.close();
    db.query("INSERT INTO notification_escalations (id, due_at, payload) VALUES ('old', 1, '{\"id\":\"old\",\"title\":\"t\",\"at\":1,\"source\":\"a\"}')").run();
    now = 20 * 60_000; const third = new NotificationService(db, bus, transports, () => now, 5, () => 200);
    await wait(40); expect(sent).toHaveLength(1); expect((db.query("SELECT COUNT(*) AS n FROM notification_escalations").get() as any).n).toBe(0);
    await third.close(); db.close();
  });

  test("an unattended PC that is asleep (no live device) pushes after the short delay, not the long wait", async () => {
    const { sent, transports } = pushed(); const { service } = setup(transports, 10_000);
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "phone" });
    service.send("a", { title: "asleep" }); await wait(40); expect(sent).toEqual(["phone"]);
  });
});

test("notification API requires bearer auth and strictly validates registration/rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipaya-notifications-"));
  const app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db"), token: "t", workspaceRoot: dir, logLevel: "silent" }, { builtinSkills: false });
  disposals.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const headers = { authorization: "Bearer t" };
  expect((await app.server.inject({ method: "GET", url: "/notifications/status" })).statusCode).toBe(401);
  expect((await app.server.inject({ method: "GET", url: "/notifications/status", headers })).json()).toEqual({ pushConfigured: false, providers: [] });
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  expect((await app.server.inject({ method: "PUT", url: "/notifications/devices/phone", headers: jsonHeaders, payload: { ...presence("ios"), push: { provider: "apns", token: "token" } } })).statusCode).toBe(200);
  expect((await app.server.inject({ method: "PUT", url: "/notifications/devices/pc", headers: jsonHeaders, payload: { ...presence("desktop"), push: { provider: "fcm", token: "token" } } })).statusCode).toBe(400);
  expect((await app.server.inject({ method: "PUT", url: "/notifications/rules/ext/done", headers: jsonHeaders, payload: { event: "message_end", title: "no" } })).statusCode).toBe(400);
  expect((await app.server.inject({ method: "POST", url: "/notifications", headers: jsonHeaders, payload: { source: "ext", notification: { title: "request", kind: "user_request" } } })).statusCode).toBe(200);
  // "pipaya" is the source of the built-in notices (the client translates their titles), so an extension cannot use it.
  expect((await app.server.inject({ method: "POST", url: "/notifications", headers: jsonHeaders, payload: { source: "pipaya", notification: { title: "Answer needed", kind: "user_request" } } })).statusCode).toBe(400);
  expect((await app.server.inject({ method: "PUT", url: "/notifications/rules/pipaya/done", headers: jsonHeaders, payload: { event: "run_finished", title: "x" } })).statusCode).toBe(400);
});

test("built-in notices are written in the language of the device that gets them", () => {
  const { service, bus, events } = setup(); service.heartbeat("pc", { ...presence("desktop"), lang: "ko-KR" });
  bus.publish("s1", "run_finished", { status: "ok" });
  bus.publish("s1", "run_finished", { status: "error", error: "401" });
  bus.publish("s1", "question_requested", { question: "계속할까요?" });
  const n = events.map(e => (e.data as any).notification);
  expect(n.map((x: any) => x.title)).toEqual(["✅ 작업 완료", "⚠️ 작업 실패", "❓ 답변 필요"]);
  expect(n[1].body).toBe("401"); expect(n[2].body).toBe("계속할까요?");
  expect(JSON.stringify(n)).not.toContain("facts");
});
test("a device with no known language gets English", () => {
  const { service, bus, events } = setup(); service.heartbeat("pc", presence("desktop"));
  bus.publish("s1", "run_finished", { status: "ok" });
  expect((events[0]!.data as any).notification.title).toBe("✅ Done");
});

describe("test notification", () => {
  test("goes to the asking device even while its window is in front, and says it was sent", () => {
    const { service, events } = setup();
    service.heartbeat("pc", presence("desktop", true)); // looking at settings
    const r = service.test("pc");
    expect(r.status).toBe("sent");
    expect(events).toHaveLength(1);
    expect((events[0]!.data as any).deviceId).toBe("pc");
    expect(((events[0]!.data as any).notification as NotificationPayload).id.startsWith("test-")).toBe(true);
  });
  test("a device the server has not heard from is reported as unknown, and nothing is sent", () => {
    const { service, events } = setup();
    expect(service.test("ghost").status).toBe("unknown_device"); expect(events).toHaveLength(0);
  });
  test("a device that has notifications switched off is reported as disabled, and nothing is sent", () => {
    const { service, events } = setup();
    service.heartbeat("pc", presence("desktop", false, false));
    expect(service.test("pc").status).toBe("disabled"); expect(events).toHaveLength(0);
  });
  test("a heartbeat that went stale is unknown again", () => {
    const { service, advance } = setup();
    service.heartbeat("pc", presence("desktop")); advance();
    expect(service.test("pc").status).toBe("unknown_device");
  });
  test("reports whether mobile push is possible and whether this device has a token", () => {
    const { service } = setup({ fcm: { send: async () => "sent" } });
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "t" });
    const r = service.test("phone");
    expect(r.pushConfigured).toBe(true); expect(r.hasToken).toBe(true); expect(r.providers).toEqual(["fcm"]);
  });
  test("does not start a phone push or count against the dedupe table", () => {
    const { service, db } = setup({ fcm: { send: async () => "sent" } });
    service.heartbeat("pc", presence("desktop")); service.test("pc");
    expect((db.query("SELECT COUNT(*) AS n FROM notification_escalations").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM notification_dedupe").get() as { n: number }).n).toBe(0);
  });
});

describe("device list", () => {
  test("lists phones (kept) and live PCs (in memory), newest first, with their names", () => {
    const { service, tick } = setup();
    service.heartbeat("phone", { ...presence("android"), name: "Galaxy S25" }, { provider: "fcm", token: "t1" });
    tick(1000); service.heartbeat("pc", { ...presence("desktop"), name: "MacBook Air" });
    const list = service.devices();
    expect(list.map(d => d.id)).toEqual(["pc", "phone"]);
    expect(list[0]).toMatchObject({ name: "MacBook Air", platform: "desktop", live: true, push: false });
    expect(list[1]).toMatchObject({ name: "Galaxy S25", platform: "android", live: true, push: true });
    expect(JSON.stringify(list)).not.toContain("t1");
  });
  test("a phone that stopped reporting stays listed as not live; a PC drops out", () => {
    const { service, advance } = setup();
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "t1" }); service.heartbeat("pc", presence("desktop"));
    advance();
    const list = service.devices();
    expect(list.map(d => d.id)).toEqual(["phone"]); expect(list[0]!.live).toBe(false); expect(list[0]!.lastSeen).not.toBeNull();
  });
  test("a device's OS and app version are listed and kept when a later report leaves them out", () => {
    const { service } = setup();
    service.heartbeat("pc", { ...presence("desktop"), name: "my-MacBook-Air", os: "macOS 15.1 \u00b7 aarch64", app: "App 0.1.42" });
    service.heartbeat("pc", presence("desktop"));
    expect(service.devices()[0]).toMatchObject({ name: "my-MacBook-Air", os: "macOS 15.1 \u00b7 aarch64", app: "App 0.1.42" });
  });
  test("a phone keeps its name, OS and app after it stops reporting", () => {
    const { service, advance } = setup();
    service.heartbeat("phone", { ...presence("android"), name: "Galaxy S25", os: "Android 15 \u00b7 aarch64", app: "App 0.1.42" }, { provider: "fcm", token: "t1" });
    service.heartbeat("phone", presence("android"));
    advance();
    expect(service.devices()[0]).toMatchObject({ live: false, name: "Galaxy S25", os: "Android 15 \u00b7 aarch64", app: "App 0.1.42" });
  });
  test("a heartbeat without a name keeps the name already known", () => {
    const { service } = setup();
    service.heartbeat("phone", { ...presence("android"), name: "Galaxy S25" }); service.heartbeat("phone", presence("android"));
    expect(service.devices()[0]!.name).toBe("Galaxy S25");
  });
  test("forgetting removes the device, stops pushes to it and tells it so it can stop reporting", () => {
    const { service, bus } = setup();
    const revoked: unknown[] = []; bus.subscribe(e => { if (e.type === "device_revoked") revoked.push(e.data); });
    service.heartbeat("phone", presence("android"), { provider: "fcm", token: "t1" });
    expect(service.forget("phone")).toBe(true);
    expect(service.devices()).toEqual([]); expect(revoked).toEqual([{ deviceId: "phone" }]);
    expect(service.forget("phone")).toBe(false); expect(revoked).toHaveLength(1);
  });
  test("over HTTP: GET lists, DELETE removes, both need the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipaya-devices-"));
    const app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db"), token: "t", workspaceRoot: dir, logLevel: "silent" }, { builtinSkills: false });
    disposals.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const auth = { authorization: "Bearer t" }, headers = { ...auth, "content-type": "application/json" };
    expect((await app.server.inject({ method: "GET", url: "/notifications/devices" })).statusCode).toBe(401);
    expect((await app.server.inject({ method: "PUT", url: "/notifications/devices/pc", headers, payload: { ...presence("desktop"), name: "MacBook Air", os: "macOS 15.1", app: "App 0.1.42" } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/notifications/devices", headers: auth })).json().devices[0]).toMatchObject({ id: "pc", name: "MacBook Air", os: "macOS 15.1", app: "App 0.1.42", live: true });
    expect((await app.server.inject({ method: "DELETE", url: "/notifications/devices/pc", headers: auth })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/notifications/devices", headers: auth })).json()).toEqual({ devices: [] });
  });
});
