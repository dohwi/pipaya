import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { SILENCE_WAV } from "../src/voice-routes.ts";
import { MAX_AUDIO_BYTES, endpointOf, parseBase, parsePath, usesLanguagesList } from "../src/voice-input.ts";

/** A stand-in transcription server: records what it got and answers what the test asks for. */
interface FakeStt {
	url: string;
	requests: { path: string; authorization: string | null; fields: Record<string, string>; file: { name: string; type: string; size: number } | null }[];
	answer: { status: number; body: string; contentType?: string };
	stop(): void;
}

function startFakeStt(): FakeStt {
	const state: FakeStt = { url: "", requests: [], answer: { status: 200, body: JSON.stringify({ text: "hello there" }) }, stop() {} };
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const form = await req.formData().catch(() => null);
			const file = form?.get("file");
			const fields: Record<string, string> = {};
			if (form) for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
			state.requests.push({
				path: new URL(req.url).pathname,
				authorization: req.headers.get("authorization"),
				fields,
				file: file instanceof File ? { name: file.name, type: file.type, size: file.size } : null,
			});
			return new Response(state.answer.body, { status: state.answer.status, headers: { "content-type": state.answer.contentType ?? "application/json" } });
		},
	});
	state.url = `http://127.0.0.1:${server.port}`;
	state.stop = () => server.stop(true);
	return state;
}

let app: App;
let dir: string;
let stt: FakeStt;
let base = "";
const token = "test-token";
/**
 * A real socket rather than `inject`: the multipart upload is a FormData body, which the inject helper cannot send
 * (the runtime's parser needs a real request stream). JSON routes go the same way, so one path is tested.
 */
const api = async (method: any, url: string, payload?: unknown, auth = true) => {
	const multipart = typeof FormData !== "undefined" && payload instanceof FormData;
	const response = await fetch(`${base}${url}`, {
		method,
		headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined && !multipart ? { "content-type": "application/json" } : {}) },
		...(payload === undefined ? {} : { body: multipart ? (payload as FormData) : JSON.stringify(payload) }),
	});
	const text = await response.text();
	return { status: response.status, json: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined };
};
const settings = (patch: Partial<Record<string, unknown>> = {}) => ({ enabled: true, baseUrl: stt.url, path: "/stt", model: "whisper-1", language: "", ...patch });
/** A WebM header followed by filler: what a browser's recording starts with, so the bytes are recognized. */
const webmOf = (size: number, fill = 0) => { const b = new Uint8Array(Math.max(size, 16)); b.set([0x1a, 0x45, 0xdf, 0xa3]); if (fill) b.fill(fill, 4); return b; };
const multipart = (bytes: Uint8Array, type = "audio/webm", extra: Record<string, string> = {}) => {
	const form = new FormData();
	form.append("file", new File([bytes], "voice.webm", { type }));
	for (const [k, v] of Object.entries(extra)) form.append(k, v);
	return form;
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-voice-"));
	stt = startFakeStt();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token, workspaceRoot: join(dir, "ws"), logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
	await app.server.listen({ host: "127.0.0.1", port: 0 });
	const address = app.server.server.address();
	base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => {
	await app.close();
	stt.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("voice settings", () => {
	test("the routes need the token", async () => {
		expect((await api("GET", "/voice", undefined, false)).status).toBe(401);
		expect((await api("PUT", "/voice", { settings: settings() }, false)).status).toBe(401);
		expect((await api("POST", "/voice/test", undefined, false)).status).toBe(401);
	});
	test("starts off and unset, and never returns the key", async () => {
		const { status, json } = await api("GET", "/voice");
		expect(status).toBe(200);
		expect(json.settings).toEqual({ enabled: false, baseUrl: "", path: "", model: "", language: "" });
		expect(json.hasKey).toBe(false);
		expect(json.endpoint).toBeNull();
		expect(JSON.stringify(json)).not.toContain(token);
	});
	test("saves the address, path, model and language; a key is stored but only reported as present", async () => {
		const { status, json } = await api("PUT", "/voice", { settings: settings({ language: "ko" }), apiKey: "sk-test-123" });
		expect(status).toBe(200);
		expect(json.settings.baseUrl).toBe(stt.url);
		expect(json.settings.path).toBe("/stt");
		expect(json.hasKey).toBe(true);
		expect(json.endpoint).toBe(`${stt.url}/stt`);
		expect(JSON.stringify(json)).not.toContain("sk-test-123");
		// the default path is stored as empty ("use the default")
		const saved = await api("PUT", "/voice", { settings: settings({ path: "/v1/audio/transcriptions" }) });
		expect(saved.json.settings.path).toBe("");
		expect(saved.json.endpoint).toBe(`${stt.url}/v1/audio/transcriptions`);
	});
	test("refuses a bad address, a path that is not one, and keeps the stored key when none is sent", async () => {
		for (const baseUrl of ["ftp://x", "https://user:pw@x", "https://x/?q=1", "https://x/sub", "not a url"]) {
			expect((await api("PUT", "/voice", { settings: settings({ baseUrl }) })).status).toBe(400);
		}
		for (const path of ["stt", "//x", "/a/../b", "/a b", "https://x/y"]) {
			expect((await api("PUT", "/voice", { settings: settings({ path }) })).status).toBe(400);
		}
		const kept = await api("PUT", "/voice", { settings: settings({ path: "/stt" }) });
		expect(kept.json.hasKey).toBe(true);
		const cleared = await api("PUT", "/voice", { settings: settings({ path: "/stt" }), apiKey: "" });
		expect(cleared.json.hasKey).toBe(false);
		await api("PUT", "/voice", { settings: settings({ path: "/stt" }), apiKey: "sk-test-123" });
	});
});

describe("POST /voice/transcribe", () => {
	test("relays the recording and answers its text", async () => {
		stt.requests.length = 0;
		stt.answer = { status: 200, body: JSON.stringify({ text: " 안녕하세요 " }) };
		await api("PUT", "/voice", { settings: settings({ language: "ko" }) });
		const r = await api("POST", "/voice/transcribe", multipart(webmOf(1200, 7)));
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ text: "안녕하세요" });
		const sent = stt.requests[0]!;
		expect(sent.path).toBe("/stt");
		expect(sent.authorization).toBe("Bearer sk-test-123");
		expect(sent.fields.model).toBe("whisper-1");
		expect(sent.fields.language).toBe("ko"); // the saved hint
		// the fake server re-reads the forwarded upload with the same parser, which labels the WebM container as video
		expect(sent.file).toEqual({ name: "voice.webm", type: "video/webm", size: 1200 });
	});
	test("a language in the request wins; gpt-transcribe sends languages[] instead", async () => {
		stt.requests.length = 0;
		await api("POST", "/voice/transcribe", multipart(webmOf(1200), "audio/webm", { language: "ja" }));
		expect(stt.requests[0]!.fields.language).toBe("ja"); // sent with the recording, not from the settings
		await api("PUT", "/voice", { settings: settings({ model: "gpt-transcribe", language: "ja" }) });
		stt.requests.length = 0;
		await api("POST", "/voice/transcribe", multipart(webmOf(1200)));
		expect(stt.requests[0]!.fields["languages[]"]).toBe("ja");
		expect(stt.requests[0]!.fields.language).toBeUndefined();
		await api("PUT", "/voice", { settings: settings({ path: "/stt" }) });
	});
	test("upstream failures become the client's error kinds", async () => {
		for (const [upstream, status, code] of [[401, 502, "bad_key"], [403, 502, "bad_key"], [404, 502, "not_found"], [413, 413, "too_large"], [500, 502, "upstream_error"], [504, 504, "timeout"]] as const) {
			stt.answer = { status: upstream, body: JSON.stringify({ error: "nope" }) };
			const r = await api("POST", "/voice/transcribe", multipart(webmOf(1200)));
			expect({ upstream, status: r.status, code: r.json.error.code }).toEqual({ upstream, status, code });
		}
		stt.answer = { status: 200, body: "<html>not json</html>", contentType: "text/html" };
		const bad = await api("POST", "/voice/transcribe", multipart(webmOf(1200)));
		expect(bad.json.error.code).toBe("bad_response");
		stt.answer = { status: 200, body: JSON.stringify({ nope: 1 }) };
		expect((await api("POST", "/voice/transcribe", multipart(webmOf(1200)))).json.error.code).toBe("bad_response");
		stt.answer = { status: 200, body: JSON.stringify({ text: "ok" }) };
	});
	test("refuses what is not an audio upload, and an oversized one before it is sent", async () => {
		stt.requests.length = 0;
		expect((await api("POST", "/voice/transcribe", { hi: 1 })).json.error.code).toBe("invalid_request");
		expect((await api("POST", "/voice/transcribe", multipart(new Uint8Array(0)))).status).toBe(400);
		// (the runtime's parser keeps a zero-byte part, so this is the "empty audio" refusal, not a missing file)
		// A part whose type the parser drops is judged by its bytes: random bytes are not a recording container.
		const notAudio = await api("POST", "/voice/transcribe", multipart(new Uint8Array(100).fill(9), "application/octet-stream"));
		expect({ status: notAudio.status, body: notAudio.json }).toEqual({ status: 400, body: { error: { code: "invalid_request", message: "the file is not audio" } } });
		// A real WebM header is accepted even when the parser guessed the type from the file name.
		expect((await api("POST", "/voice/transcribe", multipart(webmOf(1200), "application/octet-stream"))).status).toBe(200);
		stt.requests.length = 0;
		// over the audio cap but under the route's body limit: refused by the size check, before anything is sent
		const tooBig = await api("POST", "/voice/transcribe", multipart(webmOf(MAX_AUDIO_BYTES + 1)));
		expect(tooBig.status).toBe(413);
		expect(tooBig.json.error.code).toBe("too_large");
		expect(stt.requests).toHaveLength(0);
	});
	test("an unset address or key is refused before anything is sent", async () => {
		await api("PUT", "/voice", { settings: { enabled: true, baseUrl: "", path: "", model: "", language: "" }, apiKey: "" });
		const r = await api("POST", "/voice/transcribe", multipart(webmOf(1200)));
		expect(r.json.error.code).toBe("not_configured");
		await api("PUT", "/voice", { settings: settings({ path: "/stt" }), apiKey: "sk-test-123" });
	});
});

describe("POST /voice/test", () => {
	test("sends a short WAV and reports the answer", async () => {
		stt.requests.length = 0;
		stt.answer = { status: 200, body: JSON.stringify({ text: "" }) };
		const r = await api("POST", "/voice/test");
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ text: "", status: 200 });
		expect(stt.requests[0]!.file).toEqual({ name: "test.wav", type: "audio/x-wav", size: SILENCE_WAV.length });
	});
	test("a wrong key or path is the specific error, not a silent success", async () => {
		stt.answer = { status: 401, body: JSON.stringify({ error: "bad key" }) };
		expect((await api("POST", "/voice/test")).json.error.code).toBe("bad_key");
		stt.answer = { status: 404, body: JSON.stringify({ error: "no route" }) };
		expect((await api("POST", "/voice/test")).json.error.code).toBe("not_found");
		stt.answer = { status: 200, body: JSON.stringify({ text: "ok" }) };
	});
});

describe("pure helpers", () => {
	test("paths and addresses are read strictly", () => {
		expect(parsePath("")).toBe("/v1/audio/transcriptions");
		expect(parsePath("/v0/management/audio/transcriptions")).toBe("/v0/management/audio/transcriptions");
		expect(parsePath("x")).toBeNull();
		expect(parsePath("/a/../b")).toBeNull();
		expect(parseBase("")).toBe("");
		expect(parseBase("https://api.example.com/")).toBe("https://api.example.com");
		expect(parseBase("https://api.example.com/v1")).toBeNull();
		expect(endpointOf({ baseUrl: "https://api.example.com", path: "" })).toBe("https://api.example.com/v1/audio/transcriptions");
		expect(endpointOf({ baseUrl: "", path: "" })).toBeNull();
	});
	test("only gpt-transcribe takes a language list", () => {
		expect(usesLanguagesList(" GPT-Transcribe ")).toBe(true);
		expect(usesLanguagesList("whisper-1")).toBe(false);
	});
});
