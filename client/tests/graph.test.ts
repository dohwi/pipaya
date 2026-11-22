import { describe, expect, test } from "bun:test";
import { ROW_GAP, ROLE_STALE_MS, buildGraph, endpointKey, modelCardId, providerCardId, roleCardId, staleRoles, quietCards, CARD_W_MAX, isMouseWheel, springStep, CARD_H, CARD_H_LIVE, edgeLength, edgePath, edgeTip, sparkPlan, fitGraph, fitView, focusCards, FIT_MIN, FIT_PAD, growthPlan, leavePlan, modelName, related, type DelegateRun, type GraphServer } from "../src/lib/graph";
import type { Activity } from "../src/lib/activity";
import type { Session } from "../src/lib/types";

const pid = (p = "p") => providerCardId(endpointKey(p));
const mid = (p = "p", m = "m") => modelCardId(endpointKey(p), m);

const session = (id: string, over: Partial<Session> = {}): Session =>
	({ id, title: id, name: id, purpose: "", cwd: "/w", provider: "p", model: "m", thinkingLevel: "off", systemPrompt: "", tools: [], parentId: null, closed: false, createdAt: 1, updatedAt: 1, ...over }) as Session;
const run = (sessionId: string, role: string, over: Partial<DelegateRun> = {}): DelegateRun =>
	({ sessionId, callId: `${sessionId}-${role}-${Math.random()}`, role, free: false, asked: null, model: "p/m", at: 1, doneAt: 2, running: false, error: false, turns: 1, tokens: 10, ...over });
const server = (id: string, sessions: Session[], over: Partial<GraphServer> & { states?: Record<string, Activity> } = {}): GraphServer => ({
	id,
	name: id,
	host: `${id}.local`,
	online: true,
	sessions,
	activity: (sid) => over.states?.[sid] ?? "idle",
	queued: () => 0,
	runs: [],
	...over,
});

describe("buildGraph", () => {
	test("providers, models and a role's models read by the names the owner gave them; ids stay the keys", () => {
		const names: Record<string, string> = { "p/m": "Fast model", "p/sub": "Helper model" };
		const g = buildGraph([server("a", [session("s1"), session("s2", { model: "m2" })], {
			runs: [run("s1", "explore", { model: "p/sub" }), run("s1", "explore", { model: "q/raw" })],
			modelName: (provider, id) => names[`${provider}/${id}`] ?? id,
			providerName: (id) => (id === "p" ? "My Proxy" : id),
		})]);
		expect(g.cards.get(pid("p"))!.label).toBe("p");
		expect(g.cards.get(pid("p"))!.name).toBe("My Proxy");
		expect(g.cards.get(mid("p", "m"))!.name).toBe("Fast model");
		expect(g.cards.get(mid("p", "m2"))!.name).toBe("m2"); // no name given: the id
		expect(g.cards.get(roleCardId("a", "explore", "p/sub"))!.model!.name).toBe("Helper model");
		expect(g.cards.get(roleCardId("a", "explore", "q/raw"))!.model!.name).toBe("raw");
		expect(g.cards.get("v:a")!.name).toBe("a");
	});

	test("server → provider → model → chat, with counts on every hub", () => {
		const g = buildGraph([server("a", [session("s1"), session("s2", { model: "m2" }), session("s3", { provider: "q" })])]);
		const kinds = (k: string) => [...g.cards.values()].filter((c) => c.kind === k).map((c) => c.id).sort();
		expect(kinds("server")).toEqual(["v:a"]);
		expect(kinds("provider")).toEqual([pid("p"), pid("q")].sort());
		expect(kinds("model")).toEqual([mid("p", "m"), mid("p", "m2"), mid("q", "m")].sort());
		expect(g.cards.get("v:a")!.count).toBe(3);
		expect(g.cards.get(pid("p"))!.count).toBe(2);
		expect([g.cards.get("v:a")!.col, g.cards.get(pid("p"))!.col, g.cards.get(mid("p", "m"))!.col, g.cards.get("s:a/s1")!.col]).toEqual([0, 1, 2, 3]);
		// a hub sits in the middle of what is under it
		const p = g.cards.get(pid("p"))!, m1 = g.cards.get(mid("p", "m"))!, m2 = g.cards.get(mid("p", "m2"))!;
		expect(p.y).toBe((m1.y + m2.y) / 2);
	});

	test("an empty or unreachable server still shows; closed chats do not", () => {
		const g = buildGraph([server("a", [session("s1", { closed: true })], { online: false })]);
		expect([...g.cards.keys()]).toEqual(["v:a"]);
		expect(g.cards.get("v:a")).toMatchObject({ online: false, count: 0 });
		expect(buildGraph([]).cards.size).toBe(0);
	});

	test("a branched chat sits right of its parent; a parent that is closed or itself leaves it under its model", () => {
		const g = buildGraph([server("a", [session("root"), session("kid", { parentId: "root" }), session("orphan", { parentId: "gone" }), session("self", { parentId: "self" })])]);
		expect(g.cards.get("s:a/kid")!.col).toBe(g.cards.get("s:a/root")!.col + 1);
		expect(g.edges.find((e) => e.to === "s:a/kid")).toMatchObject({ kind: "spawn", from: "s:a/root" });
		expect(g.edges.find((e) => e.to === "s:a/orphan")!.from).toBe(mid("p", "m"));
		expect(g.edges.find((e) => e.to === "s:a/self")!.from).toBe(mid("p", "m"));
	});

	test("chats that want the user come first; a working chat is taller and lights its line to the server", () => {
		const states: Record<string, Activity> = { idle: "idle", ask: "asking", work: "working", fail: "failed" };
		const g = buildGraph([server("a", [session("idle"), session("ask"), session("work"), session("fail")], { states })]);
		const ys = ["ask", "fail", "work", "idle"].map((id) => g.cards.get(`s:a/${id}`)!.y);
		expect([...ys].sort((x, y) => x - y)).toEqual(ys);
		expect(g.cards.get("s:a/work")!.h).toBe(CARD_H_LIVE);
		expect(g.cards.get("s:a/idle")!.h).toBe(CARD_H);
		expect(["v:a", pid("p"), mid("p", "m")].every((id) => g.cards.get(id)!.live)).toBe(true);
		expect(g.edges.find((e) => e.to === "s:a/work")!.live).toBe(true);
		expect(g.edges.find((e) => e.to === "s:a/idle")!.live).toBe(false);
	});

	test("subagents: one card per role and model per server, free, asked and running counted; one edge per chat and card", () => {
		const runs = [
			run("s1", "explore", { model: "p/old", at: 1 }),
			run("s1", "explore", { model: "p/new", at: 5, asked: "p/new" }),
			run("s2", "explore", { model: "p/new", at: 3, running: true, doneAt: null }),
			run("s2", "adhoc", { free: true }),
			run("closed", "explore"),
		];
		const g = buildGraph([server("a", [session("s1"), session("s2")], { runs })]);
		const r = g.cards.get(roleCardId("a", "explore", "p/new"))!;
		const old = g.cards.get(roleCardId("a", "explore", "p/old"))!;
		expect(r).toMatchObject({ kind: "subagent", label: "explore", count: 2, running: 1, asked: 1, free: false, live: true, last: 5 });
		expect(r.model).toMatchObject({ model: "p/new", name: "new" });
		expect(old).toMatchObject({ count: 1, running: 0, live: false });
		const adhoc = g.cards.get(roleCardId("a", "adhoc", "p/m"))!;
		expect(adhoc.free).toBe(true);
		// a running card says who called it, and grows by the live line like a working chat
		expect(r.calls).toEqual([{ sessionId: "s2", who: "@s2", at: 3 }]);
		expect(r.h).toBe(CARD_H_LIVE);
		expect(adhoc.h).toBe(CARD_H);
		const del = g.edges.filter((e) => e.kind === "delegate");
		expect(del.map((e) => [e.from, e.to, e.weight, e.live]).sort()).toEqual([
			["s:a/s1", old.id, 1, false],
			["s:a/s1", r.id, 1, false],
			["s:a/s2", adhoc.id, 1, false],
			["s:a/s2", r.id, 1, true],
		].sort());
		// one role's cards stand together, the model used last on top
		expect(old.y - r.y).toBe(r.h / 2 + ROW_GAP + old.h / 2);
		// the subagents form the last column, without overlapping
		const roles = [...g.cards.values()].filter((c) => c.kind === "subagent").sort((x, y) => x.y - y.y);
		expect(roles.every((c) => c.col === g.cols.length - 1)).toBe(true);
		expect(roles[1]!.y - roles[0]!.y).toBeGreaterThanOrEqual(CARD_H);
	});

	test("staleRoles: a role's card on a model it moved off fades after a while; its newest card and a running one never do", () => {
		const now = 10 * ROLE_STALE_MS;
		const runs = [
			run("s1", "explore", { model: "p/old", at: now - 2 * ROLE_STALE_MS }),
			run("s1", "explore", { model: "p/new", at: now - 3 * ROLE_STALE_MS }),
			run("s1", "explore", { model: "p/newer", at: now - ROLE_STALE_MS / 2 }),
			run("s1", "runner", { model: "p/a", at: now - 5 * ROLE_STALE_MS, running: true, doneAt: null }),
			run("s1", "runner", { model: "p/b", at: now - 4 * ROLE_STALE_MS }),
			run("s1", "lone", { model: "p/a", at: now - 9 * ROLE_STALE_MS }),
		];
		const g = buildGraph([server("a", [session("s1")], { runs })]);
		expect([...staleRoles(g, now)].sort()).toEqual([roleCardId("a", "explore", "p/new"), roleCardId("a", "explore", "p/old")].sort());
		// within the hour a moved-off model still counts as in use
		expect(staleRoles(g, now - ROLE_STALE_MS).has(roleCardId("a", "explore", "p/old"))).toBe(false);
	});

	test("a server without the delegate route shows its chats and no subagents", () => {
		const g = buildGraph([server("a", [session("s1")], { runs: null })]);
		expect([...g.cards.values()].some((c) => c.kind === "subagent")).toBe(false);
	});

	test("quietCards: idle chats, hubs with only idle chats and every card of an offline server step back", () => {
		const states: Record<string, Activity> = { busy: "working", ask: "asking", done: "done", rest: "idle", kid: "idle" };
		const g = buildGraph([
			server("a", [session("busy"), session("ask", { model: "m2" }), session("done", { model: "m3" }), session("rest", { model: "m4" }), session("kid", { model: "m4", parentId: "rest" })], { states }),
			server("off", [session("x", { provider: "off-p" })], { online: false, states: { x: "working" } }),
		]);
		const q = quietCards(g, 0);
		// at rest: the idle chats and the model with nothing but idle chats under it
		expect(["s:a/rest", "s:a/kid", mid("p", "m4")].every((id) => q.has(id))).toBe(true);
		// in use: what works, asks or has something new, the hubs above them and the online server
		expect(["s:a/busy", "s:a/ask", "s:a/done", mid("p", "m"), mid("p", "m2"), mid("p", "m3"), pid("p"), "v:a"].some((id) => q.has(id))).toBe(false);
		// a role steps back when it runs nothing and only resting chats call it
		const r = buildGraph([server("a", [session("busy"), session("rest")], { states, runs: [run("rest", "explore"), run("rest", "runner"), run("busy", "runner"), run("rest", "ui", { running: true, doneAt: null })] })]);
		const rq = quietCards(r, 0);
		expect([roleCardId("a", "explore", "p/m"), roleCardId("a", "runner", "p/m"), roleCardId("a", "ui", "p/m")].map((id) => rq.has(id))).toEqual([true, false, false]);
		// an offline server's cards all step back, even a chat it last saw working
		expect(["v:off", pid("off-p"), mid("off-p", "m"), "s:off/x"].every((id) => q.has(id))).toBe(true);
	});

	test("servers cluster tightly on the left and merge identical built-in providers and custom endpoints", () => {
		const g = buildGraph([
			server("a", [session("s1"), session("s2", { provider: "c1", model: "gpt" })], {
				endpoint: (id) => (id === "c1" ? { id, name: "Proxy A", baseUrl: "https://Proxy.Local/v1/", api: "openai-completions" } : undefined),
				states: { s1: "working" },
			}),
			server("b", [session("s1"), session("s2", { provider: "c2", model: "gpt" }), session("s3", { provider: "other", model: "m3" })], {
				endpoint: (id) =>
					id === "c2"
						? { id, name: "Proxy B", baseUrl: "https://proxy.local/v1", api: "openai-completions" }
						: id === "other"
							? { id, name: "Other", baseUrl: "https://other.local/v1", api: "openai-completions" }
							: undefined,
			}),
		]);
		// servers sit stacked together at col 0 with ROW_GAP between them
		const va = g.cards.get("v:a")!, vb = g.cards.get("v:b")!;
		expect([va.col, vb.col]).toEqual([0, 0]);
		expect(vb.y - va.y).toBe(CARD_H + ROW_GAP);
		expect(va.count).toBe(2);
		expect(vb.count).toBe(3);

		// built-in `p` and identical custom endpoint (`c1` & `c2` normalized URL + API) merged across servers
		const sharedBuiltin = g.cards.get(pid("p"))!;
		expect(sharedBuiltin.servers).toEqual(["a", "b"]);
		expect(sharedBuiltin.count).toBe(2);
		const epKey = endpointKey("c1", { id: "c1", baseUrl: "https://proxy.local/v1", api: "openai-completions" });
		const sharedCustom = g.cards.get(providerCardId(epKey))!;
		expect(sharedCustom.servers).toEqual(["a", "b"]);
		expect(sharedCustom.ep?.byServer).toEqual({ a: "c1", b: "c2" });
		expect(sharedCustom.count).toBe(2);
		expect(g.cards.get(modelCardId(epKey, "gpt"))!.servers).toEqual(["a", "b"]);

		// only server A's edge into shared `p` lights up while server B is idle
		expect(g.edges.find((e) => e.from === "v:a" && e.to === pid("p"))!.live).toBe(true);
		expect(g.edges.find((e) => e.from === "v:b" && e.to === pid("p"))!.live).toBe(false);
		expect(va.live).toBe(true);
		expect(vb.live).toBe(false);
	});

	test("endpoints with the same id on two servers stay separate if their URLs or API formats differ", () => {
		const g = buildGraph([
			server("a", [session("s1", { provider: "proxy" })], {
				endpoint: () => ({ id: "proxy", baseUrl: "http://10.0.0.1:8080/v1", api: "openai-completions" }),
			}),
			server("b", [session("s1", { provider: "proxy" })], {
				endpoint: () => ({ id: "proxy", baseUrl: "http://10.0.0.2:8080/v1", api: "openai-completions" }),
			}),
		]);
		const providers = [...g.cards.values()].filter((c) => c.kind === "provider");
		expect(providers).toHaveLength(2);
	});

	test("one width per column: a measured long name widens its whole column, up to CARD_W_MAX", () => {
		const g = buildGraph([server("a", [session("s1", { model: "a-very-long-model-id" }), session("s2")])], { widths: (c) => (c.label.length > 10 ? 300 : 0) });
		expect(g.cards.get(mid("p", "a-very-long-model-id"))!.w).toBe(300);
		expect(g.cards.get(mid("p", "m"))!.w).toBe(300);
		const wide = buildGraph([server("a", [session("s1")])], { widths: () => 999 });
		expect(wide.cards.get("v:a")!.w).toBe(CARD_W_MAX);
	});

	test("a pinned card stays where it was put", () => {
		const g = buildGraph([server("a", [session("s1")])], { pins: { "s:a/s1": { x: 5, y: 6 } } });
		expect([g.cards.get("s:a/s1")!.x, g.cards.get("s:a/s1")!.y]).toEqual([5, 6]);
	});

	test("a working chat over one branch pushes its neighbours away instead of covering them", () => {
		const sessions = [session("a", { updatedAt: 9 }), session("b", { parentId: "a", updatedAt: 8 }), session("c", { updatedAt: 7 }), session("d", { updatedAt: 6 })];
		const g = buildGraph([server("v", sessions, { states: { a: "working" } })]);
		const chats = [...g.cards.values()].filter((c) => c.kind === "session");
		for (const x of chats)
			for (const y of chats) {
				if (x === y || x.col !== y.col) continue;
				expect(x.y + x.h / 2 + ROW_GAP <= y.y - y.h / 2 || y.y + y.h / 2 + ROW_GAP <= x.y - x.h / 2).toBe(true);
			}
		const a = g.cards.get("s:v/a")!, b = g.cards.get("s:v/b")!;
		expect(a.h).toBe(CARD_H_LIVE);
		expect(b.y).toBe(a.y); // still centred on its branch
		expect(a.y - a.h / 2).toBe(0);
	});
});

describe("helpers", () => {
	test("isMouseWheel: a wheel zooms, two fingers on a trackpad scroll", () => {
		const w = (deltaY: number, o: { deltaX?: number; deltaMode?: number; wheelDeltaY?: number } = {}) => isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY, ...o });
		// Chrome / Safari with a mouse: whole 120 steps that are not -3× the pixel delta
		expect([w(100, { wheelDeltaY: -120 }), w(-100, { wheelDeltaY: 120 }), w(4, { wheelDeltaY: -120 })]).toEqual([true, true, true]);
		// a trackpad: wheelDeltaY is -3× deltaY, often sideways too
		expect([w(4, { wheelDeltaY: -12 }), w(40, { wheelDeltaY: -120 }), w(3, { deltaX: 2, wheelDeltaY: -9 })]).toEqual([false, false, false]);
		// Firefox: a wheel counts in lines; without the legacy delta a big whole step is a wheel
		expect([w(3, { deltaMode: 1 }), w(102), w(7), w(55.5)]).toEqual([true, true, false, false]);
	});
	test("modelName drops the provider", () => {
		expect([modelName("p/m"), modelName("p/org/m"), modelName("m")]).toEqual(["m", "org/m", "m"]);
	});
	test("related: tracks paths accurately across merged providers without spilling into other servers", () => {
		const g = buildGraph([
			server("a", [session("s1"), session("s2"), session("kid", { parentId: "s1" })], { runs: [run("s1", "explore")] }),
			server("b", [session("sb1")]),
		]);
		const r = related(g, "s:a/s1");
		expect(["v:a", pid("p"), mid("p", "m"), "s:a/kid", roleCardId("a", "explore", "p/m")].every((id) => r.has(id))).toBe(true);
		expect(r.has("s:a/s2")).toBe(false);
		expect(r.has("v:b")).toBe(false);
		expect(r.has("s:b/sb1")).toBe(false);
		// from the role's side: its callers and their line up to its server only
		const rr = related(g, roleCardId("a", "explore", "p/m"));
		expect(rr.has("v:a")).toBe(true);
		expect(rr.has("v:b")).toBe(false);
		// from the server side: only that server's own chats
		const rs = related(g, "v:a");
		expect(rs.has("s:a/s1") && rs.has(pid("p")) && !rs.has("s:b/sb1") && !rs.has("v:b")).toBe(true);
		// from the merged provider side: both servers and all chats under it
		const rp = related(g, pid("p"));
		expect(["v:a", "v:b", "s:a/s1", "s:b/sb1"].every((id) => rp.has(id))).toBe(true);
	});
	test("edgePath goes from the right edge to the left edge, or loops back out of the right side", () => {
		const a = { x: 0, y: 0, w: 100 } as never, b = { x: 300, y: 50, w: 100 } as never, same = { x: 0, y: 100, w: 100 } as never;
		expect(edgePath(a, b)).toStartWith("M50 0C");
		expect(edgePath(a, b)).toEndWith("248 50");
		expect(edgePath(a, same)).toEndWith("52 100");
		// the structure runs square through the middle of the gap, meeting the card's border
		const el = edgePath(a, b, 1, "elbow");
		expect(el).toStartWith("M50 0L");
		expect(el).toEndWith("L250 50");
		expect(el).toContain("150"); // the spine at the gap's middle (50 … 250)
		// two cards almost level: a soft step, never a hook past the ends
		const lv = edgePath(a, { x: 300, y: 3, w: 100 } as never, 1, "elbow");
		const xs = [...lv.matchAll(/-?[\d.]+ -?[\d.]+/g)].map((m) => +m[0].split(" ")[0]!);
		expect(Math.min(...xs)).toBeGreaterThanOrEqual(50);
		expect(Math.max(...xs)).toBeLessThanOrEqual(250);
	});
	test("fitView: centred in the view, never below 50%, never above 100%; nothing to show keeps 100%", () => {
		const g = buildGraph([server("a", [session("s1")])]);
		const big = fitView(g, 4000, 3000);
		expect(big.k).toBe(1);
		// the graph's middle lands on the view's middle, both ways
		expect(big.x + (g.width / 2) * big.k).toBeCloseTo(2000, 5);
		expect(big.y + (g.height / 2) * big.k).toBeCloseTo(1500, 5);
		expect(fitView(g, 300, 300).k).toBe(FIT_MIN);
		// too wide even at the floor: it starts at the left, the servers first
		expect(fitView(g, 300, 300).x).toBe(FIT_PAD.x);
		expect(fitView(buildGraph([]), 800, 600)).toEqual({ k: 1, x: FIT_PAD.x, y: FIT_PAD.y });
	});
	test("fitView: a graph that does not fit opens on the chats at work, never past its own ends", () => {
		const many = Array.from({ length: 40 }, (_, i) => session(`s${i}`));
		const g = buildGraph([server("a", many, { states: { s30: "working", s31: "asking" } })]);
		const focus = focusCards(g);
		expect(focus.sort()).toEqual(["s:a/s30", "s:a/s31"].sort());
		const w = 800, h = 600;
		const v = fitView(g, w, h, FIT_PAD, focus);
		expect(v.k).toBe(FIT_MIN);
		// both working chats are on screen, their middle on the view's middle (down) or as near as the graph's ends allow
		for (const id of focus) {
			const c = g.cards.get(id)!;
			expect(v.y + (c.y - c.h / 2) * v.k).toBeGreaterThanOrEqual(0);
			expect(v.y + (c.y + c.h / 2) * v.k).toBeLessThanOrEqual(h);
			expect(v.x + (c.x - c.w / 2) * v.k).toBeGreaterThanOrEqual(0);
			expect(v.x + (c.x + c.w / 2) * v.k).toBeLessThanOrEqual(w);
		}
		// nothing at work: as before (centred on the middle down, the servers first across)
		expect(fitView(g, w, h, FIT_PAD, [])).toEqual(fitView(g, w, h));
		// the first chat at work: the graph's top stays at the pad, not pulled down past it
		const top = buildGraph([server("a", many, { states: { s0: "working" } })]);
		expect(fitView(top, w, h, FIT_PAD, focusCards(top)).y).toBeCloseTo(FIT_PAD.y - Math.min(...[...top.cards.values()].map((c) => c.y - c.h / 2)) * FIT_MIN, 5);
		// a graph that fits keeps the whole of it centred, whatever is at work
		const small = buildGraph([server("a", [session("s1"), session("s2")], { states: { s2: "working" } })]);
		expect(fitView(small, 4000, 3000, FIT_PAD, focusCards(small))).toEqual(fitView(small, 4000, 3000));
	});
	test("edgeTip: where a call's chevron sits and which way it points", () => {
		const a = { x: 0, y: 0, w: 100 } as never, b = { x: 300, y: 50, w: 100 } as never;
		expect(edgeTip(a, b)).toEqual({ x: 248, y: 50, dir: 1 });
		expect(edgeTip(b, a)).toEqual({ x: 52, y: 0, dir: -1 });
	});
});

describe("springStep", () => {
	const run = (from: number, to: number, seconds: number, dt = 1 / 60) => {
		let [x, v] = [from, 0];
		const path: number[] = [];
		for (let t = 0; t < seconds; t += dt) {
			[x, v] = springStep(x, v, to, dt);
			path.push(x);
		}
		return { x, v, path };
	};
	test("settles on the target in about half a second, never past it", () => {
		const { x, path } = run(0, 100, 0.7);
		expect(Math.abs(x - 100)).toBeLessThan(0.5);
		expect(path.every((p) => p <= 100)).toBe(true);
		// it eases: each frame moves it closer, never back
		expect(path.every((p, i) => i === 0 || p >= path[i - 1]!)).toBe(true);
	});
	test("one long frame lands where many small frames do (exact, not stepped)", () => {
		const fine = run(0, 100, 0.2, 1 / 240).x;
		const [coarse] = springStep(0, 0, 100, 0.2);
		expect(Math.abs(fine - coarse)).toBeLessThan(0.5);
	});
	test("at the target and still, it stays", () => {
		expect(springStep(42, 0, 42, 0.1)).toEqual([42, 0]);
	});
});

describe("growth", () => {
	const T = { lead: 80, draw: 380 };
	const g1 = buildGraph([server("v", [session("a", { provider: "cliproxy", model: "opus" })], { states: { a: "working" } })]);
	test("on an empty screen a branch grows column by column, each card as its line reaches it", () => {
		const p = growthPlan(g1, () => undefined, () => false, 1000, T);
		const at = (id: string) => p.cards.get(id)!;
		expect(at("v:v")).toBe(1000);
		expect(at(pid("cliproxy"))).toBe(1000 + 80 + 380);
		expect(at(mid("cliproxy", "opus"))).toBe(at(pid("cliproxy")) + 80 + 380);
		expect(at("s:v/a")).toBe(at(mid("cliproxy", "opus")) + 80 + 380);
		// every line starts a moment after the card it leaves, and ends as the next one appears
		for (const e of g1.edges) expect(p.edges.get(e.id)! + T.draw).toBe(at(e.to));
	});
	test("a new chat on a known model grows only from there", () => {
		const g2 = buildGraph([server("v", [session("a", { provider: "cliproxy", model: "opus" }), session("b", { provider: "cliproxy", model: "opus" })], { states: { a: "working" } })]);
		const p = growthPlan(g2, (id) => (g1.cards.has(id) ? 0 : undefined), (id) => g1.edges.some((e) => e.id === id), 5000, T);
		expect([...p.cards.keys()]).toEqual(["s:v/b"]);
		expect([...p.edges.keys()]).toEqual(["t:s:v/b"]);
		expect(p.edges.get("t:s:v/b")).toBe(5000);
		expect(p.cards.get("s:v/b")).toBe(5000 + 380);
	});
	test("leaving runs right to left: the line pulls back after the card at its end has faded", () => {
		const L = { fade: 200, retract: 260 };
		const gone = new Set([mid("cliproxy", "opus"), "s:v/a"]);
		const edges = g1.edges.filter((e) => gone.has(e.to));
		const p = leavePlan(gone, edges, 0, L);
		expect(p.cards.get("s:v/a")).toBe(0);
		expect(p.edges.get("t:s:v/a")).toBe(200);
		expect(p.cards.get(mid("cliproxy", "opus"))).toBe(200 + 260);
		expect(p.edges.get(`t:${mid("cliproxy", "opus")}`)).toBe(200 + 260 + 200);
	});
	test("a cut-short curve starts where the whole one does and ends on it", () => {
		const a = g1.cards.get("v:v")!, b = g1.cards.get(pid("cliproxy"))!;
		const full = edgePath(a, b), half = edgePath(a, b, 0.5), none = edgePath(a, b, 0);
		expect(half.split("C")[0]).toBe(full.split("C")[0]);
		expect(half).not.toBe(full);
		const end = (d: string) => d.split(" ").slice(-2).map(Number);
		expect(end(none)).toEqual([a.x + a.w / 2, a.y]);
		expect(edgePath(a, b, 1)).toBe(full);
	});
});

describe("many chats", () => {
	const many = (n: number, over: Partial<GraphServer> = {}) => server("a", Array.from({ length: n }, (_, i) => session(`s${i}`, { updatedAt: 100 - i })), over);
	test("a short list stays one column", () => {
		const g = buildGraph([many(5)], { lanes: 4 });
		expect(new Set([...g.cards.values()].filter((c) => c.kind === "session").map((c) => c.col))).toEqual(new Set([3]));
	});
	test("many chats under one model wrap into columns, filled top to bottom, rows lined up", () => {
		const g = buildGraph([many(12)], { lanes: 3 });
		const chats = [...g.cards.values()].filter((c) => c.kind === "session");
		expect(new Set(chats.map((c) => c.col))).toEqual(new Set([3, 4, 5]));
		// the first column keeps the order: the newest four, top to bottom
		const first = chats.filter((c) => c.col === 3).sort((x, y) => x.y - y.y).map((c) => c.id);
		expect(first).toEqual(["s:a/s0", "s:a/s1", "s:a/s2", "s:a/s3"]);
		// the same row is the same height across columns, and nothing overlaps
		const row = (id: string) => g.cards.get(id)!.y;
		expect(row("s:a/s4")).toBe(row("s:a/s0"));
		expect(row("s:a/s8")).toBe(row("s:a/s0"));
		// later columns are reached along a bus above the block; the first column directly
		expect(g.cards.get("s:a/s0")!.bus).toBeUndefined();
		const b = g.cards.get("s:a/s5")!.bus!;
		expect(g.cards.get("s:a/s5")!.y + b.dy).toBeLessThan(Math.min(...chats.map((c) => c.y - c.h / 2)));
		// a wrapped block is far shorter than a single column
		expect(g.height).toBeLessThan(buildGraph([many(12)], { lanes: 1 }).height / 2);
	});
	test("a chat that calls subagents goes to the last column, nearest them", () => {
		const g = buildGraph([many(9, { runs: [run("s0", "explore")] })], { lanes: 3 });
		const chats = [...g.cards.values()].filter((c) => c.kind === "session");
		expect(g.cards.get("s:a/s0")!.col).toBe(Math.max(...chats.map((c) => c.col)));
	});
	test("fitGraph wraps only when that shows the graph larger", () => {
		const cols = (g: ReturnType<typeof buildGraph>) => new Set([...g.cards.values()].filter((c) => c.kind === "session").map((c) => c.col)).size;
		// a wide, short view and many chats: wrapped
		expect(cols(fitGraph([many(30)], {}, 1600, 800))).toBeGreaterThan(1);
		// a few chats fit anyway: one column
		expect(cols(fitGraph([many(6)], {}, 1600, 800))).toBe(1);
		// a narrow view gains nothing from going wider
		expect(cols(fitGraph([many(30)], {}, 400, 2000))).toBe(1);
		// never wider than the view at the floor: everything on the right stays in view
		for (const [w, h] of [[1152, 847], [820, 1127], [1600, 800]] as const) {
			const g = fitGraph([many(30)], {}, w, h);
			expect(g.width * FIT_MIN).toBeLessThanOrEqual(w - FIT_PAD.x * 2);
		}
	});
	test("a routed line ends level on its card, from the bus, without crossing its column", () => {
		const g = buildGraph([many(12)], { lanes: 3 });
		const m = g.cards.get(mid("p", "m"))!, c = g.cards.get("s:a/s9")!;
		const d = edgePath(m, c, 1, "elbow");
		expect(d).toEndWith(`L${c.x - c.w / 2} ${c.y}`);
		expect(d).toContain(` ${c.y + c.bus!.dy}`);
	});
});

describe("sparks", () => {
	test("an even speed: a longer line takes longer and carries more sparks, within bounds", () => {
		const short = sparkPlan(120, false), long = sparkPlan(520, false);
		expect(long.dur).toBeGreaterThan(short.dur);
		expect(long.n).toBeGreaterThan(short.n);
		expect(sparkPlan(5000, false)).toEqual({ n: 4, dur: 4.2 });
		expect(sparkPlan(10, false)).toEqual({ n: 1, dur: 1.6 });
		// a call is quicker than work on the structure, and always shows at least two
		expect(sparkPlan(300, true).dur).toBeLessThan(sparkPlan(300, false).dur);
		expect(sparkPlan(10, true).n).toBe(2);
	});
	test("durations are rounded: a card easing a few px does not change them", () => {
		expect(sparkPlan(300, false)).toEqual(sparkPlan(303, false));
	});
	test("edgeLength matches the drawn line", () => {
		const a = { x: 0, y: 0, w: 100 } as never, b = { x: 300, y: 0, w: 100 } as never;
		expect(edgeLength(a, b, "elbow")).toBeCloseTo(200, 3);
	});
});

describe("fitGraph widths", () => {
	const srv = (n: number): GraphServer => ({
		id: "a", name: "a", host: "a.local", online: true, activity: () => "idle", queued: () => 0, runs: null,
		sessions: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `s${i}`, name: `s${i}`, purpose: "", cwd: "/w", provider: "p", model: `m${i}`, thinkingLevel: "off", systemPrompt: "", tools: [], parentId: null, closed: false, createdAt: 1, updatedAt: 1 }) as never),
	});
	test("long names widen columns only as far as the whole graph still fits the view at the smallest zoom", () => {
		const wide = () => 999;
		const roomy = fitGraph([srv(1)], { widths: wide }, 5000, 900);
		expect(roomy.cards.get("v:a")!.w).toBe(CARD_W_MAX);
		// server, provider, model, chat: 4 columns of 400 + 3 gaps = 1792 at 100%, 896 at 50%: too wide for an 800 view
		const g = fitGraph([srv(1)], { widths: wide }, 800, 900);
		expect(g.width * FIT_MIN).toBeLessThanOrEqual(800 - FIT_PAD.x * 2);
		expect(g.cards.get("v:a")!.w).toBeLessThan(CARD_W_MAX);
		expect(g.cards.get("v:a")!.w).toBeGreaterThanOrEqual(272);
	});
	test("a view too narrow for the plain widths keeps the full room (it pans anyway)", () => {
		const g = fitGraph([srv(1)], { widths: () => 999 }, 390, 844);
		expect(g.cards.get("v:a")!.w).toBe(CARD_W_MAX);
	});
});
