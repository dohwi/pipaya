import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { DelegateLimits, loadSubagents } from "../src/subagents.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

const def = (dir: string, name: string, front: string, body = "Be brief.") => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), `---\n${front}\n---\n${body}\n`);
};

describe("loadSubagents", () => {
	test("reads global and project definitions, the project one wins, and respects the frontmatter", () => {
		const root = mkdtempSync(join(tmpdir(), "pipaya-sub-"));
		try {
			const home = join(root, "home"), cwd = join(root, "proj");
			def(join(home, ".agents", "subagents"), "explore", "description: finds things\nmodel: p/m\nthinking: medium\ntools: [read, grep, delegate, peer_send, ask_user]\nmaxTurns: 7");
			def(join(home, ".agents", "subagents"), "runner", "description: runs");
			def(join(cwd, ".agents", "subagents"), "explore", "description: project explore\nmaxTurns: 999");
			const defs = loadSubagents(cwd, home);
			expect([...defs.keys()].sort()).toEqual(["explore", "runner"]);
			const e = defs.get("explore")!;
			expect(e).toMatchObject({ scope: "project", description: "project explore", prompt: "Be brief.", maxTurns: 30 });
			expect(e.model).toBeUndefined();
			const g = loadSubagents(join(root, "none"), home).get("explore")!;
			expect(g).toMatchObject({ scope: "global", model: "p/m", thinking: "medium", maxTurns: 7, tools: ["read", "grep"] }); // delegate, peer_* and ask_user are never handed down
			expect(defs.get("runner")!.tools).toEqual(["read", "grep", "ls"]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	test("missing directories give an empty set", () => {
		expect(loadSubagents("/nonexistent-x", "/nonexistent-y").size).toBe(0);
	});
});

describe("DelegateLimits", () => {
	test("caps concurrent helpers and calls per run with conflict errors, and a new run starts over", () => {
		const l = new DelegateLimits({ calls: 4, running: 2 });
		const a = l.acquire("s"), b = l.acquire("s");
		expect(() => l.acquire("s")).toThrow(/at most 2 helpers/);
		a();
		a(); // releasing twice frees one slot only
		const c = l.acquire("s");
		expect(() => l.acquire("s")).toThrow(/at most 2 helpers/);
		b(); c();
		l.acquire("s")(); // fourth and last call
		expect(() => l.acquire("s")).toThrow(/at most 4 delegate calls per run/);
		expect(() => l.acquire("s")).toThrow(expect.objectContaining({ status: 409 }));
		l.resetRun("s");
		l.acquire("s")();
		l.acquire("other")(); // other sessions are independent
	});
});

describe("delegate tool", () => {
	let app: Awaited<ReturnType<typeof buildApp>>, base = "", dir = "", upstream: ReturnType<typeof startEchoUpstream>;
	const api = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: "Bearer t", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const idle = async (id: string) => { for (let i = 0; i < 400; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(25); } };
	const call = async (id: string, args: unknown) => { await api("POST", `/sessions/${id}/messages`, { text: `!delegate ${JSON.stringify(args)}` }); await idle(id); return JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json); };

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-delegate-"));
		def(join(dir, "home", ".agents", "subagents"), "explore", `description: finds\nmodel: echo/${ECHO_MODEL.id}\ntools: [read]\nmaxTurns: 3`);
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

	test("is built in, switchable, and runs a helper without creating a session", async () => {
		expect((await api("GET", "/configuration")).json.tools.toggleable).toContain("delegate");
		const id = (await api("POST", "/sessions", { tools: ["read"] })).json.id as string;
		const before = (await api("GET", "/sessions")).json;
		const out = await call(id, { role: "explore", task: "where is foo?" });
		expect(out).toContain("Echo: where is foo?");
		expect((await api("GET", "/sessions")).json.length).toBe(before.length);
	});

	test("an explicit model overrides the role's model; a bad one is an error", async () => {
		const id = (await api("POST", "/sessions", {})).json.id as string;
		expect(await call(id, { role: "explore", task: "hi", model: `echo/${ECHO_MODEL.id}` })).toContain("Echo: hi");
		expect(await call(id, { role: "explore", task: "hi", model: "echo/nope" })).toContain("echo/nope is not available");
	});

	test("an unknown role lists the available ones", async () => {
		const id = (await api("POST", "/sessions", {})).json.id as string;
		const out = await call(id, { role: "ghost", task: "x" });
		expect(out).toContain('helper role');
		expect(out).toContain("available: explore");
	});

	test("switched off, the helper tool is withheld from sessions", async () => {
		expect((await api("PUT", "/configuration/tools", { disabled: ["delegate"] })).json.disabled).toEqual(["delegate"]);
		const id = (await api("POST", "/sessions", {})).json.id as string;
		const specs = (await api("GET", `/sessions/${id}/context`)).json.toolSpecs as { name: string; enabled: boolean }[];
		expect(specs.find((t) => t.name === "delegate")!.enabled).toBe(false);
		await api("PUT", "/configuration/tools", { disabled: [] });
		const again = (await api("GET", `/sessions/${id}/context`)).json.toolSpecs as { name: string; enabled: boolean }[];
		expect(again.find((t) => t.name === "delegate")!.enabled).toBe(true);
	});
});
