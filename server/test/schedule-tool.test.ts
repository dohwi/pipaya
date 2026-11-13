import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { localTime } from "../src/schedule-tool.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

describe("localTime", () => {
	test("writes the server's local time with its offset", () => {
		const ms = Date.parse("2026-11-15T09:05:00");
		expect(localTime(ms)).toMatch(/^2026-11-15 09:05 \(UTC[+-]\d{2}:\d{2}\)$/);
	});
});

describe("schedule tool", () => {
	let app: Awaited<ReturnType<typeof buildApp>>, base = "", dir = "", upstream: ReturnType<typeof startEchoUpstream>;
	const api = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: "Bearer t", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const idle = async (id: string) => { for (let i = 0; i < 400; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(25); } };
	/** Makes the agent of `id` call schedule with `args` and returns what the tool answered. */
	const call = async (id: string, args: unknown) => {
		await api("POST", `/sessions/${id}/messages`, { text: `!schedule ${JSON.stringify(args)}` });
		await idle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as { message: { role: string; content: { type: string; text?: string }[]; isError?: boolean } }[];
		const last = msgs.filter((m) => m.message.role === "toolResult").at(-1)!.message;
		return { text: last.content.map((c) => c.text ?? "").join(""), error: !!last.isError };
	};
	const tasks = async (sessionId?: string) => (await api("GET", `/schedules${sessionId ? `?sessionId=${sessionId}` : ""}`)).json.schedules as Record<string, any>[];
	const mk = async () => (await api("POST", "/sessions", {})).json.id as string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-schedule-tool-"));
		mkdirSync(join(dir, "ws"), { recursive: true });
		upstream = startEchoUpstream();
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "t.db"), token: "t", workspaceRoot: join(dir, "ws"), logLevel: "silent" }, { strictResponses: true, extensionDirs: [], home: join(dir, "home") });
		await app.server.listen({ host: "0.0.0.0", port: 0 });
		base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	});
	afterAll(async () => {
		await app?.close();
		upstream?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("creates one-time and repeating tasks for its own session and lists them", async () => {
		const id = await mk();
		const before = Date.now();
		const once = await call(id, { action: "create", prompt: "check the build", inMinutes: 30, title: "Build" });
		expect(once.error).toBe(false);
		expect(once.text).toContain("once at");
		expect(once.text).toContain("to this session");
		const every = await call(id, { action: "create", prompt: "status?", everyMinutes: 60 });
		expect(every.text).toContain("every 1 h");
		const mine = await tasks(id);
		expect(mine.map((t) => [t.kind, t.title, t.prompt])).toEqual([["once", "Build", "check the build"], ["interval", null, "status?"]]);
		expect(mine[0]!.runAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
		expect(mine[0]!.runAt).toBeLessThan(Date.now() + 30 * 60_000 + 1000);
		const listed = await call(id, { action: "list" });
		expect(listed.text).toContain("Server time now:");
		expect(listed.text).toContain("2 task(s)");
		expect(listed.text).toContain(mine[0]!.id);
	});

	test("`at` is read as local time, an offset is honoured, a date alone or nonsense is refused", async () => {
		const id = await mk();
		const year = new Date().getFullYear() + 1;
		await call(id, { action: "create", prompt: "a", at: `${year}-03-01T09:30` });
		await call(id, { action: "create", prompt: "b", at: `${year}-03-01T09:30+09:00` });
		const [a, b] = await tasks(id);
		expect(a!.runAt).toBe(new Date(year, 2, 1, 9, 30).getTime());
		expect(b!.runAt).toBe(Date.parse(`${year}-03-01T00:30:00Z`));
		expect((await call(id, { action: "create", prompt: "c", at: `${year}-03-01` })).text).toContain("cannot read the time");
		expect((await call(id, { action: "create", prompt: "c", at: "tomorrow" })).text).toContain("cannot read the time");
		expect((await call(id, { action: "create", prompt: "c", at: "2000-01-01T00:00" })).text).toContain("runAt must be in the future");
		expect(await tasks(id)).toHaveLength(2);
	});

	test("refuses a task that is both or neither one-time and repeating, and an interval below the minimum", async () => {
		const id = await mk();
		expect((await call(id, { action: "create", prompt: "x", inMinutes: 10, everyMinutes: 60 })).text).toContain("not both");
		expect((await call(id, { action: "create", prompt: "x", at: "2099-01-01T00:00", inMinutes: 10 })).text).toContain("either `at` or `inMinutes`");
		expect((await call(id, { action: "create", prompt: "x" })).text).toContain("needs `at`, `inMinutes` or `everyMinutes`");
		expect((await call(id, { action: "create", inMinutes: 10 })).text).toContain("needs `prompt`");
		expect((await call(id, { action: "create", prompt: "x", everyMinutes: 1 })).error).toBe(true);
		expect(await tasks(id)).toHaveLength(0);
	});

	test("sends to another session by @name; an unknown name lists the sessions", async () => {
		const self = await mk();
		const other = await mk();
		const name = (await api("GET", `/sessions/${other}`)).json.name as string;
		const made = await call(self, { action: "create", prompt: "ping", everyMinutes: 10, session: `@${name}` });
		expect(made.text).toContain(`to @${name}`);
		expect((await tasks(other)).map((t) => t.prompt)).toEqual(["ping"]);
		expect(await tasks(self)).toHaveLength(0);
		// its own list leaves the other session's task out; all shows it
		expect((await call(self, { action: "list" })).text).toContain("No scheduled tasks for this session");
		expect((await call(self, { action: "list", all: true })).text).toContain(`to @${name}`);
		const bad = await call(self, { action: "create", prompt: "ping", everyMinutes: 10, session: "nobody-here" });
		expect(bad.error).toBe(true);
		expect(bad.text).toContain(`@${name}`);
	});

	test("updates, pauses, deletes; run is refused while the session itself is running", async () => {
		const id = await mk();
		await call(id, { action: "create", prompt: "status?", everyMinutes: 10 });
		const t = (await tasks(id))[0]!;
		expect((await call(id, { action: "update", id: t.id })).text).toContain("needs something to change");
		expect((await call(id, { action: "update", id: t.id, everyMinutes: 120, title: "Two-hourly" })).text).toContain("every 2 h");
		expect((await call(id, { action: "update", id: t.id, inMinutes: 5 })).text).toContain("runAt belongs to a one-time task");
		const paused = await call(id, { action: "update", id: t.id, enabled: false });
		expect(paused.text).toContain(" · off");
		expect((await tasks(id))[0]).toMatchObject({ enabled: false, nextRunAt: null, everyMs: 120 * 60_000, title: "Two-hourly" });
		expect((await call(id, { action: "run", id: t.id })).text).toContain("session is busy");
		expect((await call(id, { action: "delete", id: t.id })).text).toContain("Deleted:");
		expect(await tasks(id)).toHaveLength(0);
		expect((await call(id, { action: "delete", id: t.id })).text).toContain("schedule not found");
		expect((await call(id, { action: "delete" })).text).toContain("needs `id`");
	});

	test("run sends another session's task now", async () => {
		const self = await mk();
		const other = await mk();
		const name = (await api("GET", `/sessions/${other}`)).json.name as string;
		await call(self, { action: "create", prompt: "hello there", everyMinutes: 10, session: name });
		const t = (await tasks(other))[0]!;
		expect((await call(self, { action: "run", id: t.id })).text).toContain("Sent now:");
		await idle(other);
		expect(JSON.stringify((await api("GET", `/sessions/${other}/messages`)).json)).toContain("Echo: hello there");
	});

	test("is switchable: switched off, the agent does not get it", async () => {
		expect((await api("GET", "/configuration")).json.tools.toggleable).toContain("schedule");
		await api("PUT", "/configuration/tools", { disabled: ["schedule"] });
		try {
			const id = await mk();
			const out = await call(id, { action: "list" });
			expect(out.error).toBe(true);
			expect(out.text).not.toContain("Server time now");
		} finally {
			await api("PUT", "/configuration/tools", { disabled: [] });
		}
	});
});
