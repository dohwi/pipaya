import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { finishReport, MAX_REPORT_CHARS, MAX_TURNS, SUBAGENT_TOOLS } from "../src/subagent.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let dir: string;
let ws: string;
let upstream: EchoUpstream;
let EXPLORE = "";
const api = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({
		method,
		url,
		headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-subagent-"));
	EXPLORE = join(dir, ".agents", "subagents", "explore.md");
	ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	writeFileSync(join(ws, "notes.txt"), "the answer is 42\n");
	writeFileSync(join(dir, "outside.txt"), "TOP SECRET");
	symlinkSync(join(dir, "outside.txt"), join(ws, "link.txt"));
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, defaultApproval: "auto", approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, home: dir });
	expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
	// Helpers are files; these tests need the usual read-only "explore".
	mkdirSync(join(dir, ".agents", "subagents"), { recursive: true });
	writeFileSync(EXPLORE, "---\ndescription: Searches and reads the codebase and reports back with path:line citations\n---\n");
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

async function untilIdle(id: string) {
	for (let i = 0; i < 300; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(20);
	}
	throw new Error("session never became idle");
}
const newSession = async (extra: object = {}) => (await api("POST", "/sessions", { cwd: ws, approval: "auto", ...extra })).json.id as string;
const delegate = async (id: string, task: string) => {
	upstream.requests.length = 0;
	await api("POST", `/sessions/${id}/messages`, { text: `!delegate ${JSON.stringify({ task })}` });
	await untilIdle(id);
	const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
	return msgs.map((m) => m.message).filter((m) => m.role === "toolResult" && m.toolName === "delegate").at(-1);
};

describe("delegate (read-only sub-agent)", () => {
	test("is a non-mutating tool, offered to new sessions, and the helper can only read", async () => {
		const tools = (await api("GET", "/tools")).json.tools as { name: string; mutating: boolean }[];
		expect(tools.find((t) => t.name === "delegate")).toMatchObject({ mutating: false });
		expect([...SUBAGENT_TOOLS]).toEqual(["read", "grep", "ls"]);
	});

	test("returns only the report; the file the helper read never reaches the main conversation", async () => {
		const id = await newSession();
		const result = await delegate(id, `!read ${JSON.stringify({ path: "notes.txt" })}`);
		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ subagent: true, provider: "echo", model: ECHO_MODEL.id });
		expect(result.details.turns).toBeGreaterThanOrEqual(2);
		// The helper's last words are the report; "the answer is 42" was only ever in the helper's own transcript.
		expect(result.content[0].text).toContain("Tool read finished");
		const main = JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json.messages);
		expect(main).not.toContain('"toolName":"read"');
	});

	test("the helper gets only read, grep and ls; edits are not offered to the model", async () => {
		const id = await newSession();
		await delegate(id, "just answer");
		// The main agent's own request also lists tools; the helper's is the one with the research prompt.
		const sub = upstream.requests.find((r) => JSON.stringify(r.body?.messages?.[0]).includes("read-only research assistant"));
		expect(sub).toBeDefined();
		const main = upstream.requests.find((r) => !JSON.stringify(r.body?.messages?.[0]).includes("read-only research assistant"));
		expect(main!.body.tools.map((t: any) => t.function.name)).toContain("write"); // the main agent does have write
		const names = sub!.body.tools.map((t: any) => t.function.name).sort();
		expect(names).toEqual(["grep", "ls", "read"]);
		expect(JSON.stringify(sub!.body.messages[0])).toContain("read-only research assistant");
	});

	test("a path that leaves the working directory is no longer refused (restriction disabled)", async () => {
		const id = await newSession();
		for (const path of ["../outside.txt", "link.txt"]) {
			const result = await delegate(id, `!read ${JSON.stringify({ path })}`);
			const text = JSON.stringify(result.content);
			expect(text).not.toContain("outside the session working directory");
			expect(text).toContain("TOP SECRET");
		}
	});

	test("a helper that tries to edit or run commands gets nothing: those tools do not exist for it", async () => {
		const id = await newSession();
		const result = await delegate(id, `!write ${JSON.stringify({ path: "pwned.txt", content: "x" })}`);
		expect(JSON.stringify(result.content)).toMatch(/not found|unknown|Tool write/i);
		expect(await Bun.file(join(ws, "pwned.txt")).exists()).toBe(false);
	});

	test("its token use and cost are added to the session usage", async () => {
		const id = await newSession();
		const before = (await api("GET", `/sessions/${id}/usage`)).json;
		const result = await delegate(id, "just answer");
		const after = (await api("GET", `/sessions/${id}/usage`)).json;
		const sub = result.details.usage;
		expect(sub.totalTokens).toBeGreaterThan(0);
		// The session total grew by the main agent's own calls PLUS the helper's, so by strictly more than the helper alone.
		expect(after.totalTokens - before.totalTokens).toBeGreaterThan(sub.totalTokens);
		expect(after.input - before.input).toBeGreaterThanOrEqual(sub.input);
		expect(after.output - before.output).toBeGreaterThanOrEqual(sub.output);
	});

	test("an over-long report is cut and says so; an early stop and an empty report are marked", () => {
		const cut = finishReport("x".repeat(MAX_REPORT_CHARS + 500), false);
		expect(cut.truncated).toBe(true);
		expect(cut.text).toContain("report cut at the length limit");
		expect(cut.text.length).toBeLessThan(MAX_REPORT_CHARS + 100);
		const fine = finishReport("short", false);
		expect(fine).toEqual({ text: "short", truncated: false });
		expect(finishReport("partial", true).text).toContain(`${MAX_TURNS}-step limit`);
		expect(finishReport("", false).text).toContain("no report");
	});

	test("task is validated: empty and oversized tasks are rejected as tool errors", async () => {
		const id = await newSession();
		const empty = await delegate(id, "");
		expect(empty.isError).toBe(true);
		const huge = await delegate(id, "y".repeat(4001));
		expect(huge.isError).toBe(true);
	});

	test("works in a read-only session, since the helper cannot change anything", async () => {
		const id = await newSession({ approval: "readonly" });
		const result = await delegate(id, "just answer");
		expect(result.isError).not.toBe(true);
		expect(result.details.subagent).toBe(true);
	});
	test("/subagent:name in a message tells the model which helper the user chose; unknown names add nothing", async () => {
		const id = await newSession();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: "/subagent:explore where is the login flow?" });
		await untilIdle(id);
		const sent = JSON.stringify(upstream.requests.at(0)?.body.messages);
		expect(sent).toContain("<pipaya-hint>");
		expect(sent).toContain('agent=\\"explore\\"');

		const id2 = await newSession();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id2}/messages`, { text: "/subagent:nobody costs $5 $explore" });
		await untilIdle(id2);
		expect(JSON.stringify(upstream.requests.at(0)?.body.messages)).not.toContain("<pipaya-hint>");
	});

	test("the system prompt lists the enabled helpers by name and description, and follows settings changes", async () => {
		const cur = (await api("GET", "/subagents")).json;
		const prompt = async () => {
			const id = await newSession();
			upstream.requests.length = 0;
			await api("POST", `/sessions/${id}/messages`, { text: "hi" });
			await untilIdle(id);
			const msgs = upstream.requests.at(0)?.body.messages as any[];
			return JSON.stringify(msgs.find((m) => m.role === "system" || m.role === "developer")?.content);
		};
		try {
			const on = await prompt();
			expect(on).toContain("Helpers you can hand work to");
			for (const a of cur.agents.filter((x: any) => x.enabled)) expect(on).toContain(`- ${a.name}: `);

			const off = (await api("PUT", "/subagents", { enabled: false }));
			expect(off.status).toBe(200);
			expect(await prompt()).not.toContain("Helpers you can hand work to");

			// A session without the delegate tool is not told about helpers it cannot call.
			expect((await api("PUT", "/subagents", { enabled: true })).status).toBe(200);
			const id = await newSession({ tools: ["read"] });
			upstream.requests.length = 0;
			await api("POST", `/sessions/${id}/messages`, { text: "hi" });
			await untilIdle(id);
			expect(JSON.stringify(upstream.requests.at(0)?.body.messages)).not.toContain("Helpers you can hand work to");
		} finally {
			await api("PUT", "/subagents", { enabled: true });
		}
	});

	test("with no helper defined nothing about sub-agents is injected, and no hint is added", async () => {
		renameSync(EXPLORE, `${EXPLORE}.off`);
		try {
			const id = await newSession();
			upstream.requests.length = 0;
			await api("POST", `/sessions/${id}/messages`, { text: "$explore hi" });
			await untilIdle(id);
			const sent = JSON.stringify(upstream.requests.at(0)?.body.messages);
			expect(sent).not.toContain("Helpers you can hand work to");
			expect(sent).not.toContain("<pipaya-hint>");
		} finally {
			renameSync(`${EXPLORE}.off`, EXPLORE);
		}
	});

	test("no hint when sub-agents are switched off", async () => {
		expect((await api("PUT", "/subagents", { enabled: false })).status).toBe(200);
		try {
			const id = await newSession();
			upstream.requests.length = 0;
			await api("POST", `/sessions/${id}/messages`, { text: "$explore hi" });
			await untilIdle(id);
			expect(JSON.stringify(upstream.requests.at(0)?.body.messages)).not.toContain("<pipaya-hint>");
		} finally {
			await api("PUT", "/subagents", { enabled: true });
		}
	});
});
