import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let base: string;
let dir: string;
let upstream: EchoUpstream;
const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) => {
	const res = await fetch(base + path, {
		method,
		headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined };
};

const untilIdle = async (id: string) => {
	for (let i = 0; i < 200; i++) {
		const { json } = await api("GET", `/sessions/${id}/status`);
		if (!json.running) return;
		await Bun.sleep(25);
	}
	throw new Error("session never went idle");
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-test-"));
	upstream = startEchoUpstream();
	const cfg: Config = {
		host: "0.0.0.0",
		port: 0,
		dataDir: dir,
		dbPath: join(dir, "test.db"),
		token: TOKEN,
		workspaceRoot: join(dir, "ws"),
		defaultApproval: "ask",
		approvalTimeoutMs: 0,
		logLevel: "silent",
	};
	app = await buildApp(cfg, { strictResponses: true });
	await app.server.listen({ host: "0.0.0.0", port: 0 });
	const addr = app.server.server.address() as { port: number };
	base = `http://127.0.0.1:${addr.port}`;
	// Fresh servers have an empty catalog: register the local echo upstream like any user would.
	expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
});

afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

/** Read SSE frames until `until` returns true or the deadline passes. */
async function collectSse(path: string, until: (events: any[]) => boolean, headers: Record<string, string> = auth) {
	const ctrl = new AbortController();
	const res = await fetch(base + path, { headers, signal: ctrl.signal });
	expect(res.headers.get("content-type")).toContain("text/event-stream");
	const events: any[] = [];
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const deadline = Date.now() + 5000;
	try {
		while (Date.now() < deadline && !until(events)) {
			const { value, done } = await Promise.race([
				reader.read(),
				Bun.sleep(300).then(() => ({ value: undefined, done: false })),
			]);
			if (done) break;
			if (!value) continue;
			buf += decoder.decode(value, { stream: true });
			let i: number;
			while ((i = buf.indexOf("\n\n")) !== -1) {
				const frame = buf.slice(0, i);
				buf = buf.slice(i + 2);
				const data = frame.split("\n").find((l) => l.startsWith("data: "));
				if (data) events.push(JSON.parse(data.slice(6)));
			}
		}
	} finally {
		ctrl.abort();
	}
	return events;
}

describe("API contracts", () => {
	test("removed web routes return JSON errors, never HTML or assets", async () => {
		for (const path of ["/", "/docs", "/docs/", "/docs/json", "/openapi.json", "/settings", "/settings/", "/settings/app.js", "/settings/style.css", "/settings/fonts/manrope-variable.woff2"]) {
			const missing = await api("GET", path);
			expect(missing.status).toBe(404);
			expect(missing.json.error.code).toBe("not_found");
			const unauthenticated = await api("GET", path, undefined, {});
			expect(unauthenticated.status).toBe(401);
			expect(unauthenticated.json.error.code).toBe("unauthorized");
		}
	});

	test("health exception applies only to the exact GET endpoint", async () => {
		expect((await api("GET", "/health?probe=1", undefined, {})).status).toBe(200);
		expect((await api("GET", "/health/private", undefined, {})).status).toBe(401);
		expect((await api("POST", "/health", {}, {})).status).toBe(401);
	});

	test("separate client origins can preflight authenticated configuration requests", async () => {
		const res = await fetch(`${base}/configuration`, { method: "OPTIONS", headers: {
			Origin: "http://100.64.0.1:1420", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type",
		} });
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe("http://100.64.0.1:1420");
		expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
	});

	test("CORS rejects untrusted web origins but allows Tailscale, LAN, loopback and Tauri clients", async () => {
		const preflight = (origin: string) => fetch(`${base}/configuration`, { method: "OPTIONS", headers: {
			Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization",
		} });
		for (const origin of ["https://evil.example", "http://100.200.0.1:1420", "http://172.32.0.1", "null"]) {
			expect((await preflight(origin)).headers.get("access-control-allow-origin")).toBeNull();
		}
		for (const origin of ["http://100.64.0.1:1420", "http://localhost:1420", "http://192.168.0.5:8787", "tauri://localhost", "http://tauri.localhost"]) {
			expect((await preflight(origin)).headers.get("access-control-allow-origin")).toBe(origin);
		}
	});

	test("SSE responses only echo trusted origins", async () => {
		const open = async (origin: string) => {
			const ctrl = new AbortController();
			const res = await fetch(`${base}/events?token=${TOKEN}`, { headers: { Origin: origin }, signal: ctrl.signal });
			const allow = res.headers.get("access-control-allow-origin");
			ctrl.abort();
			return allow;
		};
		expect(await open("https://evil.example")).toBeNull();
		expect(await open("http://100.64.0.1:1420")).toBe("http://100.64.0.1:1420");
	});

	test("event catalog covers every event type the server publishes", async () => {
		const catalog = (await api("GET", "/events/types")).json.events;
		const known = new Set(catalog.map((e: any) => e.type));
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "!bash echo hi" });
		await untilIdle(id);
		const hist = (await api("GET", `/events/history?sessionId=${id}&limit=1000`)).json.events;
		for (const e of hist) expect(known.has(e.type)).toBe(true);
		expect(catalog.find((e: any) => e.type === "message_update").persisted).toBe(false);
	});

	test("activity lists only sessions that are running or waiting on the user", async () => {
		expect((await api("GET", "/activity")).json).toEqual({ sessions: [] });
		const id = (await api("POST", "/sessions", { approval: "ask" })).json.id as string;
		expect((await api("GET", "/activity")).json.sessions).toEqual([]);
		await api("POST", `/sessions/${id}/messages`, { text: "!bash echo hi" });
		let seen: any = null;
		for (let i = 0; i < 100 && !seen?.pendingApprovals; i++) {
			seen = (await api("GET", "/activity")).json.sessions.find((s: any) => s.sessionId === id);
			await Bun.sleep(20);
		}
		expect(seen).toMatchObject({ running: true, pendingApprovals: 1 });
		const pending = (await api("GET", `/sessions/${id}/status`)).json.pendingToolCalls as string[];
		await api("POST", `/sessions/${id}/approvals/${pending[0]}`, { approved: false });
		await untilIdle(id);
		expect((await api("GET", "/activity")).json.sessions).toEqual([]);
	});

	test("ask_user waits for an answer, validates it, and hands it to the model", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		const args = JSON.stringify({ question: "Which one?", options: ["red", "blue"], allowFreeText: false });
		await api("POST", `/sessions/${id}/messages`, { text: `!ask_user ${args}` });
		let q: any;
		for (let i = 0; i < 100 && !q; i++) {
			q = (await api("GET", `/questions?sessionId=${id}`)).json.questions[0];
			await Bun.sleep(20);
		}
		expect(q).toMatchObject({ sessionId: id, question: "Which one?", options: ["red", "blue"], allowFreeText: false });
		expect((await api("GET", `/sessions/${id}/status`)).json.pendingQuestions).toBe(1);
		expect((await api("GET", "/activity")).json.sessions.find((s: any) => s.sessionId === id)).toMatchObject({ running: true, pendingQuestions: 1 });

		// an answer outside the options is refused and the question stays open
		expect((await api("POST", `/sessions/${id}/questions/${q.toolCallId}`, { answer: "green" })).status).toBe(400);
		expect((await api("GET", `/questions?sessionId=${id}`)).json.questions).toHaveLength(1);
		expect((await api("POST", `/sessions/${id}/questions/nope`, { answer: "red" })).status).toBe(404);

		expect((await api("POST", `/sessions/${id}/questions/${q.toolCallId}`, { answer: "blue" })).status).toBe(200);
		await untilIdle(id);
		expect((await api("GET", `/questions?sessionId=${id}`)).json.questions).toEqual([]);
		// answering twice: nothing is waiting any more
		expect((await api("POST", `/sessions/${id}/questions/${q.toolCallId}`, { answer: "blue" })).status).toBe(404);

		const hist = (await api("GET", `/events/history?sessionId=${id}&limit=1000`)).json.events;
		expect(hist.some((e: any) => e.type === "question_requested")).toBe(true);
		expect(hist.find((e: any) => e.type === "question_resolved").data).toMatchObject({ answered: true, source: "user" });
		const msgs = JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json.messages);
		expect(msgs).toContain("Tool ask_user finished:\\nblue");
	});

	test("aborting a run releases a waiting ask_user question", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: `!ask_user ${JSON.stringify({ question: "Still there?" })}` });
		for (let i = 0; i < 100 && !(await api("GET", `/questions?sessionId=${id}`)).json.questions.length; i++) await Bun.sleep(20);
		await api("POST", `/sessions/${id}/abort`);
		await untilIdle(id);
		expect((await api("GET", `/questions?sessionId=${id}`)).json.questions).toEqual([]);
	});

	test("query params are coerced and validated", async () => {
		expect((await api("GET", "/sessions?limit=2")).status).toBe(200);
		expect((await api("GET", "/sessions?limit=abc")).status).toBe(400);
		expect((await api("GET", "/sessions?limit=0")).status).toBe(400);
		expect((await api("GET", "/models?configured=true")).status).toBe(200);
		// empty POST body is accepted when every field is optional
		expect((await api("POST", "/sessions", {})).status).toBe(201);
	});
});

describe("auth & meta", () => {
	test("health is public but reveals load figures only to the token holder", async () => {
		const r = await api("GET", "/health", undefined, {});
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ ok: true });
		const owner = await api("GET", "/health");
		expect(owner.json.ok).toBe(true);
		expect(typeof owner.json.runningSessions).toBe("number");
	});

	test("other routes require the token", async () => {
		expect((await api("GET", "/sessions", undefined, {})).status).toBe(401);
		expect((await api("GET", "/sessions", undefined, { authorization: "Bearer nope" })).status).toBe(401);
		expect((await api("GET", `/sessions?token=${TOKEN}`, undefined, {})).status).toBe(401);
		expect((await api("POST", `/sessions?token=${TOKEN}`, {}, {})).status).toBe(401);
		expect((await api("PUT", `/providers/openai/credential?token=${TOKEN}`, { key: "not-saved" }, {})).status).toBe(401);
	});

	test("lists tools and models", async () => {
		const tools = await api("GET", "/tools");
		expect(tools.json.tools.map((t: any) => t.name)).toContain("bash");
		const models = await api("GET", "/models?configured=true");
		expect(models.json.models.some((m: any) => m.provider === "echo" && m.id === ECHO_MODEL.id)).toBe(true);
	});

	test("unknown routes return JSON 404", async () => {
		const r = await api("GET", "/nope");
		expect(r.status).toBe(404);
		expect(r.json.error.code).toBe("not_found");
	});
});

describe("working directories", () => {
	test("sessions can start in any existing directory, and the default is configurable", async () => {
		const other = mkdtempSync(join(tmpdir(), "pipaya-elsewhere-"));
		try {
			const outside = await api("POST", "/sessions", { cwd: other });
			expect(outside.status).toBe(201);
			expect(outside.json.cwd).toBe(other);
			// the workspace listing labels directories outside the default by absolute path
			expect((await api("GET", "/workspace")).json.workdirs.map((w: any) => w.path)).toContain(other);
			expect((await api("GET", "/workspace")).json.home).toBe(homedir());

			const before = (await api("GET", "/configuration")).json.workdir;
			expect(before.saved).toBeNull();
			expect(before.effective).toBe(before.fallback);

			expect((await api("PUT", "/configuration/workdir", { path: "relative/dir" })).status).toBe(400);
			expect((await api("PUT", "/configuration/workdir", { path: join(other, "nope") })).status).toBe(400);
			const set = await api("PUT", "/configuration/workdir", { path: other });
			expect(set.status).toBe(200);
			expect(set.json.effective).toBe(other);

			// no cwd -> the new default; a relative cwd resolves against it and is created on demand
			expect((await api("POST", "/sessions", {})).json.cwd).toBe(other);
			const rel = await api("POST", "/sessions", { cwd: "sub/new" });
			expect(rel.json.cwd).toBe(join(other, "sub", "new"));
			expect((await api("GET", "/workspace")).json.root).toBe(other);

			const reset = await api("PUT", "/configuration/workdir", { path: null });
			expect(reset.json.saved).toBeNull();
			expect(reset.json.effective).toBe(before.fallback);
		} finally {
			await api("PUT", "/configuration/workdir", { path: null });
			rmSync(other, { recursive: true, force: true });
		}
	});

	test("directory browser lists folders only and creates new ones", async () => {
		const root = mkdtempSync(join(tmpdir(), "pipaya-fs-"));
		try {
			await api("POST", "/fs/dirs", { parent: root, name: "alpha" });
			await api("POST", "/fs/dirs", { parent: root, name: ".hidden" });
			await Bun.write(join(root, "file.txt"), "x");
			const list = await api("GET", `/fs/dirs?path=${encodeURIComponent(root)}`);
			expect(list.status).toBe(200);
			expect(list.json.entries.map((e: any) => e.name)).toEqual(["alpha"]);
			expect(list.json.parent).toBe(join(root, ".."));
			const all = await api("GET", `/fs/dirs?path=${encodeURIComponent(root)}&hidden=true`);
			expect(all.json.entries.map((e: any) => e.name)).toEqual([".hidden", "alpha"]);

			expect((await api("POST", "/fs/dirs", { parent: root, name: "alpha" })).status).toBe(400);
			expect((await api("POST", "/fs/dirs", { parent: root, name: "../evil" })).status).toBe(400);
			expect((await api("POST", "/fs/dirs", { parent: join(root, "missing"), name: "x" })).status).toBe(400);
			expect((await api("GET", "/fs/dirs?path=relative")).status).toBe(400);
			expect((await api("GET", `/fs/dirs?path=${encodeURIComponent(join(root, "file.txt"))}`)).status).toBe(400);
			expect((await api("GET", "/fs/dirs", undefined, {})).status).toBe(401);
			expect((await api("GET", "/fs/dirs")).json.path).toBeTruthy();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("sessions", () => {
	test("create validates input", async () => {
		for (const thinkingLevel of ["ultra", "off"]) {
			expect((await api("POST", "/sessions", { thinkingLevel })).status).toBe(400);
		}
		const badModel = await api("POST", "/sessions", { provider: "echo", model: "nope" });
		expect(badModel.status).toBe(400);
		// outside the default directory is allowed only for directories that already exist
		const missing = await api("POST", "/sessions", { cwd: "/nonexistent-pipaya-dir/x" });
		expect(missing.status).toBe(400);
		const escapedMissing = await api("POST", "/sessions", { cwd: "../../nonexistent-pipaya-dir" });
		expect(escapedMissing.status).toBe(400);
		const badTool = await api("POST", "/sessions", { tools: ["rm_rf"] });
		expect(badTool.status).toBe(400);
	});

	test("prompt round-trip persists messages and streams events over SSE", async () => {
		const created = await api("POST", "/sessions", { approval: "auto" });
		expect(created.status).toBe(201);
		expect(created.json.thinkingLevel).toBe("medium");
		const id = created.json.id as string;

		const sse = collectSse(`/sessions/${id}/events`, (ev) => ev.some((e) => e.type === "run_finished"));
		await Bun.sleep(50); // let the stream attach
		const sent = await api("POST", `/sessions/${id}/messages`, { text: "hello world" });
		expect(sent.status).toBe(202);
		const events = await sse;

		const types = events.map((e) => e.type);
		expect(types).toContain("run_started");
		expect(types).toContain("message_update");
		expect(types).toContain("run_finished");
		expect(types.indexOf("run_started")).toBeLessThan(types.indexOf("run_finished"));
		const deltas = events
			.filter((e) => e.type === "message_update" && e.data.event.type === "text_delta")
			.map((e) => e.data.event.delta)
			.join("");
		expect(deltas).toBe("Echo: hello world");
		// Deltas are ephemeral: never persisted, never carry the heavy partial snapshot.
		expect(events.find((e) => e.type === "message_update").id).toBe(0);
		expect(events.find((e) => e.type === "message_update").data.event.partial).toBeUndefined();

		const msgs = await api("GET", `/sessions/${id}/messages`);
		expect(msgs.json.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
		expect(msgs.json.messages.map((m: any) => m.seq)).toEqual([0, 1]);

		const detail = await api("GET", `/sessions/${id}`);
		expect(detail.json.title).toBe("hello world");
		expect(detail.json.usage.turns).toBe(1);
		expect(detail.json.status.running).toBe(false);
	});

	test("busy session rejects a second prompt; steer needs an active run", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		const idleSteer = await api("POST", `/sessions/${id}/messages`, { text: "x", mode: "steer" });
		expect(idleSteer.status).toBe(409);
		expect((await api("POST", `/sessions/${id}/messages`, { text: "" })).status).toBe(400);
	});

	test("patch, fork and delete", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto", title: "orig" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "first" });
		await untilIdle(id);

		const patched = await api("PATCH", `/sessions/${id}`, { title: "renamed", thinkingLevel: "low" });
		expect(patched.json.title).toBe("renamed");
		expect(patched.json.thinkingLevel).toBe("low");
		expect((await api("PATCH", `/sessions/${id}`, { thinkingLevel: "off" })).status).toBe(400);
		expect((await api("GET", `/sessions/${id}`)).json.thinkingLevel).toBe("low");
		// tools are frozen once history exists
		expect((await api("PATCH", `/sessions/${id}`, { tools: ["read"] })).status).toBe(409);

		const fork = await api("POST", `/sessions/${id}/fork`, { atSeq: 0 });
		expect(fork.status).toBe(201);
		expect(fork.json.parentId).toBe(id);
		const forkMsgs = await api("GET", `/sessions/${fork.json.id}/messages`);
		expect(forkMsgs.json.messages.length).toBe(1);

		expect((await api("DELETE", `/sessions/${fork.json.id}`)).status).toBe(204);
		expect((await api("GET", `/sessions/${fork.json.id}`)).status).toBe(404);
	});

	test("closed sessions leave the active list, refuse work, and can be resumed", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto", title: "closeme", cwd: "proj/a" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "hello" });
		await untilIdle(id);
		expect((await api("GET", `/sessions/${id}`)).json.closed).toBe(false);

		const closed = await api("PATCH", `/sessions/${id}`, { closed: true });
		expect(closed.status).toBe(200);
		expect(closed.json.closed).toBe(true);

		const ids = (r: any) => r.json.sessions.map((s: any) => s.id);
		expect(ids(await api("GET", "/sessions?closed=false&limit=200"))).not.toContain(id);
		expect(ids(await api("GET", "/sessions?closed=true&limit=200"))).toContain(id);
		expect(ids(await api("GET", "/sessions?limit=200"))).toContain(id);

		expect((await api("POST", `/sessions/${id}/messages`, { text: "nope" })).status).toBe(409);
		expect((await api("POST", `/sessions/${id}/retry`)).status).toBe(409);
		// history is intact and can be forked while closed; the fork starts active
		expect((await api("GET", `/sessions/${id}/messages`)).json.messages.length).toBeGreaterThan(0);
		const fork = await api("POST", `/sessions/${id}/fork`, {});
		expect(fork.json.closed).toBe(false);
		expect(fork.json.cwd).toBe((await api("GET", `/sessions/${id}`)).json.cwd);

		const ws = (await api("GET", "/workspace")).json;
		const wd = ws.workdirs.find((w: any) => w.path === "proj/a");
		expect(wd.closed).toBe(1);
		expect(wd.active).toBe(1); // the fork

		const back = await api("PATCH", `/sessions/${id}`, { closed: false });
		expect(back.json.closed).toBe(false);
		expect((await api("POST", `/sessions/${id}/messages`, { text: "again" })).status).toBe(202);
		await untilIdle(id);
	});

	test("closing a running session aborts the run", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "!bash sleep 20" });
		for (let i = 0; i < 100 && !(await api("GET", `/sessions/${id}/status`)).json.running; i++) await Bun.sleep(20);
		expect((await api("PATCH", `/sessions/${id}`, { closed: true })).json.closed).toBe(true);
		await untilIdle(id);
	});

	test("conversation resumes from SQLite history", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "one" });
		await untilIdle(id);
		await api("POST", `/sessions/${id}/messages`, { text: "two" });
		await untilIdle(id);
		const msgs = await api("GET", `/sessions/${id}/messages`);
		expect(msgs.json.messages.map((m: any) => m.seq)).toEqual([0, 1, 2, 3]);
		const after = await api("GET", `/sessions/${id}/messages?after=1`);
		expect(after.json.messages.map((m: any) => m.seq)).toEqual([2, 3]);
	});
});

describe("tools & approvals", () => {
	test("auto approval runs a tool and records the result", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "!bash echo from-bash" });
		await untilIdle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
		const toolResult = msgs.find((m: any) => m.role === "toolResult");
		expect(toolResult.message.content[0].text).toContain("from-bash");
		expect(toolResult.message.isError).toBe(false);
	});

	test("ask mode pauses for approval, then resumes when approved", async () => {
		const id = (await api("POST", "/sessions", { approval: "ask" })).json.id as string;
		const sse = collectSse(`/sessions/${id}/events`, (ev) => ev.some((e) => e.type === "run_finished"));
		await Bun.sleep(50);
		await api("POST", `/sessions/${id}/messages`, { text: '!write {"path":"a/b.txt","content":"hi"}' });

		let pending: any[] = [];
		for (let i = 0; i < 100 && pending.length === 0; i++) {
			await Bun.sleep(25);
			pending = (await api("GET", `/approvals?sessionId=${id}`)).json.approvals;
		}
		expect(pending.length).toBe(1);
		expect(pending[0].toolName).toBe("write");
		expect((await api("GET", `/sessions/${id}/status`)).json.pendingApprovals).toBe(1);

		const decided = await api("POST", `/sessions/${id}/approvals/${pending[0].toolCallId}`, { approved: true });
		expect(decided.status).toBe(200);
		// A second decision for the same call is a 404, not a double-resolve.
		expect((await api("POST", `/sessions/${id}/approvals/${pending[0].toolCallId}`, { approved: true })).status).toBe(404);

		const events = await sse;
		const types = events.map((e) => e.type);
		expect(types).toContain("approval_requested");
		expect(types).toContain("approval_resolved");
		expect(types).toContain("tool_execution_end");
		expect(readFileSync(join(dir, "ws", "a", "b.txt"), "utf8")).toBe("hi");
	});

	test("denied tool is blocked and the file is not written", async () => {
		const id = (await api("POST", "/sessions", { approval: "ask" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: '!write {"path":"denied.txt","content":"x"}' });
		let pending: any[] = [];
		for (let i = 0; i < 100 && pending.length === 0; i++) {
			await Bun.sleep(25);
			pending = (await api("GET", `/approvals?sessionId=${id}`)).json.approvals;
		}
		await api("POST", `/sessions/${id}/approvals/${pending[0].toolCallId}`, { approved: false, reason: "nope" });
		await untilIdle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
		const result = msgs.find((m: any) => m.role === "toolResult").message;
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("nope");
		expect(await Bun.file(join(dir, "ws", "denied.txt")).exists()).toBe(false);
	});

	test("readonly blocks mutating tools but allows reads", async () => {
		const id = (await api("POST", "/sessions", { approval: "readonly" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: '!write {"path":"ro.txt","content":"x"}' });
		await untilIdle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
		expect(msgs.find((m: any) => m.role === "toolResult").message.isError).toBe(true);
		await api("POST", `/sessions/${id}/messages`, { text: "!ls {}" });
		await untilIdle(id);
		const last = (await api("GET", `/sessions/${id}/messages`)).json.messages.filter((m: any) => m.role === "toolResult").pop();
		expect(last.message.isError).toBe(false);
	});

	test("file tools cannot escape the session directory", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: '!read {"path":"../../../etc/passwd"}' });
		await untilIdle(id);
		const result = (await api("GET", `/sessions/${id}/messages`)).json.messages.find((m: any) => m.role === "toolResult").message;
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("outside");
	});

	test("abort cancels a running command", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "!bash sleep 30" });
		for (let i = 0; i < 100; i++) {
			if ((await api("GET", `/sessions/${id}/status`)).json.pendingToolCalls.length > 0) break;
			await Bun.sleep(25);
		}
		const t0 = Date.now();
		expect((await api("POST", `/sessions/${id}/abort`)).json.aborted).toBe(true);
		await untilIdle(id);
		expect(Date.now() - t0).toBeLessThan(5000);
		expect((await api("POST", `/sessions/${id}/abort`)).json.aborted).toBe(false);
	});
});

describe("events", () => {
	test("browser SSE accepts a query token without headers", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		const events = await collectSse(`/sessions/${id}/events?after=0&token=${TOKEN}`, (ev) => ev.length >= 1, {});
		expect(events[0].type).toBe("session_created");
	});

	test("history + Last-Event-ID replay with no gaps or duplicates", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "replay me" });
		await untilIdle(id);

		const hist = await api("GET", `/events/history?sessionId=${id}`);
		const ids: number[] = hist.json.events.map((e: any) => e.id);
		expect(ids.length).toBeGreaterThan(3);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(new Set(ids).size).toBe(ids.length);

		const cut = ids[2]!;
		const replayed = await collectSse(`/sessions/${id}/events`, (ev) => ev.length >= ids.length - 3, {
			...auth,
			"last-event-id": String(cut),
		});
		expect(replayed.map((e) => e.id)).toEqual(ids.slice(3));
	});

	test("type filter", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		const sse = collectSse(`/sessions/${id}/events?types=run_started,run_finished`, (ev) => ev.length >= 2);
		await Bun.sleep(50);
		await api("POST", `/sessions/${id}/messages`, { text: "filter" });
		const events = await sse;
		expect(events.map((e) => e.type)).toEqual(["run_started", "run_finished"]);
	});
});

describe("websocket", () => {
	test("subscribe, prompt and receive events over one socket", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		const ws = new WebSocket(`${base.replace("http", "ws")}/ws?token=${TOKEN}`);
		const frames: any[] = [];
		ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
		await new Promise((r) => (ws.onopen = r));

		const waitFor = async (pred: (f: any) => boolean) => {
			for (let i = 0; i < 200; i++) {
				const f = frames.find(pred);
				if (f) return f;
				await Bun.sleep(25);
			}
			throw new Error(`timeout; got ${JSON.stringify(frames.map((f) => f.type + ":" + (f.event?.type ?? "")))}`);
		};

		ws.send(JSON.stringify({ id: 1, op: "subscribe", sessionId: id }));
		expect((await waitFor((f) => f.type === "ack" && f.id === 1)).ok).toBe(true);
		ws.send(JSON.stringify({ id: 2, op: "prompt", sessionId: id, text: "over ws" }));
		expect((await waitFor((f) => f.type === "ack" && f.id === 2)).result.accepted).toBe("prompt");
		await waitFor((f) => f.type === "event" && f.event.type === "run_finished");

		ws.send(JSON.stringify({ id: 3, op: "bogus" }));
		expect((await waitFor((f) => f.id === 3)).error.code).toBe("unknown_op");
		ws.send("not json");
		await waitFor((f) => f.type === "ack" && f.ok === false && f.id === undefined);
		ws.close();
	});

	test("rejects unauthenticated sockets", async () => {
		const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
		const outcome = await new Promise<string>((resolve) => {
			ws.onopen = () => resolve("open");
			ws.onerror = () => resolve("error");
			ws.onclose = () => resolve("closed");
		});
		expect(outcome).not.toBe("open");
	});
});

describe("request size limits", () => {
	// just over the 2 MB default: the server answers 413 before the client has finished uploading
	const over = "x".repeat(2 * 1024 * 1024 + 1024);
	const large = "x".repeat(3 * 1024 * 1024);
	test("ordinary routes refuse bodies over 2 MB", async () => {
		expect((await api("POST", "/sessions", { title: over })).status).toBe(413);
		expect((await api("PUT", "/providers/openai/credential", { type: "api_key", key: over })).status).toBe(413);
	});
	test("a large synced setting (extensions) still fits its own route limit", async () => {
		const r = await api("PUT", "/client-settings/extensions", { value: { blob: over } });
		expect(r.status).not.toBe(413);
	});
	test("a message may carry images larger than 2 MB", async () => {
		const made = await api("POST", "/sessions", {});
		const sent = await api("POST", `/sessions/${made.json.id}/messages`, { text: "hi", images: [{ type: "image", data: large, mimeType: "image/png" }] });
		expect(sent.status).not.toBe(413);
	});
});

describe("files", () => {
	const raw = async (path: string) => fetch(base + path, { headers: auth });
	const b64 = (s: string) => Buffer.from(s).toString("base64");

	test("an attached file is saved in the working directory, and read back from there", async () => {
		const made = await api("POST", "/sessions", {});
		const sent = await api("POST", `/sessions/${made.json.id}/messages`, { text: "see file", files: [{ name: "../../evil dir/notes 1.txt", data: b64("hello") }] });
		expect(sent.status).toBe(202);
		await untilIdle(made.json.id);
		const { json } = await api("GET", `/sessions/${made.json.id}/messages`);
		const note = JSON.stringify(json.messages[0]);
		const path = /\.pipaya\/uploads\/[a-f0-9]{6}-notes_1\.txt/.exec(note)?.[0];
		expect(path).toBeTruthy();
		const got = await raw(`/sessions/${made.json.id}/files?path=${encodeURIComponent(path!)}`);
		expect(got.status).toBe(200);
		expect(got.headers.get("content-type")).toBe("text/plain");
		expect(got.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await got.text()).toBe("hello");
	});

	test("reading cannot leave the working directory", async () => {
		const made = await api("POST", "/sessions", {});
		for (const p of ["../../etc/passwd", "/etc/passwd"]) {
			expect((await raw(`/sessions/${made.json.id}/files?path=${encodeURIComponent(p)}`)).status).toBe(400);
		}
		expect((await raw(`/sessions/${made.json.id}/files?path=missing.txt`)).status).toBe(404);
		expect((await raw(`/sessions/nope/files?path=a.txt`)).status).toBe(404);
	});

	test("a file over the limit is refused", async () => {
		const made = await api("POST", "/sessions", {});
		const big = Buffer.alloc(21 * 1024 * 1024).toString("base64");
		expect((await api("POST", `/sessions/${made.json.id}/messages`, { text: "x", files: [{ name: "big.bin", data: big }] })).status).toBe(413);
	});
});
