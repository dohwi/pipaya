import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

describe("peer sessions: names, peer_send / peer_read and @mentions", () => {
	let app: Awaited<ReturnType<typeof buildApp>>, base = "", dir = "", upstream: ReturnType<typeof startEchoUpstream>;
	const api = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: "Bearer t", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const pane = (sessionId: string) => ({ type: "pane", sessionId });
	const split = (a: unknown, b: unknown) => ({ type: "split", dir: "row", ratio: 0.5, a, b });
	const mk = async (lang?: string) => (await api("POST", "/sessions", lang ? { lang } : {})).json.id as string;
	const nameOf = async (id: string) => (await api("GET", `/sessions/${id}`)).json.name as string;
	const idle = async (id: string) => { for (let i = 0; i < 200; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(25); } };
	const said = async (id: string) => JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json);

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-peers-"));
		upstream = startEchoUpstream();
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "t.db"), token: "t", workspaceRoot: join(dir, "ws"), logLevel: "silent" }, { strictResponses: true, extensionDirs: [] });
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

	test("the peer tools and ask_user are built in and can be switched off", async () => {
		const info = (await api("GET", "/configuration")).json.tools;
		for (const n of ["ask_user", "peer_send", "peer_read"]) expect(info.toggleable).toContain(n);
		expect((await api("GET", "/tools")).json.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["ask_user", "peer_send", "peer_read"]));
	});

	test("peer_send reaches another session and peer_read shows its answer", async () => {
		const [a, b] = [await mk(), await mk()];
		const bName = await nameOf(b);
		await api("POST", `/sessions/${a}/messages`, { text: `!peer_send ${JSON.stringify({ to: bName, message: "hello peer" })}` });
		await idle(a);
		await Bun.sleep(100);
		await idle(b);
		const got = await said(b);
		expect(got).toContain("hello peer");
		expect(got).toContain(`from @${await nameOf(a)}`);
		await api("POST", `/sessions/${a}/messages`, { text: `!peer_read ${JSON.stringify({ from: bName })}` });
		await idle(a);
		expect(await said(a)).toContain("hello peer");
		// an unknown name is a tool error, not a crash
		await api("POST", `/sessions/${a}/messages`, { text: `!peer_send ${JSON.stringify({ to: "nobody", message: "x" })}` });
		await idle(a);
		expect(await said(a)).toContain("session @nobody");
	});

	test("peer_send to a group name reaches every other session in that group", async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		const g = (await api("POST", "/groups", { name: "앱 개발", layout: split(pane(a), split(pane(b), pane(c))) })).json;
		await api("POST", `/sessions/${a}/messages`, { text: `!peer_send ${JSON.stringify({ to: "앱-개발", message: "to everyone" })}` });
		await idle(a);
		await Bun.sleep(100);
		await Promise.all([idle(b), idle(c)]);
		for (const id of [b, c]) expect(await said(id)).toContain("to everyone");
		expect(await said(a)).not.toContain("from @"); // the sender is not among the targets
		await api("DELETE", `/groups/${g.id}`);
	});

	test("@name and @group in a message add an index hint, not a transcript", async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await api("POST", "/groups", { name: "Hint Crew", layout: split(pane(b), pane(c)) });
		await api("POST", `/sessions/${a}/messages`, { text: `hi @${await nameOf(b)} and @Hint-Crew` });
		await idle(a);
		const body = await said(a);
		expect(body).toContain("The user mentioned other sessions");
		expect(body).toContain("Group @Hint-Crew");
	});

	test("every active session has its own name, a closed one gives it up, and names follow the UI language", async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		const names = async () => Object.fromEntries(await Promise.all([a, b, c].map(async (id) => [id, await nameOf(id)] as const)));
		const before = await names();
		expect(new Set(Object.values(before)).size).toBe(3);
		await api("PATCH", `/sessions/${c}`, { closed: true });
		const d = await mk();
		expect(await nameOf(d)).toBe(before[c]!);
		await api("PATCH", `/sessions/${c}`, { closed: false });
		const after = await nameOf(c);
		expect(after).toBeTruthy();
		expect([before[a]!, before[b]!, await nameOf(d)]).not.toContain(after);
		// the UI language switched: names become their romanized twins and back
		expect((await api("POST", "/sessions/localize-names", { lang: "en" })).json.renamed).toBeGreaterThan(0);
		expect(await nameOf(a)).toMatch(/^[A-Za-z]+\d*$/);
		await api("POST", "/sessions/localize-names", { lang: "ko" });
		expect(await nameOf(a)).toBe(before[a]!);
		// a session made from an English UI gets an English name
		expect(await nameOf(await mk("en"))).toMatch(/^[A-Za-z]+\d*$/);
	});

	test("a group cannot take a session's name", async () => {
		const [a, b] = [await mk(), await mk()];
		const taken = await nameOf(a);
		const g = (await api("POST", "/groups", { name: taken, layout: split(pane(a), pane(b)) })).json;
		expect(g.name.toLowerCase()).not.toBe(taken.toLowerCase());
	});
});

describe("old copies of the replaced extensions", () => {
	test("ask-user and peer-tools folders are skipped, so the built-in tools stay in charge", async () => {
		const d = mkdtempSync(join(tmpdir(), "pipaya-retired-"));
		try {
			for (const name of ["ask-user", "peer-tools"]) {
				mkdirSync(join(d, "ext", name), { recursive: true });
				writeFileSync(join(d, "ext", name, "index.ts"), `export default (pi: any) => { pi.registerTool({ name: "${name === "ask-user" ? "ask_user" : "peer_send"}", label: "x", description: "old copy", parameters: pi.Type.Object({}), async execute() { return { content: [{ type: "text", text: "old" }] }; } }); };`);
			}
			const other = await buildApp({ host: "0.0.0.0", port: 0, dataDir: d, dbPath: join(d, "t.db"), token: "t", workspaceRoot: join(d, "ws"), logLevel: "silent" }, { extensionDirs: [join(d, "ext")] });
			const res = await other.server.inject({ method: "GET", url: "/tools", headers: { authorization: "Bearer t" } });
			const tools = res.json().tools as { name: string; description: string }[];
			expect(tools.filter((t) => t.description === "old copy")).toEqual([]);
			expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["ask_user", "peer_send"]));
			await other.close();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
