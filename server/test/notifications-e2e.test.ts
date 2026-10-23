import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { buildApp, type App } from "../src/app.ts";
import type { NotificationPayload, PushTransports } from "../src/notifications.ts";

/** The whole path over HTTP, like real clients: devices report in, an event happens, the right device is told, the phone is pushed only when nobody looked. */
const pushes: { token: string; payload: NotificationPayload; platform: string }[] = [];
const transports: PushTransports = { fcm: { send: async (token, payload, platform) => { pushes.push({ token, payload, platform }); return token === "dead" ? "invalid" : "sent"; } } };
let app: App;
let dir: string;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({ method, url, headers: { authorization: "Bearer t", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};
const device = (id: string, platform: string, focused = false, push?: unknown) => call("PUT", `/notifications/devices/${id}`, { platform, focused, enabled: true, visibleSessionIds: [], ...(push ? { push } : {}) });
const setPolicy = (escalateMinutes: number) => call("PUT", "/client-settings/notificationPolicy", { value: { escalateMinutes } });
/** A chat with a title, made directly: creating one over HTTP needs a model provider that is irrelevant here. */
const chat = (title: string): string => {
	const sid = `chat-${crypto.randomUUID()}`; const db = new Database(join(dir, "db"));
	try { db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, closed, created_at, updated_at) VALUES (?, ?, ?, 'p', 'm', 'medium', '', '[]', 0, 1, 1)").run(sid, title, dir); } finally { db.close(); }
	return sid;
};
/** Puts a message into a chat the way the agent loop does, through a second connection to the same database file. */
const say = (sid: string, seq: number, message: object) => { const db = new Database(join(dir, "db")); try { db.query("INSERT INTO messages (session_id, seq, role, data, created_at) VALUES (?, ?, ?, ?, ?)").run(sid, seq, (message as any).role, JSON.stringify(message), 1); } finally { db.close(); } };
const finishRun = (sid = "s1") => app.bus.publish(sid, "run_finished", { status: "ok" });

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-notify-e2e-"));
	app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db"), token: "t", workspaceRoot: dir, logLevel: "silent" }, { builtinSkills: false, pushTransports: transports, mobileDelayMs: 40, strictResponses: true });
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

/** Every test gets clean devices and its own policy, so the order they run in does not matter. */
const reset = async (minutes: number) => {
	for (const id of ["pc", "phone", "phone2", "phone3"]) await call("DELETE", `/notifications/devices/${id}`);
	await setPolicy(minutes); pushes.length = 0;
};
const toldTo = () => { const out: { deviceId: string; id: string }[] = []; const off = app.bus.subscribe((e) => { if (e.type === "notification") out.push({ deviceId: (e.data as any).deviceId, id: (e.data as any).notification.id }); }); return { out, off }; };

describe("notifications end to end", () => {
	test("nothing chosen yet means the server default; a chosen value is stored and validated", async () => {
		expect((await call("GET", "/client-settings/notificationPolicy")).status).toBe(404);
		expect((await setPolicy(2)).status).toBe(200);
		expect((await call("PUT", "/client-settings/notificationPolicy", { value: { escalateMinutes: 7 } })).status).toBe(400);
	});

	test("the PC is told first; the phone is not pushed while the PC may still be read", async () => {
		await reset(1);
		await device("pc", "desktop"); await device("phone", "android", false, { provider: "fcm", token: "phone-token" });
		const { out, off } = toldTo(); finishRun("a1"); await wait(5);
		expect(out.map((t) => t.deviceId)).toEqual(["pc"]);
		await call("POST", `/notifications/${out[0]!.id}/received`, {}); // the PC shows it
		await wait(150); off(); expect(pushes).toHaveLength(0);
	});

	test("opening the app anywhere before the wait ends stops the push to the phone", async () => {
		await reset(1);
		await device("pc", "desktop"); await device("phone", "android", false, { provider: "fcm", token: "phone-token" });
		const { out, off } = toldTo(); finishRun("a2"); await wait(5);
		await call("POST", `/notifications/${out[0]!.id}/received`, {});
		await wait(80); await device("pc", "desktop", true); await device("pc", "desktop", false); // looked, then left
		await wait(1_100); off(); expect(pushes).toHaveLength(0);
	});

	// "unread for N minutes, then the phone" is timed with a controlled clock in notifications.test.ts: waiting minutes here would only slow the suite.

	test("a phone with no PC online is pushed after the short delay, not the long wait", async () => {
		await reset(60);
		await device("phone", "android", false, { provider: "fcm", token: "phone-token" });
		finishRun("a4"); await wait(150);
		expect(pushes.map((p) => p.token)).toEqual(["phone-token"]);
	});

	test("a removed phone is never pushed", async () => {
		await reset(0);
		await device("phone", "android", false, { provider: "fcm", token: "gone" }); await call("DELETE", "/notifications/devices/phone");
		await device("pc", "desktop"); finishRun("a5"); await wait(150);
		expect(pushes).toHaveLength(0);
	});

	test("an invalid token is cleared after one try and not retried", async () => {
		await reset(0);
		await device("phone2", "android", false, { provider: "fcm", token: "dead" });
		finishRun("a6"); await wait(150); finishRun("a7"); await wait(150);
		expect(pushes.filter((p) => p.token === "dead")).toHaveLength(1);
	});

	test("a question is pushed with its text, so it can be read without opening the app", async () => {
		await reset(0);
		await device("phone3", "android", false, { provider: "fcm", token: "phone3" });
		app.bus.publish("a8", "question_requested", { toolCallId: "c", question: "Deploy now?" }); await wait(150);
		const sent = pushes.find((p) => p.token === "phone3");
		expect(sent).toBeTruthy();
		expect(sent!.payload.title).toContain("Answer needed");
		expect(sent!.payload.body).toBe("Deploy now?");
		expect(sent!.payload.sessionId).toBe("a8");
	});

	test("a finished run reads as a title and a preview of the real answer, in the language of the phone", async () => {
		await reset(0);
		const sid = chat("로그인 버그");
		say(sid, 0, { role: "user", content: "고쳐줘", timestamp: 1 });
		say(sid, 1, { role: "assistant", content: [{ type: "text", text: "## 결과\n원인은 **토큰 만료**였습니다. 갱신 로직을 고치고 테스트 3개를 추가했습니다." }], stopReason: "stop", timestamp: 2 });
		await call("PUT", "/notifications/devices/phone3", { platform: "android", focused: false, enabled: true, visibleSessionIds: [], lang: "ko-KR", push: { provider: "fcm", token: "phone3" } });
		app.bus.publish(sid, "run_finished", { status: "ok", error: null, durationMs: 134_000 }); await wait(150);
		const sent = pushes.find((p) => p.token === "phone3");
		expect(sent!.payload.title).toBe("✅ 작업 완료 · 로그인 버그");
		expect(sent!.payload.body).toBe("결과 원인은 토큰 만료였습니다. 갱신 로직을 고치고 테스트 3개를 추가했습니다. · 2분 14초 걸림");
		expect((sent!.payload as any).facts).toBeUndefined();
	});

	test("the same event reads in English on an English phone", async () => {
		await reset(0);
		const sid = chat("Login bug");
		say(sid, 0, { role: "assistant", content: [{ type: "text", text: "Fixed the token refresh." }], stopReason: "stop", timestamp: 2 });
		await call("PUT", "/notifications/devices/phone3", { platform: "android", focused: false, enabled: true, visibleSessionIds: [], lang: "en-US", push: { provider: "fcm", token: "phone3" } });
		app.bus.publish(sid, "run_finished", { status: "ok", error: null, durationMs: 4000 }); await wait(150);
		const sent = pushes.find((p) => p.token === "phone3");
		expect(sent!.payload.title).toBe("✅ Done · Login bug"); expect(sent!.payload.body).toBe("Fixed the token refresh.");
	});
});
