import { describe, expect, test } from "bun:test";
import { BAND_GAP, buildGraph, isMouseWheel, springStep, CARD_H, CARD_H_LIVE, edgePath, fitView, modelName, related, type DelegateRun, type GraphServer } from "../src/lib/graph";
import type { Activity } from "../src/lib/activity";
import type { Session } from "../src/lib/types";

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
	test("server → provider → model → chat, with counts on every hub", () => {
		const g = buildGraph([server("a", [session("s1"), session("s2", { model: "m2" }), session("s3", { provider: "q" })])]);
		const kinds = (k: string) => [...g.cards.values()].filter((c) => c.kind === k).map((c) => c.id).sort();
		expect(kinds("server")).toEqual(["v:a"]);
		expect(kinds("provider")).toEqual(["p:a/p", "p:a/q"]);
		expect(kinds("model")).toEqual(["m:a/p/m", "m:a/p/m2", "m:a/q/m"]);
		expect(g.cards.get("v:a")!.count).toBe(3);
		expect(g.cards.get("p:a/p")!.count).toBe(2);
		expect([g.cards.get("v:a")!.col, g.cards.get("p:a/p")!.col, g.cards.get("m:a/p/m")!.col, g.cards.get("s:a/s1")!.col]).toEqual([0, 1, 2, 3]);
		// a hub sits in the middle of what is under it
		const p = g.cards.get("p:a/p")!, m1 = g.cards.get("m:a/p/m")!, m2 = g.cards.get("m:a/p/m2")!;
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
		expect(g.edges.find((e) => e.to === "s:a/orphan")!.from).toBe("m:a/p/m");
		expect(g.edges.find((e) => e.to === "s:a/self")!.from).toBe("m:a/p/m");
	});

	test("chats that want the user come first; a working chat is taller and lights its line to the server", () => {
		const states: Record<string, Activity> = { idle: "idle", ask: "asking", work: "working", fail: "failed" };
		const g = buildGraph([server("a", [session("idle"), session("ask"), session("work"), session("fail")], { states })]);
		const ys = ["ask", "fail", "work", "idle"].map((id) => g.cards.get(`s:a/${id}`)!.y);
		expect([...ys].sort((x, y) => x - y)).toEqual(ys);
		expect(g.cards.get("s:a/work")!.h).toBe(CARD_H_LIVE);
		expect(g.cards.get("s:a/idle")!.h).toBe(CARD_H);
		expect(["v:a", "p:a/p", "m:a/p/m"].every((id) => g.cards.get(id)!.live)).toBe(true);
		expect(g.edges.find((e) => e.to === "s:a/work")!.live).toBe(true);
		expect(g.edges.find((e) => e.to === "s:a/idle")!.live).toBe(false);
	});

	test("subagents: one card per role per server, newest model first, free, asked and running counted; one edge per chat and role", () => {
		const runs = [
			run("s1", "explore", { model: "p/old", at: 1 }),
			run("s1", "explore", { model: "p/new", at: 5, asked: "p/new" }),
			run("s2", "explore", { model: "p/new", at: 3, running: true, doneAt: null }),
			run("s2", "adhoc", { free: true }),
			run("closed", "explore"),
		];
		const g = buildGraph([server("a", [session("s1"), session("s2")], { runs })]);
		const r = g.cards.get("r:a/explore")!;
		expect(r).toMatchObject({ kind: "subagent", count: 3, running: 1, asked: 1, free: false, live: true });
		expect(r.models!.map((m) => [m.model, m.n])).toEqual([["p/new", 2], ["p/old", 1]]);
		expect(g.cards.get("r:a/adhoc")!.free).toBe(true);
		const del = g.edges.filter((e) => e.kind === "delegate");
		expect(del.map((e) => [e.from, e.to, e.weight, e.live]).sort()).toEqual([
			["s:a/s1", "r:a/explore", 2, false],
			["s:a/s2", "r:a/adhoc", 1, false],
			["s:a/s2", "r:a/explore", 1, true],
		].sort());
		// the subagents form the last column, without overlapping
		const roles = [...g.cards.values()].filter((c) => c.kind === "subagent").sort((x, y) => x.y - y.y);
		expect(roles.every((c) => c.col === g.cols.length - 1)).toBe(true);
		expect(roles[1]!.y - roles[0]!.y).toBeGreaterThanOrEqual(CARD_H);
	});

	test("a server without the delegate route shows its chats and no subagents", () => {
		const g = buildGraph([server("a", [session("s1")], { runs: null })]);
		expect([...g.cards.values()].some((c) => c.kind === "subagent")).toBe(false);
	});

	test("two servers: hubs are per server, one frame each, the second below the first", () => {
		const g = buildGraph([server("a", [session("s1")]), server("b", [session("s1")])]);
		expect(g.cards.has("p:a/p") && g.cards.has("p:b/p")).toBe(true);
		expect(g.bands.map((b) => b.server)).toEqual(["a", "b"]);
		expect(g.bands[1]!.y0 - g.bands[0]!.y1).toBe(BAND_GAP);
	});

	test("one width per column: a measured long name widens its whole column, up to 320", () => {
		const g = buildGraph([server("a", [session("s1", { model: "a-very-long-model-id" }), session("s2")])], { widths: (c) => (c.label.length > 10 ? 300 : 0) });
		expect(g.cards.get("m:a/p/a-very-long-model-id")!.w).toBe(300);
		expect(g.cards.get("m:a/p/m")!.w).toBe(300);
		const wide = buildGraph([server("a", [session("s1")])], { widths: () => 999 });
		expect(wide.cards.get("v:a")!.w).toBe(320);
	});

	test("a pinned card stays where it was put", () => {
		const g = buildGraph([server("a", [session("s1")])], { pins: { "s:a/s1": { x: 5, y: 6 } } });
		expect([g.cards.get("s:a/s1")!.x, g.cards.get("s:a/s1")!.y]).toEqual([5, 6]);
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
	test("related: a chat brings its line to the server, the chats it started and the roles it called", () => {
		const g = buildGraph([server("a", [session("s1"), session("s2"), session("kid", { parentId: "s1" })], { runs: [run("s1", "explore")] })]);
		const r = related(g, "s:a/s1");
		expect(["v:a", "p:a/p", "m:a/p/m", "s:a/kid", "r:a/explore"].every((id) => r.has(id))).toBe(true);
		expect(r.has("s:a/s2")).toBe(false);
		// from the role's side: its callers and their line up
		expect(related(g, "r:a/explore").has("v:a")).toBe(true);
	});
	test("edgePath goes from the right edge to the left edge, or loops back out of the right side", () => {
		const a = { x: 0, y: 0, w: 100 } as never, b = { x: 300, y: 50, w: 100 } as never, same = { x: 0, y: 100, w: 100 } as never;
		expect(edgePath(a, b)).toStartWith("M50 0C");
		expect(edgePath(a, b)).toEndWith("248 50");
		expect(edgePath(a, same)).toEndWith("52 100");
	});
	test("fitView: every column across, never below 60%, never above 100%; nothing to show keeps 100%", () => {
		const g = buildGraph([server("a", [session("s1")])]);
		expect(fitView(g, 4000, 3000).k).toBe(1);
		expect(fitView(g, 300, 300).k).toBe(0.6);
		expect(fitView(buildGraph([]), 800, 600)).toEqual({ k: 1, x: 24, y: 24 });
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
