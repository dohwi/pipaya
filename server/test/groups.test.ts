import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";
import { cleanLayout, panesOf, withoutSession, type Layout } from "../src/groups.ts";

let app: App;
let base: string;
let dir: string;
let upstream: EchoUpstream;
const auth = { authorization: "Bearer t" };
const api = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(base + path, {
		method,
		headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
const pane = (sessionId: string): Layout => ({ type: "pane", sessionId });
const split = (a: Layout, b: Layout, dir: "row" | "col" = "row", ratio = 0.5): Layout => ({ type: "split", dir, ratio, a, b });
const mk = async () => (await api("POST", "/sessions", {})).json?.id as string | undefined;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-groups-"));
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "t.db"), token: "t", workspaceRoot: join(dir, "ws"), defaultApproval: "ask", approvalTimeoutMs: 0, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
	await app.server.listen({ host: "0.0.0.0", port: 0 });
	base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
	await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
	await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("layout helpers", () => {
	const all = () => true;
	test("withoutSession collapses the sibling into the parent's place", () => {
		const l = split(pane("a"), split(pane("b"), pane("c"), "col"));
		expect(withoutSession(l, "a")).toEqual(split(pane("b"), pane("c"), "col"));
		expect(withoutSession(pane("a"), "a")).toBeNull();
		expect(panesOf(withoutSession(l, "b")!)).toEqual(["a", "c"]);
	});
	test("cleanLayout clamps ratio and rejects duplicates / bad nodes", () => {
		const l = cleanLayout({ type: "split", dir: "row", ratio: 5, a: pane("a"), b: pane("b"), extra: 1 }, all) as Extract<Layout, { type: "split" }>;
		expect(l.ratio).toBe(0.9);
		expect("extra" in l).toBe(false);
		expect(() => cleanLayout(split(pane("a"), pane("a")), all)).toThrow();
		expect(() => cleanLayout({ type: "nope" }, all)).toThrow();
		expect(() => cleanLayout(pane("a"), () => false)).toThrow();
	});
	test("cleanLayout caps the number of panes", () => {
		let l: Layout = pane("s0");
		for (let i = 1; i < 9; i++) l = split(l, pane(`s${i}`));
		expect(() => cleanLayout(l, all)).toThrow();
	});
});

describe("groups API", () => {
	test("create, rename, relayout, delete", async () => {
		const [a, b] = [await mk(), await mk()];
		const created = await api("POST", "/groups", { name: "작업", layout: split(pane(a!), pane(b!)) });
		expect(created.status).toBe(201);
		const id = created.json.id;
		expect((await api("GET", "/groups")).json.groups.some((g: { id: string }) => g.id === id)).toBe(true);

		const renamed = await api("PATCH", `/groups/${id}`, { name: "리뷰" });
		expect(renamed.json.name).toBe("리뷰");
		expect(panesOf(renamed.json.layout)).toEqual([a!, b!]);

		const re = await api("PATCH", `/groups/${id}`, { layout: split(pane(b!), pane(a!), "col", 0.3) });
		expect(re.json.layout.dir).toBe("col");

		expect((await api("DELETE", `/groups/${id}`)).status).toBe(200);
		expect((await api("DELETE", `/groups/${id}`)).status).toBe(404);
	});

	test("default name, unknown session, duplicate session", async () => {
		const a = (await mk())!;
		const b = (await mk())!;
		const g = await api("POST", "/groups", { layout: split(pane(a), pane(b)) });
		expect(g.json.name).toMatch(/^Group \d+$/);
		expect((await api("POST", "/groups", { layout: split(pane(a), pane("nope")) })).status).toBe(404);
		expect((await api("POST", "/groups", { layout: split(pane(a), pane(a)) })).status).toBe(400);
		await api("DELETE", `/groups/${g.json.id}`);
	});

	test("a session lives in one group: claiming moves it, an emptied group disappears", async () => {
		const [a, b, c] = [(await mk())!, (await mk())!, (await mk())!];
		const g1 = (await api("POST", "/groups", { name: "g1", layout: split(pane(a), pane(b)) })).json;
		const g2 = (await api("POST", "/groups", { name: "g2", layout: split(pane(b), pane(c)) })).json;
		const groups = (await api("GET", "/groups")).json.groups as { id: string; layout: Layout }[];
		expect(groups.some((g) => g.id === g1.id)).toBe(false); // left with just `a`: dissolved
		expect(panesOf(groups.find((g) => g.id === g2.id)!.layout)).toEqual([b, c]);

		await api("POST", "/groups", { name: "g3", layout: split(pane(a), pane(b)) });
		const after = (await api("GET", "/groups")).json.groups as { id: string }[];
		expect(after.some((g) => g.id === g2.id)).toBe(false); // `c` alone is not a group either
	});

	test("closing or deleting a session removes it from its group", async () => {
		const [a, b, c] = [(await mk())!, (await mk())!, (await mk())!];
		const g = (await api("POST", "/groups", { layout: split(pane(a), split(pane(b), pane(c), "col")) })).json;
		await api("PATCH", `/sessions/${b}`, { closed: true });
		const cur = (await api("GET", "/groups")).json.groups.find((x: { id: string }) => x.id === g.id);
		expect(panesOf(cur.layout)).toEqual([a, c]);
		await api("DELETE", `/sessions/${a}`);
		// one session is left, so the group dissolves
		expect((await api("GET", "/groups")).json.groups.some((x: { id: string }) => x.id === g.id)).toBe(false);
	});

	test("group changes are published as events", async () => {
		const a = (await mk())!;
		const before = app.bus.latestId();
		const g = (await api("POST", "/groups", { layout: split(pane(a), pane((await mk())!)) })).json;
		await api("PATCH", `/groups/${g.id}`, { name: "x" });
		await api("DELETE", `/groups/${g.id}`);
		const types = app.bus.history({ after: before, limit: 50 }).map((e) => e.type).filter((t) => t.startsWith("group_"));
		expect(types).toEqual(["group_created", "group_updated", "group_deleted"]);
	});

	test("a group needs two sessions", async () => {
		const [a, b] = [(await mk())!, (await mk())!];
		expect((await api("POST", "/groups", { layout: pane(a) })).status).toBe(400);
		const g = (await api("POST", "/groups", { layout: split(pane(a), pane(b)) })).json;
		expect((await api("PATCH", `/groups/${g.id}`, { layout: pane(a) })).status).toBe(400);
		await api("DELETE", `/groups/${g.id}`);
	});

	test("requires the token", async () => {
		const res = await fetch(`${base}/groups`);
		expect(res.status).toBe(401);
	});
});
