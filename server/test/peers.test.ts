import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

describe("peer sessions: names, peer / peer read and @mentions", () => {
	let app: Awaited<ReturnType<typeof buildApp>>, base = "", dir = "", upstream: ReturnType<typeof startEchoUpstream>;
	const api = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: "Bearer t", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const pane = (sessionId: string) => ({ type: "pane", sessionId });
	const split = (a: unknown, b: unknown) => ({ type: "split", dir: "row", ratio: 0.5, a, b });
	const mk = async () => (await api("POST", "/sessions", {})).json.id as string;
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
		for (const n of ["ask_user", "peer", "peer"]) expect(info.toggleable).toContain(n);
		expect((await api("GET", "/tools")).json.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["ask_user", "peer", "peer"]));
	});

	test("peer reaches another session and peer read shows its answer", async () => {
		const [a, b] = [await mk(), await mk()];
		const bName = await nameOf(b);
		await api("POST", `/sessions/${a}/messages`, { text: `!peer ${JSON.stringify({ action: "send", to: bName, message: "hello peer" })}` });
		await idle(a);
		await Bun.sleep(100);
		await idle(b);
		const got = await said(b);
		expect(got).toContain("hello peer");
		expect(got).toContain(`from @${await nameOf(a)}`);
		await api("POST", `/sessions/${a}/messages`, { text: `!peer ${JSON.stringify({ action: "read", name: bName })}` });
		await idle(a);
		expect(await said(a)).toContain("hello peer");
		// an unknown name is a tool error, not a crash
		await api("POST", `/sessions/${a}/messages`, { text: `!peer ${JSON.stringify({ action: "send", to: "nobody", message: "x" })}` });
		await idle(a);
		expect(await said(a)).toContain("session @nobody");
	});

	test("peer to a group name reaches every other session in that group", async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		const g = (await api("POST", "/groups", { name: "앱 개발", layout: split(pane(a), split(pane(b), pane(c))) })).json;
		await api("POST", `/sessions/${a}/messages`, { text: `!peer ${JSON.stringify({ action: "send", to: "앱-개발", message: "to everyone" })}` });
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

	test("every active session has its own name, a closed one gives it up, and a name does not follow the UI language", async () => {
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
		// a name is stored once, in Korean: the UI language only changes how it is written (see member-names.test.ts)
		expect(await nameOf(a)).toMatch(/^[가-힣]+\d*$/);
	});

	test("a group cannot take a session's name", async () => {
		const [a, b] = [await mk(), await mk()];
		const taken = await nameOf(a);
		const g = (await api("POST", "/groups", { name: taken, layout: split(pane(a), pane(b)) })).json;
		expect(g.name.toLowerCase()).not.toBe(taken.toLowerCase());
	});

	test("peer_list and the notify report let a session manage the others", async () => {
		const [boss, worker] = [await mk(), await mk()];
		const wName = await nameOf(worker);
		const call = async (tool: string, args: unknown) => { await api("POST", `/sessions/${boss}/messages`, { text: `!${tool} ${JSON.stringify(args)}` }); await idle(boss); };
		await call("peer", { action: "list" });
		expect(await said(boss)).toContain(`@${wName}`);
		// notify: the worker's run ends, the boss gets one report without asking
		await call("peer", { action: "send", to: wName, message: "do the thing", notify: true });
		await idle(worker);
		await Bun.sleep(300);
		await idle(boss);
		expect(await said(boss)).toContain(`@${wName} finished its run`);
		// a session that was not asked to notify does not report
		const before = (await said(boss)).split("finished its run").length;
		await call("peer", { action: "send", to: wName, message: "again" });
		await idle(worker);
		await Bun.sleep(300);
		await idle(boss);
		expect((await said(boss)).split("finished its run").length).toBe(before);
	});

	test("peer_create starts a session on a task and reports back; peer_manage closes, renames and deletes it", async () => {
		const boss = await mk();
		const call = async (tool: string, args: unknown) => { await api("POST", `/sessions/${boss}/messages`, { text: `!${tool} ${JSON.stringify(args)}` }); await idle(boss); };
		const before = (await api("GET", "/sessions")).json.sessions.map((x: any) => x.id);
		await call("peer", { action: "create", message: "build the thing", title: "built", purpose: "builder" });
		const kid = (await api("GET", "/sessions")).json.sessions.find((x: any) => !before.includes(x.id));
		expect(kid.title).toBe("built");
		expect(kid.purpose).toBe("builder");
		expect(kid.parentId).toBe(boss);
		expect(kid.muted).toBeUndefined(); // per-session mute is gone: peer create no longer silences the new session
		await idle(kid.id);
		await Bun.sleep(300);
		await idle(boss);
		expect(await said(kid.id)).toContain("build the thing");
		expect(await said(boss)).toContain(`@${kid.name} finished its run`); // notify defaults on
		// rename: a free name works, a taken or invalid one is refused
		await call("peer", { name: kid.name, action: "rename", newName: "builder-1" });
		expect(await nameOf(kid.id)).toBe("builder-1");
		await call("peer", { name: "builder-1", action: "rename", newName: "bad name!" });
		expect(await nameOf(kid.id)).toBe("builder-1");
		await call("peer", { name: "builder-1", action: "set", purpose: "reviewer" });
		expect((await api("GET", `/sessions/${kid.id}`)).json.purpose).toBe("reviewer");
		// close and resume
		await call("peer", { name: "builder-1", action: "close" });
		expect((await api("GET", `/sessions/${kid.id}`)).json.closed).toBe(true);
		await call("peer", { name: "builder-1", action: "resume" });
		expect((await api("GET", `/sessions/${kid.id}`)).json.closed).toBe(false);
		// delete works on what the boss created, and only on that
		const other = await mk();
		await call("peer", { name: await nameOf(other), action: "delete" });
		expect((await api("GET", `/sessions/${other}`)).status).toBe(200);
		await call("peer", { name: "builder-1", action: "delete" });
		expect((await api("GET", `/sessions/${kid.id}`)).status).toBe(404);
	});

	test("a watcher hears a question and answers it with peer_answer", async () => {
		const [boss, worker] = [await mk(), await mk()];
		const wName = await nameOf(worker);
		const call = async (tool: string, args: unknown) => { await api("POST", `/sessions/${boss}/messages`, { text: `!${tool} ${JSON.stringify(args)}` }); await idle(boss); };
		// the boss watches the worker, then the worker asks its user something
		await call("peer", { action: "send", to: wName, message: "hi", notify: true });
		await idle(worker);
		await Bun.sleep(300);
		await idle(boss);
		await call("peer", { action: "send", to: wName, message: "again", notify: true });
		await idle(worker);
		await Bun.sleep(300);
		await idle(boss);
		await api("POST", `/sessions/${worker}/messages`, { text: `!ask_user ${JSON.stringify({ question: "which color?", options: ["red", "blue"], allowFreeText: false })}` });
		for (let i = 0; i < 100 && !(await api("GET", `/questions?sessionId=${worker}`)).json.questions.length; i++) await Bun.sleep(25);
		expect((await api("GET", `/questions?sessionId=${worker}`)).json.questions).toHaveLength(1);
		await call("peer", { action: "read", name: wName });
		expect(await said(boss)).toContain("waits for an answer");
		// a wrong answer is refused, the right one releases the worker
		await call("peer", { action: "answer", name: wName, answer: "green" });
		expect((await api("GET", `/questions?sessionId=${worker}`)).json.questions).toHaveLength(1);
		await call("peer", { action: "answer", name: wName, answer: "blue" });
		await idle(worker);
		expect((await api("GET", `/questions?sessionId=${worker}`)).json.questions).toEqual([]);
		expect(await said(worker)).toContain("blue");
	});

	test("peer read detail shows tool calls and errors; cancel_queued lists what waits; a deleted watcher leaves no trace", async () => {
		const [boss, worker] = [await mk(), await mk()];
		const wName = await nameOf(worker);
		const call = async (tool: string, args: unknown) => { await api("POST", `/sessions/${boss}/messages`, { text: `!${tool} ${JSON.stringify(args)}` }); await idle(boss); };
		await api("POST", `/sessions/${worker}/messages`, { text: "!bash echo detail-marker" });
		await idle(worker);
		await call("peer", { action: "read", name: wName });
		expect(await said(boss)).not.toContain("tool result bash");
		await call("peer", { action: "read", name: wName, detail: true });
		expect(await said(boss)).toContain("tool result bash");
		await call("peer", { name: wName, action: "cancel_queued" });
		expect(await said(boss)).toContain(`Nothing is queued for @${wName}`);
		// watching a session and then deleting the watcher must not break the target's next run end
		await call("peer", { action: "send", to: wName, message: "x", notify: true });
		await api("DELETE", `/sessions/${boss}`);
		await idle(worker);
		await Bun.sleep(200);
		expect((await api("GET", `/sessions/${worker}/status`)).status).toBe(200);
	});

	test("peer_group builds, extends and dissolves a group", async () => {
		const [boss, a, b] = [await mk(), await mk(), await mk()];
		const call = async (args: unknown) => { await api("POST", `/sessions/${boss}/messages`, { text: `!peer ${JSON.stringify(args)}` }); await idle(boss); };
		await call({ action: "group_create", groupName: "crew", members: [await nameOf(a), await nameOf(b)] });
		let groups = (await api("GET", "/groups")).json.groups;
		expect(groups.map((g: any) => g.name)).toContain("crew");
		await call({ action: "group_add", group: "crew", members: [await nameOf(boss)] });
		const g = (await api("GET", "/groups")).json.groups.find((x: any) => x.name === "crew");
		expect(JSON.stringify(g.layout)).toContain(boss);
		await call({ action: "group_dissolve", group: "crew" });
		groups = (await api("GET", "/groups")).json.groups;
		expect(groups.map((x: any) => x.name)).not.toContain("crew");
	});
});

describe("old copies of the replaced extensions", () => {
	test("ask-user and peer-tools folders are skipped, so the built-in tools stay in charge", async () => {
		const d = mkdtempSync(join(tmpdir(), "pipaya-retired-"));
		try {
			for (const name of ["ask-user", "peer-tools"]) {
				mkdirSync(join(d, "ext", name), { recursive: true });
				writeFileSync(join(d, "ext", name, "index.ts"), `export default (pi: any) => { pi.registerTool({ name: "${name === "ask-user" ? "ask_user" : "peer"}", label: "x", description: "old copy", parameters: pi.Type.Object({}), async execute() { return { content: [{ type: "text", text: "old" }] }; } }); };`);
			}
			const other = await buildApp({ host: "0.0.0.0", port: 0, dataDir: d, dbPath: join(d, "t.db"), token: "t", workspaceRoot: join(d, "ws"), logLevel: "silent" }, { extensionDirs: [join(d, "ext")] });
			const res = await other.server.inject({ method: "GET", url: "/tools", headers: { authorization: "Bearer t" } });
			const tools = res.json().tools as { name: string; description: string }[];
			expect(tools.filter((t) => t.description === "old copy")).toEqual([]);
			expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["ask_user", "peer"]));
			await other.close();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("peerMessage", () => {
	test("placeholders typed inside the message are not expanded", async () => {
		const { peerMessage } = await import("../src/peers.ts");
		const text = peerMessage("ana", "price is ${sender} and ${message}");
		expect(text).toContain("[from @ana, another session");
		expect(text.endsWith("price is ${sender} and ${message}")).toBe(true);
	});
});
