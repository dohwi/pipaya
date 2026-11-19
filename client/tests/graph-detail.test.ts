import { describe, expect, test } from "bun:test";
import { buildGraph, type DelegateRun, type GraphServer } from "../src/lib/graph";
import { callState, roleStats, splitLive, under } from "../src/lib/graph-detail";
import type { Session } from "../src/lib/types";

const session = (id: string, over: Partial<Session> = {}): Session =>
	({ id, title: id, name: id, purpose: "", cwd: "/w", provider: "p", model: "m", thinkingLevel: "off", systemPrompt: "", tools: [], parentId: null, closed: false, createdAt: 1, updatedAt: 1, ...over }) as Session;
const run = (sessionId: string, role: string, over: Partial<DelegateRun> = {}): DelegateRun =>
	({ sessionId, callId: `${sessionId}-${role}-${Math.random()}`, role, free: false, asked: null, model: "p/m", at: 1, doneAt: 2, running: false, error: false, turns: 1, tokens: 10, ...over });
const server = (id: string, sessions: Session[], runs: DelegateRun[] = []): GraphServer => ({
	id, name: id, host: `${id}.local`, online: true, sessions, activity: () => "idle", queued: () => 0, runs,
});

describe("under", () => {
	test("lists the chats below a card, branched ones included, and stops at its own subtree", () => {
		const g = buildGraph([server("a", [session("s1"), session("s2", { parentId: "s1" }), session("s3", { model: "m2" }), session("s4", { provider: "q" })])]);
		expect(under(g, "v:a", "session").map((c) => c.session!.id).sort()).toEqual(["s1", "s2", "s3", "s4"]);
		expect(under(g, "p:a/p", "session").map((c) => c.session!.id).sort()).toEqual(["s1", "s2", "s3"]);
		expect(under(g, "m:a/p/m", "session").map((c) => c.session!.id).sort()).toEqual(["s1", "s2"]);
		expect(under(g, "p:a/p", "model").map((c) => c.id).sort()).toEqual(["m:a/p/m", "m:a/p/m2"]);
		expect(under(g, "v:a", "provider").map((c) => c.id).sort()).toEqual(["p:a/p", "p:a/q"]);
		expect(under(g, "nope", "session")).toEqual([]);
	});
});

describe("roleStats", () => {
	test("counts only the role's calls from open chats, newest first", () => {
		const runs = [
			run("s1", "explore", { at: 10, doneAt: 1010, tokens: 100, turns: 2 }),
			run("s2", "explore", { at: 30, doneAt: null, running: true, tokens: null, turns: null }),
			run("s1", "explore", { at: 20, doneAt: 3020, error: true, tokens: 50, turns: 1 }),
			run("gone", "explore", { at: 40 }),
			run("s1", "runner", { at: 50 }),
		];
		const st = roleStats(runs, "explore", (sid) => sid !== "gone");
		expect(st.calls).toBe(3);
		expect(st.running).toBe(1);
		expect(st.failed).toBe(1);
		expect(st.tokens).toBe(150);
		expect(st.turns).toBe(3);
		expect(st.avgMs).toBe(2000); // (1000 + 3000) / 2; the running call is left out
		// the running call leads on its own; the rest are the recent ones
		expect(st.active.map((r) => r.at)).toEqual([30]);
		expect(st.recent.map((r) => r.at)).toEqual([20, 10]);
		expect(st.callers).toEqual([{ sessionId: "s2", n: 1, last: 30 }, { sessionId: "s1", n: 2, last: 20 }]);
	});

	test("keeps the newest `limit` finished calls, every running one, and no average without a finished call", () => {
		const runs = Array.from({ length: 5 }, (_, i) => run("s", "r", { at: i, doneAt: null, running: true }));
		const st = roleStats([...runs, ...runs.map((r) => ({ ...r, callId: `${r.callId}-cut`, running: false }))], "r", () => true, 2);
		expect(st.active.map((r) => r.at)).toEqual([4, 3, 2, 1, 0]);
		expect(st.recent.map((r) => r.at)).toEqual([4, 3]);
		expect(st.avgMs).toBeNull();
	});

	test("callState tells running, failed, cut off and done apart", () => {
		expect(callState(run("s", "r", { running: true, doneAt: null }))).toBe("running");
		expect(callState(run("s", "r", { error: true }))).toBe("failed");
		expect(callState(run("s", "r", { doneAt: null }))).toBe("cut");
		expect(callState(run("s", "r"))).toBe("done");
	});
});

describe("splitLive", () => {
	test("puts the chats at work or waiting on the user first, in order, and keeps the rest", () => {
		const state: Record<string, "working" | "asking" | "done" | "idle"> = { s1: "idle", s2: "working", s3: "done", s4: "asking" };
		const g = buildGraph([{ ...server("a", ["s1", "s2", "s3", "s4"].map((id) => session(id))), activity: (id) => state[id]! }]);
		const { live, rest } = splitLive(under(g, "v:a", "session"));
		expect(live.map((c) => c.session!.id).sort()).toEqual(["s2", "s4"]);
		expect(rest.map((c) => c.session!.id).sort()).toEqual(["s1", "s3"]);
	});
});
