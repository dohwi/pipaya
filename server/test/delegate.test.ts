import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { buildTools, modelList } from "../src/tools.ts";
import { readFileSync } from "node:fs";
import { chooseModel, DEFAULT_SUBAGENT_TURNS, DelegateLimits, freeRole, subagentUsage, listSubagents, loadSubagents, removeSubagent, saveSubagent } from "../src/subagents.ts";
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

describe("subagent editing", () => {
	const input = { description: "finds: things # now", model: "p/m", thinking: "medium" as const, tools: ["read", "delegate", "grep"], maxTurns: 99, prompt: "Be brief." };
	test("create, update (unknown keys kept), list both scopes and remove", () => {
		const root = mkdtempSync(join(tmpdir(), "pipaya-sub-"));
		try {
			const home = join(root, "home"), cwd = join(root, "proj");
			const made = saveSubagent("global", cwd, home, "explore", input, true);
			// forbidden tools and absurd turn counts are cleaned, the YAML survives a colon and a hash
			expect(made).toMatchObject({ description: "finds: things # now", model: "p/m", thinking: "medium", tools: ["read", "grep"], maxTurns: 30, prompt: "Be brief." });
			expect(() => saveSubagent("global", cwd, home, "explore", input, true)).toThrow(/already exists/);
			expect(() => saveSubagent("global", cwd, home, "nope", input, false)).toThrow(/not found/);
			expect(() => saveSubagent("global", cwd, home, "../evil", input, true)).toThrow(/role names/);
			const file = join(home, ".agents", "subagents", "explore.md");
			writeFileSync(file, readFileSync(file, "utf8").replace("---\n", "---\ncolor: blue\n"));
			saveSubagent("global", cwd, home, "explore", { ...input, model: undefined, prompt: "New." }, false);
			const text = readFileSync(file, "utf8");
			expect(text).toContain("color: blue");
			expect(text).not.toContain("model:");
			expect(text).not.toContain("thinking:"); // a strength without a model means nothing
			saveSubagent("project", cwd, home, "explore", { ...input, prompt: "Proj." }, true);
			const all = listSubagents(cwd, home);
			expect(all.map((d) => [d.scope, d.name, d.overridden])).toEqual([["global", "explore", true], ["project", "explore", false]]);
			removeSubagent("project", cwd, home, "explore");
			expect(listSubagents(cwd, home).map((d) => d.overridden)).toEqual([false]);
			expect(() => removeSubagent("project", cwd, home, "explore")).toThrow(/not found/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

describe("subagent switches", () => {
	test("a switched-off project role lets the global one of its name show again; a deleted role keeps no switch", () => {
		const root = mkdtempSync(join(tmpdir(), "pipaya-sub-"));
		try {
			const home = join(root, "home"), cwd = join(root, "proj");
			def(join(home, ".agents", "subagents"), "explore", "description: global");
			def(join(cwd, ".agents", "subagents"), "explore", "description: project");
			expect(loadSubagents(cwd, home).get("explore")?.scope).toBe("project");
			expect(loadSubagents(cwd, home, ["project/explore"]).get("explore")?.scope).toBe("global");
			expect(loadSubagents(cwd, home, ["project/explore", "global/explore"]).has("explore")).toBe(false);
			const rows = listSubagents(cwd, home, ["project/explore"]);
			expect(rows.map((r) => [r.scope, r.enabled, r.overridden])).toEqual([["global", true, false], ["project", false, false]]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

describe("DelegateLimits", () => {
	test("caps concurrent subagents and calls per run with conflict errors, and a new run starts over", () => {
		const l = new DelegateLimits({ calls: 4, running: 2 });
		const a = l.acquire("s"), b = l.acquire("s");
		expect(() => l.acquire("s")).toThrow(/at most 2 subagents/);
		a();
		a(); // releasing twice frees one slot only
		const c = l.acquire("s");
		expect(() => l.acquire("s")).toThrow(/at most 2 subagents/);
		b(); c();
		l.acquire("s")(); // fourth and last call
		expect(() => l.acquire("s")).toThrow(/at most 4 delegate calls per run/);
		expect(() => l.acquire("s")).toThrow(expect.objectContaining({ status: 409 }));
		l.resetRun("s");
		l.acquire("s")();
		l.acquire("other")(); // other sessions are independent
	});
});

describe("chooseModel", () => {
	test("defined: the role's model only; allowlist: listed models only; any: whatever is asked", () => {
		const d = { policy: "defined" as const, models: [] };
		expect(chooseModel(d, undefined, "a/b")).toBe("a/b");
		expect(() => chooseModel(d, "x/y", "a/b")).toThrow(/switched off/);
		const l = { policy: "allowlist" as const, models: ["x/y", "x/z"] };
		expect(chooseModel(l, "x/z", "a/b")).toBe("x/z");
		expect(() => chooseModel(l, "q/r", "a/b")).toThrow(/not allowed.*x\/y, x\/z/);
		expect(() => chooseModel(l, "q/r", "a/b")).toThrow(expect.objectContaining({ status: 409 }));
		expect(chooseModel({ policy: "any", models: [] }, "q/r", undefined)).toBe("q/r");
	});
});

describe("freeRole", () => {
	test("a role with no file gets read-only tools only, the default turn budget and no instructions of its own", () => {
		const r = freeRole("summarize");
		expect(r).toMatchObject({ name: "summarize", tools: ["read", "grep", "ls"], maxTurns: DEFAULT_SUBAGENT_TURNS, prompt: "", file: "" });
		expect(r.tools.some((t) => ["write", "edit", "bash", "delegate", "ask_user"].includes(t) || t.startsWith("peer"))).toBe(false);
	});
});

describe("subagentUsage", () => {
	test("sums assistant usage only", () => {
		const u = (n: number) => ({ input: n, output: n, cacheRead: 1, cacheWrite: 2, totalTokens: 2 * n + 3, cost: { total: 0.5 } });
		expect(subagentUsage([{ role: "user" }, { role: "assistant", usage: u(4) }, { role: "toolResult" }, { role: "assistant", usage: u(6) }]))
			.toEqual({ input: 10, output: 10, cacheRead: 2, cacheWrite: 4, totalTokens: 26, cost: 1 });
	});
});

describe("delegate tool", () => {
	let app: Awaited<ReturnType<typeof buildApp>>, base = "", dir = "", upstream: ReturnType<typeof startEchoUpstream>;
	const api = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: "Bearer t", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const idle = async (id: string) => {
		for (let i = 0; i < 400; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(25); }
		throw new Error(`session ${id} did not become idle`);
	};
	const call = async (id: string, args: unknown) => { await api("POST", `/sessions/${id}/messages`, { text: `!delegate ${JSON.stringify(args)}` }); await idle(id); return JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json); };

	const delegateResult = async (role: string, task: string, session?: string) => {
		const id = session ?? (await api("POST", "/sessions", { cwd: join(dir, "ws") })).json.id as string;
		await call(id, { role, task });
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		return msgs.map((m) => m.message).findLast((m) => m.role === "toolResult" && m.toolName === "delegate");
	};
	const budgetTask = (variant: string) => `budget fixture: ${variant}`;
	const textOf = (content: any) => typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : "";
	const taskOf = (body: any) => textOf(body?.messages?.find((m: any) => m.role === "user")?.content);
	const budgetRequests = (variant: string) => upstream.requests.map((r) => r.body).filter((b) => taskOf(b) === budgetTask(variant));
	let startReport: (() => void) | undefined, unblockReport: (() => void) | undefined;
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-delegate-"));
		mkdirSync(join(dir, "ws"), { recursive: true });
		def(join(dir, "home", ".agents", "subagents"), "explore", `description: finds\nmodel: echo/${ECHO_MODEL.id}\ntools: [read]\nmaxTurns: 3`);
		writeFileSync(join(dir, "ws", "budget.txt"), "verified fixture evidence");
		def(join(dir, "home", ".agents", "subagents"), "two", "tools: [read]\nmaxTurns: 2");
		def(join(dir, "home", ".agents", "subagents"), "loop", "tools: [read]\nmaxTurns: 12");
		upstream = startEchoUpstream(async (body) => {
			const task = taskOf(body);
			if (!task.startsWith("budget fixture: ")) return;
			const variant = task.slice("budget fixture: ".length);
			const results = body.messages.filter((m: any) => m.role === "tool");
			const tool = { name: "read", args: JSON.stringify({ path: variant === "failed reads" ? "missing.txt" : variant === "changing reads" ? "changing.txt" : "budget.txt" }) };
			if (variant === "changing reads") writeFileSync(join(dir, "ws", "changing.txt"), `version ${results.length}`);
			if (variant === "early failure" || (variant === "final failure" && results.length)) return Response.json({ error: { message: "mock provider rejected the request" } }, { status: 400 });
			if (body.tools?.length) return { text: variant === "empty report" || variant === "final failure" ? "The read is queued." : "", tool };
			if (variant === "empty report" || variant === "no text at all") return { text: "" };
			if (variant === "ignore removed tools") return { text: "", tool };
			if (variant === "cancel report") await new Promise<void>((resolve) => { unblockReport = resolve; startReport?.(); });
			if (variant === "one call") return { text: "No tools were available, so I could not verify the file." };
			return { text: `Report based on evidence: ${textOf(results.at(-1)?.content)}` };
		});
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

	test("is built in, switchable, and runs a subagent without creating a session", async () => {
		expect((await api("GET", "/configuration")).json.tools.toggleable).toContain("delegate");
		const id = (await api("POST", "/sessions", { tools: ["read"] })).json.id as string;
		const before = (await api("GET", "/sessions")).json;
		const out = await call(id, { role: "explore", task: "where is foo?" });
		expect(out).toContain("Echo: where is foo?");
		expect((await api("GET", "/sessions")).json.length).toBe(before.length);
	});

	test("the model policy is saved, validated, and decides whether `model` is honoured", async () => {
		const id = (await api("POST", "/sessions", {})).json.id as string;
		const m = `echo/${ECHO_MODEL.id}`;
		const put = (b: object) => api("PUT", "/configuration/delegate", { policy: "defined", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30, ...b });
		expect((await api("GET", "/configuration")).json.tools.delegate).toMatchObject({ policy: "defined", maxTurns: 30 });
		expect(await call(id, { role: "explore", task: "a", model: m })).toContain("switched off in the settings");
		expect((await put({ policy: "allowlist", models: [] })).status).toBe(400);
		expect((await put({ policy: "allowlist", models: ["echo/nope"] })).status).toBe(400);
		expect((await put({ maxTurns: 0 })).status).toBe(400);
		expect((await put({ policy: "allowlist", models: [m] })).json.delegate.models).toEqual([m]);
		expect(await call(id, { role: "explore", task: "b", model: m })).toContain("Echo: b");
		expect(await call(id, { role: "explore", task: "c", model: "echo/other" })).toContain("not allowed for subagents");
		expect((await put({ policy: "any", maxCalls: 1 })).json.delegate.policy).toBe("any");
		expect(await call(id, { role: "explore", task: "d", model: m })).toContain("Echo: d");
		expect(await call(id, { role: "explore", task: "e" })).toContain("Echo: e"); // a new message is a new run: the allowance is full again
		await put({});
	});

	test("an explicit model overrides the role's model; a bad one is an error", async () => {
		await api("PUT", "/configuration/delegate", { policy: "any", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 });
		const id = (await api("POST", "/sessions", {})).json.id as string;
		expect(await call(id, { role: "explore", task: "hi", model: `echo/${ECHO_MODEL.id}` })).toContain("Echo: hi");
		expect(await call(id, { role: "explore", task: "hi", model: "echo/nope" })).toContain("echo/nope is not available");
	});

	test("a subagent thinks at its role's level, else the session's on the same model, else the chosen model's default", async () => {
		const think = { ...ECHO_MODEL, id: "think-model", reasoning: true };
		await api("PUT", "/configuration/providers/think", { ...echoProviderBody(upstream.baseUrl, "Think"), models: [{ ...think, defaultThinkingLevel: "high" }, { ...think, id: "plain-think" }] });
		await api("PUT", "/configuration/delegate", { roles: "any", policy: "any", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 });
		def(join(dir, "home", ".agents", "subagents"), "pinned", "thinking: minimal\ntools: [read]\nmaxTurns: 2");
		const level = async (id: string, args: object) => {
			await call(id, args);
			const msgs = ((await api("GET", `/sessions/${id}/messages`)).json.messages as any[]).map((m) => m.message);
			return msgs.filter((m) => m.role === "toolResult" && m.toolName === "delegate").at(-1)?.details.thinking;
		};
		const id = (await api("POST", "/sessions", { provider: "think", model: "think-model", thinkingLevel: "low" })).json.id as string;
		expect(await level(id, { role: "anysubagent", task: "a" })).toBe("low"); // same model: the session's own level
		expect(await level(id, { role: "anysubagent", task: "b", model: "think/plain-think" })).toBe("medium"); // "auto": a new chat's rule
		const other = (await api("POST", "/sessions", {})).json.id as string;
		expect(await level(other, { role: "anysubagent", task: "c", model: "think/think-model" })).toBe("high"); // the model's own default
		expect(await level(other, { role: "pinned", task: "d", model: "think/think-model" })).toBe("minimal"); // the role wins
		await api("PUT", "/configuration/delegate", { roles: "defined", policy: "defined", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 });
		await api("DELETE", "/configuration/providers/think");
	});

	test("a subagent can use its tools; one outside its tool list cannot", async () => {
		writeFileSync(join(dir, "ws", "note.txt"), "secret-marker-42");
		const id = (await api("POST", "/sessions", { cwd: join(dir, "ws") })).json.id as string;
		expect(await call(id, { role: "explore", task: `!read ${JSON.stringify({ path: "note.txt" })}` })).toContain("secret-marker-42");
		const denied = await call(id, { role: "explore", task: `!bash ${JSON.stringify({ command: "echo hi" })}` });
		expect(denied).not.toContain("\\nhi");
	});

	test("the policy cap includes a final tool-free request with the earlier tool result", async () => {
		const put = (maxTurns: number) => api("PUT", "/configuration/delegate", { policy: "defined", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns });
		await put(2);
		try {
			const result = await delegateResult("explore", budgetTask("normal report"));
			const reqs = budgetRequests("normal report");
			expect(reqs).toHaveLength(2);
			expect(reqs[0].tools.map((t: any) => t.function.name)).toEqual(["read"]);
			expect(reqs[1].tools ?? []).toEqual([]);
			expect(reqs[1].messages.some((m: any) => m.role === "system" && textOf(m.content).includes("final model call"))).toBe(true);
			expect(result.content[0].text).toContain("Report based on evidence: verified fixture evidence");
			expect(result.content[0].text).toContain("may be incomplete");
			expect(result.details).toMatchObject({ turns: 2, limited: true, limit: "maxTurns", usage: { input: 8 } });
		} finally { await put(30); }
	});

	test("a one-call role gets a useful answer without spending an extra call or executing tools", async () => {
		def(join(dir, "home", ".agents", "subagents"), "one", "tools: [read]\nmaxTurns: 1");
		const result = await delegateResult("one", budgetTask("one call"));
		const reqs = budgetRequests("one call");
		expect(reqs).toHaveLength(1);
		expect(reqs[0].tools ?? []).toEqual([]);
		expect(result.content[0].text).toContain("so I could not verify the file");
		expect(result.details).toMatchObject({ turns: 1, limited: false });
	});

	test("ordinary early answers are returned without a limit warning or extra call", async () => {
		const result = await delegateResult("explore", "finished early");
		expect(result.content[0].text).toBe("Echo: finished early");
		expect(result.details).toMatchObject({ turns: 1, limited: false });
	});

	test("empty or rejected wrap-up preserves earlier text, but an ordinary upstream failure is still an error", async () => {
		for (const [variant, reason] of [["empty report", "returned no text"], ["final failure", "failed"]] as const) {
			const result = await delegateResult("two", budgetTask(variant));
			expect(result.content[0].text).toContain(`The final model call ${reason}.`);
			expect(result.content[0].text).toContain("Partial assistant text (not a final answer):\nThe read is queued.");
			expect(result.content[0].text).not.toContain("verified fixture evidence");
			expect(result.details).toMatchObject({ turns: 2, limited: true, limit: "maxTurns" });
		}
		const empty = await delegateResult("two", budgetTask("no text at all"));
		expect(empty.content[0].text).toContain("The final model call returned no text.");
		expect(empty.content[0].text).not.toContain("Partial assistant text");
		const error = await delegateResult("two", budgetTask("early failure"));
		expect(error.isError).toBe(true);
		expect(error.content[0].text).toContain("mock provider rejected the request");
	});

	test("a tool call hallucinated during wrap-up cannot run or trigger another model call", async () => {
		const result = await delegateResult("two", budgetTask("ignore removed tools"));
		expect(budgetRequests("ignore removed tools")).toHaveLength(2);
		expect(result.content[0].text).toContain("requested unavailable tools");
		expect(result.details).toMatchObject({ turns: 2, limited: true, limit: "maxTurns" });
	});

	test("repeated identical built-in reads with unchanged output switch to reporting early", async () => {
		const result = await delegateResult("loop", budgetTask("loop"));
		const reqs = budgetRequests("loop");
		expect(reqs).toHaveLength(7);
		expect(reqs.slice(0, -1).every((r) => r.tools?.length === 1)).toBe(true);
		expect(reqs.at(-1).tools ?? []).toEqual([]);
		expect(result.content[0].text).toContain("unchanged results 6 times in a row");
		expect(result.details).toMatchObject({ turns: 7, limited: true, limit: "repeatedTools" });
	});

	test("changing or failed reads do not count as unchanged successful results", async () => {
		for (const variant of ["changing reads", "failed reads"]) {
			const result = await delegateResult("loop", budgetTask(variant));
			expect(budgetRequests(variant)).toHaveLength(12);
			expect(result.details).toMatchObject({ turns: 12, limited: true, limit: "maxTurns" });
		}
	});

	test("parent cancellation also interrupts the report", async () => {
		const id = (await api("POST", "/sessions", { cwd: join(dir, "ws") })).json.id as string;
		const task = budgetTask("cancel report");
		const reporting = new Promise<void>((resolve) => { startReport = resolve; });
		try {
			await api("POST", `/sessions/${id}/messages`, { text: `!delegate ${JSON.stringify({ role: "two", task })}` });
			await Promise.race([reporting, Bun.sleep(3000).then(() => { throw new Error("report did not start"); })]);
			await api("POST", `/sessions/${id}/abort`);
			await idle(id);
			const out = JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json);
			expect(out).not.toContain("Report based on evidence");
			expect(budgetRequests("cancel report")).toHaveLength(2);
		} finally { unblockReport?.(); startReport = unblockReport = undefined; }
	});

	test("aborting the parent stops the subagent and what it started", async () => {
		def(join(dir, "home", ".agents", "subagents"), "shell", `model: echo/${ECHO_MODEL.id}\ntools: [bash]\nmaxTurns: 3`);
		const id = (await api("POST", "/sessions", { cwd: join(dir, "ws") })).json.id as string;
		const started = Date.now();
		await api("POST", `/sessions/${id}/messages`, { text: `!delegate ${JSON.stringify({ role: "shell", task: `!bash ${JSON.stringify({ command: "sleep 987" })}` })}` });
		const alive = () => Bun.spawnSync(["pgrep", "-x", "-f", "sleep 987"]).stdout.toString().trim() !== "";
		for (let i = 0; i < 100 && !alive(); i++) await Bun.sleep(50);
		expect(alive()).toBe(true);
		await api("POST", `/sessions/${id}/abort`);
		await idle(id);
		expect(Date.now() - started).toBeLessThan(20_000);
		for (let i = 0; i < 60 && alive(); i++) await Bun.sleep(100);
		expect(alive()).toBe(false);
	}, 30_000);

	test("roles are listed, created, edited and removed over the API, and a new one is used at once", async () => {
		expect((await fetch(`${base}/configuration/subagents`)).status).toBe(401);
		const list = await api("GET", "/configuration/subagents");
		expect(list.json.subagents.map((r: any) => r.name)).toContain("explore");
		expect(list.json.tools).not.toContain("delegate");
		const body = { scope: "global", description: "d", tools: ["read"], maxTurns: 3, prompt: "p" };
		expect((await api("POST", "/configuration/subagents", { name: "fresh", ...body })).status).toBe(200);
		expect((await api("POST", "/configuration/subagents", { name: "fresh", ...body })).status).toBe(409);
		expect((await api("POST", "/configuration/subagents", { name: "bad name", ...body })).status).toBe(400);
		const put = await api("PUT", "/configuration/subagents/fresh", { ...body, description: "changed" });
		expect(put.json.subagents.find((r: any) => r.name === "fresh").description).toBe("changed");
		expect((await api("PUT", "/configuration/subagents/ghost", body)).status).toBe(404);
		expect((await api("DELETE", "/configuration/subagents/fresh?scope=global")).json.subagents.map((r: any) => r.name)).not.toContain("fresh");
		expect((await api("DELETE", "/configuration/subagents/fresh?scope=global")).status).toBe(404);
		// the project scope follows the `cwd` of the asking conversation, not only the default folder
		const proj = join(dir, "ws");
		const made = await api("POST", `/configuration/subagents?cwd=${encodeURIComponent(proj)}`, { name: "local", ...body, scope: "project" });
		expect(made.json.projectDir).toBe(join(proj, ".agents", "subagents"));
		expect(made.json.subagents.find((r: any) => r.name === "local").scope).toBe("project");
		expect((await api("GET", "/configuration/subagents")).json.subagents.map((r: any) => r.name)).toContain("local"); // ws is also the default folder here
		expect((await api("GET", `/configuration/subagents?cwd=${encodeURIComponent(join(dir, "elsewhere"))}`)).json.subagents.map((r: any) => r.name)).not.toContain("local");
		expect((await api("DELETE", `/configuration/subagents/local?scope=project&cwd=${encodeURIComponent(proj)}`)).status).toBe(200);
	});
	test("a role switched off is refused by delegate and comes back when switched on", async () => {
		const id = (await api("POST", "/sessions", {})).json.id as string;
		const off = await api("PUT", "/configuration/subagents/explore/enabled", { scope: "global", enabled: false });
		expect(off.json.subagents.find((r: any) => r.name === "explore")).toMatchObject({ enabled: false });
		expect(await call(id, { role: "explore", task: "x" })).toContain("subagent role");
		expect((await api("PUT", "/configuration/subagents/ghost/enabled", { scope: "global", enabled: false })).status).toBe(404);
		const on = await api("PUT", "/configuration/subagents/explore/enabled", { scope: "global", enabled: true });
		expect(on.json.subagents.find((r: any) => r.name === "explore").enabled).toBe(true);
		expect(await call(id, { role: "explore", task: "x" })).toContain("Echo: x"); // the history keeps the earlier refusal; the new answer is the subagent's
	});
	test("an unknown role lists the available ones", async () => {
		const id = (await api("POST", "/sessions", {})).json.id as string;
		const out = await call(id, { role: "ghost", task: "x" });
		expect(out).toContain('subagent role');
		expect(out).toContain("available: explore");
	});

	test("the role policy: defined refuses a role with no file; any runs a read-only general subagent that takes the task as its instructions", async () => {
		const id = (await api("POST", "/sessions", { cwd: join(dir, "ws") })).json.id as string;
		const put = (b: object) => api("PUT", "/configuration/delegate", { policy: "defined", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30, ...b });
		expect((await api("GET", "/configuration")).json.tools.delegate).toMatchObject({ roles: "defined" });
		expect(await call(id, { role: "summarize", task: "x" })).toContain("subagent role");
		expect((await put({ roles: "any" })).json.delegate.roles).toBe("any");
		expect(await call(id, { role: "summarize", task: `!read ${JSON.stringify({ path: "note.txt" })}` })).toContain("secret-marker-42");
		// No write or shell for a free role: the denial comes back as a tool error, not a result.
		expect(await call(id, { role: "summarize", task: `!bash ${JSON.stringify({ command: "echo hi" })}` })).not.toContain("\\nhi");
		expect(await call(id, { role: "bad name!", task: "x" })).toContain("role names are letters");
		// A role file that exists but is switched off stays refused even under the free policy.
		await api("PUT", "/configuration/subagents/explore/enabled", { scope: "global", enabled: false });
		expect(await call(id, { role: "explore", task: "x" })).toContain("switched off in the settings");
		await api("PUT", "/configuration/subagents/explore/enabled", { scope: "global", enabled: true });
		// An update without `roles` (an older client) keeps the saved policy.
		expect((await api("PUT", "/configuration/delegate", { policy: "any", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 })).json.delegate.roles).toBe("any");
		expect((await put({ roles: "defined" })).json.delegate.roles).toBe("defined");
		expect(await call(id, { role: "summarize", task: "x" })).toContain("subagent role");
	});

	test("GET /delegates lists the calls of active sessions with the model each ran on, a free role, and leaves closed sessions out", async () => {
		await api("PUT", "/configuration/delegate", { roles: "any", policy: "defined", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 });
		const id = (await api("POST", "/sessions", {})).json.id as string;
		await call(id, { role: "explore.md", task: "first" });
		await call(id, { role: "adhoc", task: "second", model: "echo/ignored" }); // policy "defined": the asked model is not used
		await call(id, { task: "no role" }); // refused before it ran: not listed
		const runs = ((await api("GET", "/delegates")).json.runs as any[]).filter((r) => r.sessionId === id);
		expect(runs.map((r) => r.role)).toEqual(["explore", "adhoc"]);
		expect(runs[0]).toMatchObject({ free: false, model: `echo/${ECHO_MODEL.id}`, running: false, error: false, asked: null });
		expect(runs[0].doneAt).toBeGreaterThanOrEqual(runs[0].at);
		expect(runs[0].tokens).toBeGreaterThan(0);
		expect(runs[1]).toMatchObject({ free: true, asked: "echo/ignored", model: `echo/${ECHO_MODEL.id}` });
		await api("PATCH", `/sessions/${id}`, { closed: true });
		expect(((await api("GET", "/delegates")).json.runs as any[]).some((r) => r.sessionId === id)).toBe(false);
		await api("PUT", "/configuration/delegate", { roles: "defined", policy: "defined", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 });
	});

	test("the delegate tool text follows the role policy", () => {
		const make = (roles: "defined" | "any") => buildTools(["delegate"], dir, [], { delegateRoles: () => roles })[0]!;
		expect(make("any").description).toContain("any other short name");
		expect((make("any").parameters as any).properties.role.description).toContain("any short name");
		expect(make("defined").description).not.toContain("any other short name");
		expect((make("defined").parameters as any).properties.role.description).not.toContain("any short name");
	});

	test("the delegate tool text lists the models a call may name, and offers no `model` when the role decides", () => {
		const make = (policy: "defined" | "allowlist" | "any", models: string[] = []) => buildTools(["delegate"], dir, [], { delegateModels: () => ({ policy, models }) })[0]!;
		const props = (t: ReturnType<typeof make>) => (t.parameters as any).properties;
		const listed = make("allowlist", ["a/fast", "b/strong"]);
		expect(props(listed).model.description).toContain("one of: a/fast, b/strong");
		expect(listed.description).not.toContain("a/fast"); // the ids once, in the parameter
		expect(listed.description).toContain("fast, cheap model");
		expect(props(make("any")).model.description).toContain("any configured model");
		expect(props(make("defined")).model).toBeUndefined();
		expect(make("defined").description).not.toContain("`model`");
	});

	test("peer and delegate list the models a session can run on, grouped by provider", async () => {
		const peer = buildTools(["peer"], dir, [], { chatModels: () => ["a/fast", "a/strong", "b/other"] })[0]!;
		expect((peer.parameters as any).properties.model.description).toContain("a: fast, strong; b: other");
		expect((buildTools(["peer"], dir, [], {})[0]!.parameters as any).properties.model.description).not.toContain("Available");
		const free = buildTools(["delegate"], dir, [], { delegateModels: () => ({ policy: "any", models: [] }), chatModels: () => ["a/fast"] })[0]!;
		expect((free.parameters as any).properties.model.description).toContain("a: fast");
		expect(modelList(Array.from({ length: 45 }, (_, i) => `p/m${i}`))).toEndWith("(and 5 more)");
	});

	test("a running session's tool text names the configured chat models", async () => {
		const id = (await api("POST", "/sessions", {})).json.id as string;
		const n = upstream.requests.length;
		await api("POST", `/sessions/${id}/messages`, { text: "hello" });
		await idle(id);
		const req = upstream.requests.slice(n).find((r: any) => r.body?.tools);
		const peer = (req!.body as any).tools.find((t: any) => t.function?.name === "peer");
		expect(peer.function.parameters.properties.model.description).toContain(`echo: ${ECHO_MODEL.id}`);
	});

	test("a session's model may be given as provider/model in `model` alone", async () => {
		const made = (await api("POST", "/sessions", { model: `echo/${ECHO_MODEL.id}` })).json;
		expect([made.provider, made.model]).toEqual(["echo", ECHO_MODEL.id]);
		const set = (await api("PATCH", `/sessions/${made.id}`, { model: `echo/${ECHO_MODEL.id}` })).json;
		expect([set.provider, set.model]).toEqual(["echo", ECHO_MODEL.id]);
		expect((await api("POST", "/sessions", { model: "echo/nope" })).status).toBe(400);
	});

	test("switched off, the subagent tool is withheld from sessions", async () => {
		expect((await api("PUT", "/configuration/tools", { disabled: ["delegate"] })).json.disabled).toEqual(["delegate"]);
		const id = (await api("POST", "/sessions", {})).json.id as string;
		const specs = (await api("GET", `/sessions/${id}/context`)).json.toolSpecs as { name: string; enabled: boolean }[];
		expect(specs.find((t) => t.name === "delegate")!.enabled).toBe(false);
		await api("PUT", "/configuration/tools", { disabled: [] });
		const again = (await api("GET", `/sessions/${id}/context`)).json.toolSpecs as { name: string; enabled: boolean }[];
		expect(again.find((t) => t.name === "delegate")!.enabled).toBe(true);
	});
});

describe("delegate usage in the session totals", () => {
	test("the subagent's tokens are added to the calling session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-delegate-usage-"));
		def(join(dir, "home", ".agents", "subagents"), "explore", `model: echo/${ECHO_MODEL.id}\ntools: [read]`);
		const upstream = startEchoUpstream();
		const app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "t.db"), token: "t", workspaceRoot: join(dir, "ws"), logLevel: "silent" }, { strictResponses: true, extensionDirs: [], home: join(dir, "home") });
		try {
			await app.server.listen({ host: "0.0.0.0", port: 0 });
			const base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
			const api = async (method: string, path: string, body?: unknown) => {
				const res = await fetch(base + path, { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
				return { json: (await res.json()) as any };
			};
			await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
			await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
			const id = (await api("POST", "/sessions", {})).json.id as string;
			await api("POST", `/sessions/${id}/messages`, { text: `!delegate ${JSON.stringify({ role: "explore", task: "count me" })}` });
			for (let i = 0; i < 200 && (await api("GET", `/sessions/${id}/status`)).json.running; i++) await Bun.sleep(25);
			const msgs = ((await api("GET", `/sessions/${id}/messages`)).json.messages as any[]).map((m) => m.message);
			const result = msgs.find((m) => m.role === "toolResult" && m.toolName === "delegate");
			expect(result.details.usage.totalTokens).toBeGreaterThan(0);
			const mainOnly = msgs.filter((m) => m.role === "assistant").reduce((a, m) => a + (m.usage?.totalTokens ?? 0), 0);
			expect((await api("GET", `/sessions/${id}`)).json.usage.totalTokens).toBe(mainOnly + result.details.usage.totalTokens);
		} finally {
			await app.close();
			upstream.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
