import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { isLiveModel, sessionUpdate } from "../src/voice-realtime.ts";
import { DEFAULT_REALTIME_SETTINGS, parseRealtimeUrl, realtimeSocketOf } from "../src/voice-input.ts";

/**
 * A stand-in Realtime API: takes the session update, answers `session.updated`, and turns every commit (the server's
 * VAD or the client's "stop") into one transcribed phrase made of the audio frames it got.
 */
interface FakeRealtime {
	url: string;
	sessions: { url: string; authorization: string | null; update: any; frames: number }[];
	stop(): void;
}
function startFakeRealtime(): FakeRealtime {
	const state: FakeRealtime = { url: "", sessions: [], stop() {} };
	const server = Bun.serve<{ i: number }, never>({
		port: 0,
		fetch(req, srv) {
			const i = state.sessions.push({ url: req.url, authorization: req.headers.get("authorization"), update: null, frames: 0 }) - 1;
			return srv.upgrade(req, { data: { i } }) ? undefined : new Response("no", { status: 400 });
		},
		websocket: {
			message(ws, raw) {
				const s = state.sessions[ws.data.i]!;
				const e = JSON.parse(String(raw));
				if (e.type === "session.update") {
					s.update = e;
					ws.send(JSON.stringify({ type: "session.updated", session: e.session }));
				} else if (e.type === "input_audio_buffer.append") {
					s.frames++;
				} else if (e.type === "input_audio_buffer.commit") {
					if (!s.frames) return void ws.send(JSON.stringify({ type: "error", error: { message: "buffer too small" } }));
					const item = `item_${s.frames}`;
					ws.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: item }));
					ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: item, delta: "커밋" }));
					ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: item, transcript: ` 커밋하고 푸시해줘 (${s.frames}) ` }));
					s.frames = 0;
				}
			},
		},
	});
	state.url = `http://127.0.0.1:${server.port}/v1`;
	state.stop = () => server.stop(true);
	return state;
}

let app: App;
let dir: string;
let fake: FakeRealtime;
let base = "";
const token = "test-token";
const api = async (method: string, url: string, payload?: unknown) => {
	const r = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
	const text = await r.text();
	return { status: r.status, json: text ? JSON.parse(text) : undefined };
};
/** Opens the voice socket the way a browser does (a one-time ticket in the URL) and collects what comes back. */
async function session(run: (ws: WebSocket) => void | Promise<void>, query = "") {
	const { json } = await api("POST", "/stream-tickets");
	const ws = new WebSocket(`${base.replace("http", "ws")}/voice/realtime?ticket=${encodeURIComponent(json.ticket)}${query}`);
	const got: any[] = [];
	const closed = new Promise<{ code: number }>((resolve) => { ws.onclose = (e) => resolve({ code: e.code }); });
	ws.onmessage = (m) => {
		const msg = JSON.parse(String(m.data));
		got.push(msg);
		if (msg.type === "ready") void run(ws);
	};
	const { code } = await Promise.race([closed, new Promise<{ code: number }>((r) => setTimeout(() => r({ code: -1 }), 5000))]);
	return { got, code };
}
const pcm = () => new Uint8Array(4800);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-voice-rt-"));
	fake = startFakeRealtime();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token, workspaceRoot: join(dir, "ws"), logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
	await app.server.listen({ host: "127.0.0.1", port: 0 });
	const address = app.server.server.address();
	base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	expect((await api("PUT", "/voice", { settings: realtimeSettings(), realtimeApiKey: "sk-rt-1" })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	fake.stop();
	rmSync(dir, { recursive: true, force: true });
});

const realtimeSettings = (patch: Record<string, unknown> = {}) => ({
	enabled: true, baseUrl: "", path: "", model: "", language: "ko", mode: "realtime",
	realtime: { url: `${fake.url.replace("http", "ws")}/realtime`, model: "gpt-realtime-2.1", transcribeModel: "gpt-live-transcribe", keywords: [" Pipaya ", "Tailscale", "Pipaya", ""], prompt: "개발 작업 지시", ...patch },
});

describe("realtime voice settings", () => {
	test("saves the mode and the hints, trimmed and without repeats", async () => {
		const { status, json } = await api("PUT", "/voice", { settings: realtimeSettings() });
		expect(status).toBe(200);
		expect(json.settings.mode).toBe("realtime");
		expect(json.settings.realtime).toEqual({ url: `${fake.url.replace("http", "ws")}/realtime`, model: "gpt-realtime-2.1", transcribeModel: "gpt-live-transcribe", keywords: ["Pipaya", "Tailscale"], prompt: "개발 작업 지시" });
		expect(json.realtimeEndpoint).toBe(`${fake.url.replace("http", "ws")}/realtime?model=gpt-realtime-2.1`);
		// the key is stored and reported, never returned
		expect(json.hasRealtimeKey).toBe(true);
		expect(JSON.stringify(json)).not.toContain("sk-rt-1");
	});
	test("a client from before the realtime mode keeps the stored mode and hints", async () => {
		const { json } = await api("PUT", "/voice", { settings: { enabled: true, baseUrl: "", path: "", model: "", language: "ko" } });
		expect(json.settings.mode).toBe("realtime");
		expect(json.settings.realtime.keywords).toEqual(["Pipaya", "Tailscale"]);
	});
	test("an https address is stored as wss; credentials or a fragment in it are refused", async () => {
		const { json } = await api("PUT", "/voice", { settings: realtimeSettings({ url: "https://rt.example.com/v1/realtime" }) });
		expect(json.settings.realtime.url).toBe("wss://rt.example.com/v1/realtime");
		for (const url of ["ftp://x/realtime", "wss://user:pw@x/realtime", "wss://x/realtime#a", "not a url"]) {
			expect((await api("PUT", "/voice", { settings: realtimeSettings({ url }) })).status).toBe(400);
		}
		await api("PUT", "/voice", { settings: realtimeSettings() });
	});
	test("refuses too many keywords and a long context", async () => {
		expect((await api("PUT", "/voice", { settings: realtimeSettings({ keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }) })).status).toBe(400);
		expect((await api("PUT", "/voice", { settings: realtimeSettings({ prompt: "x".repeat(301) }) })).status).toBe(400);
	});
});

describe("GET /voice/realtime", () => {
	test("needs a credential", async () => {
		const ws = new WebSocket(`${base.replace("http", "ws")}/voice/realtime`);
		const code = await new Promise<number>((resolve) => { ws.onclose = (e) => resolve(e.code); ws.onerror = () => {}; });
		expect(code).not.toBe(1000);
	});
	test("relays audio with the connection's key and the hints, and sends each phrase back", async () => {
		await api("PUT", "/voice", { settings: realtimeSettings() });
		const before = fake.sessions.length;
		const { got, code } = await session((ws) => {
			for (let i = 0; i < 3; i++) ws.send(pcm());
			ws.send(JSON.stringify({ type: "stop" }));
		});
		expect(code).toBe(1000);
		const s = fake.sessions[before]!;
		expect(s.authorization).toBe("Bearer sk-rt-1");
		expect(new URL(s.url).pathname).toBe("/v1/realtime");
		expect(new URL(s.url).searchParams.get("model")).toBe("gpt-realtime-2.1");
		const input = s.update.session.audio.input;
		expect(input.transcription).toEqual({ model: "gpt-live-transcribe", languages: ["ko"], keywords: ["Pipaya", "Tailscale"], prompt: "개발 작업 지시", delay: "low" });
		expect(input.turn_detection).toBeNull();
		expect(got.map((m) => m.type)).toEqual(["ready", "delta", "phrase", "done"]);
		expect(got.find((m) => m.type === "phrase").text).toBe("커밋하고 푸시해줘 (3)");
		// the key never travels to the browser
		expect(JSON.stringify(got)).not.toContain("sk-rt-1");
	});
	test("a stop with nothing said ends cleanly", async () => {
		const { got, code } = await session((ws) => ws.send(JSON.stringify({ type: "stop" })));
		expect(code).toBe(1000);
		expect(got.map((m) => m.type)).toEqual(["ready", "done"]);
	});
	test("the file mode or a missing address refuses the socket with a reason", async () => {
		await api("PUT", "/voice", { settings: { ...realtimeSettings(), mode: "file" } });
		let r = await session(() => {});
		expect(r.got[0]).toMatchObject({ type: "error", code: "not_configured" });
		await api("PUT", "/voice", { settings: realtimeSettings({ url: "" }) });
		r = await session(() => {});
		expect(r.got[0]).toMatchObject({ type: "error", code: "not_configured" });
		await api("PUT", "/voice", { settings: realtimeSettings() });
	});
	test("a keyless local server gets no Authorization header", async () => {
		await api("PUT", "/voice", { settings: realtimeSettings(), realtimeApiKey: "" });
		const before = fake.sessions.length;
		await session((ws) => ws.send(JSON.stringify({ type: "stop" })));
		expect(fake.sessions[before]!.authorization).toBeNull();
		await api("PUT", "/voice", { settings: realtimeSettings(), realtimeApiKey: "sk-rt-1" });
	});
});

describe("pure helpers", () => {
	test("the Realtime address as typed, and the socket it opens", () => {
		expect(parseRealtimeUrl(" https://ai.example.com/v1/realtime ")).toBe("wss://ai.example.com/v1/realtime");
		expect(parseRealtimeUrl("http://127.0.0.1:8317/v1/realtime")).toBe("ws://127.0.0.1:8317/v1/realtime");
		expect(parseRealtimeUrl("")).toBe("");
		expect(parseRealtimeUrl("ftp://x")).toBeNull();
		expect(realtimeSocketOf({ url: "wss://x/v1/realtime", model: "gpt-realtime-2.1" })).toBe("wss://x/v1/realtime?model=gpt-realtime-2.1");
		// an address that names its model keeps it
		expect(realtimeSocketOf({ url: "wss://x/v1/realtime?model=other", model: "gpt-realtime-2.1" })).toBe("wss://x/v1/realtime?model=other");
		expect(realtimeSocketOf({ url: "", model: "m" })).toBeNull();
	});
	test("the session update leaves out empty hints", () => {
		const u = sessionUpdate({ ...DEFAULT_REALTIME_SETTINGS(), transcribeModel: "gpt-transcribe" }, "");
		expect(u.session.audio.input.transcription).toEqual({ model: "gpt-transcribe" });
		expect(u.session.output_modalities).toEqual(["text"]);
		expect(u.session.audio.input.turn_detection?.type).toBe("server_vad");
	});
	test("a live model streams words with a low delay and no voice activity detection (the user's stop ends the turn)", () => {
		const u = sessionUpdate(DEFAULT_REALTIME_SETTINGS(), "ko");
		expect(u.session.audio.input.transcription).toEqual({ model: "gpt-live-transcribe", languages: ["ko"], delay: "low" });
		expect(u.session.audio.input.turn_detection).toBeNull();
		expect(isLiveModel("gpt-live-transcribe")).toBe(true);
		expect(isLiveModel("gpt-transcribe")).toBe(false);
	});
});

describe("POST /voice/test in the realtime mode", () => {
	test("opens a session, waits for the settings to be taken, and keeps the result", async () => {
		await api("PUT", "/voice", { settings: realtimeSettings() });
		const before = fake.sessions.length;
		const { status } = await api("POST", "/voice/test", {});
		expect(status).toBe(200);
		expect(fake.sessions.length).toBe(before + 1);
		expect(fake.sessions[before]!.update.session.audio.input.transcription.keywords).toEqual(["Pipaya", "Tailscale"]);
		expect((await api("GET", "/voice")).json.test.ok).toBe(true);
	});
	test("no address is a settings failure", async () => {
		await api("PUT", "/voice", { settings: realtimeSettings({ url: "" }) });
		const { status, json } = await api("POST", "/voice/test", {});
		expect(status).toBe(400);
		expect(json.error.code).toBe("not_configured");
	});
});
