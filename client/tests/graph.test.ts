import { describe, expect, test } from "bun:test";
import { BAND_GAP, buildGraph, CARD_W_MAX, isMouseWheel, springStep, CARD_H, CARD_H_LIVE, edgeLength, edgePath, edgeTip, sparkPlan, fitGraph, fitView, focusCards, FIT_MIN, FIT_PAD, growthPlan, leavePlan, modelName, related, type DelegateRun, type GraphServer } from "../src/lib/graph";
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
	test("providers, models and a role's models read by the names the owner gave them; ids stay the keys", () => {
		const names: Record<string, string> = { "p/m": "Fast model", "p/sub": "Helper model" };
		const g = buildGraph([server("a", [session("s1"), session("s2", { model: "m2" })], {
			runs: [run("s1", "explore", { model: "p/sub" }), run("s1", "explore", { model: "q/raw" })],
			modelName: (provider, id) => names[`${provider}/${id}`] ?? id,
			providerName: (id) => (id === "p" ? "My Proxy" : id),
		})]);
		expect(g.cards.get("p:a/p")!.label).toBe("p");
		expect(g.cards.get("p:a/p")!.name).toBe("My Proxy");
		expect(g.cards.get("m:a/p/m")!.name).toBe("Fast model");
		expect(g.cards.get("m:a/p/m2")!.name).toBe("m2"); // no name given: the id
		expect(g.cards.get("r:a/explore")!.models!.map((m) => [m.model, m.name]).sort()).toEqual([["p/sub", "Helper model"], ["q/raw", "raw"]]);
		expect(g.cards.get("v:a")!.name).toBe("a");
	});

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

	test("one width per column: a measured long name widens its whole column, up to CARD_W_MAX", () => {
		const g = buildGraph([server("a", [session("s1", { model: "a-very-long-model-id" }), session("s2")])], { widths: (c) => (c.label.length > 10 ? 300 : 0) });
		expect(g.cards.get("m:a/p/a-very-long-model-id")!.w).toBe(300);
		expect(g.cards.get("m:a/p/m")!.w).toBe(300);
		const wide = buildGraph([server("a", [session("s1")])], { widths: () => 999 });
		expect(wide.cards.get("v:a")!.w).toBe(CARD_W_MAX);
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
		expect(at("p:v/cliproxy")).toBe(1000 + 80 + 380);
		expect(at("m:v/cliproxy/opus")).toBe(at("p:v/cliproxy") + 80 + 380);
		expect(at("s:v/a")).toBe(at("m:v/cliproxy/opus") + 80 + 380);
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
		const gone = new Set(["m:v/cliproxy/opus", "s:v/a"]);
		const edges = g1.edges.filter((e) => gone.has(e.to));
		const p = leavePlan(gone, edges, 0, L);
		expect(p.cards.get("s:v/a")).toBe(0);
		expect(p.edges.get("t:s:v/a")).toBe(200);
		expect(p.cards.get("m:v/cliproxy/opus")).toBe(200 + 260);
		expect(p.edges.get("t:m:v/cliproxy/opus")).toBe(200 + 260 + 200);
	});
	test("a cut-short curve starts where the whole one does and ends on it", () => {
		const a = g1.cards.get("v:v")!, b = g1.cards.get("p:v/cliproxy")!;
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
		const m = g.cards.get("m:a/p/m")!, c = g.cards.get("s:a/s9")!;
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
