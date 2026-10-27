import { describe, expect, test } from "bun:test";
import { afterTurn, callSignature, runawayReason, type RunGuardState } from "../src/run-guard.ts";

const limits = { maxTurns: 5, maxRepeated: 3 };
const call = (name: string, args: unknown) => ({ type: "toolCall", name, arguments: args });
const fresh: RunGuardState = { turns: 0, recentCalls: [] };

describe("run guard", () => {
	test("a turn's calls are compared regardless of their order", () => {
		expect(callSignature([call("a", { x: 1 }), call("b", {})])).toBe(callSignature([call("b", {}), call("a", { x: 1 })]));
		expect(callSignature([{ type: "text", text: "hi" }])).toBe("");
		expect(callSignature("not blocks")).toBe("");
		expect(callSignature([call("a", { x: 1 })])).not.toBe(callSignature([call("a", { x: 2 })]));
	});

	test("the same call turn after turn stops the run at the limit, not before", () => {
		let s = fresh;
		for (let i = 0; i < 2; i++) {
			s = afterTurn(s, [call("read", { path: "a" })], limits);
			expect(runawayReason(s, limits)).toBeNull();
		}
		s = afterTurn(s, [call("read", { path: "a" })], limits);
		expect(runawayReason(s, limits)).toBe("Stopped: the same tool call was repeated 3 times in a row.");
	});

	test("a different call or a plain answer breaks the streak", () => {
		let s = fresh;
		for (const c of [call("read", { path: "a" }), call("read", { path: "a" }), call("read", { path: "b" }), call("read", { path: "a" })]) s = afterTurn(s, [c], limits);
		expect(runawayReason(s, limits)).toBeNull();
		s = afterTurn(s, [{ type: "text", text: "done" }], limits);
		expect(s.recentCalls).toEqual([]);
	});

	test("too many model calls stop the run even when each call is different", () => {
		let s = fresh;
		for (let i = 0; i < 4; i++) s = afterTurn(s, [call("t", { i })], limits);
		expect(runawayReason(s, limits)).toBeNull();
		s = afterTurn(s, [call("t", { i: 4 })], limits);
		expect(runawayReason(s, limits)).toBe("Stopped after 5 model calls in one run. Send a message to continue.");
	});

	test("the history never grows past the repeat window", () => {
		let s = fresh;
		for (let i = 0; i < 10; i++) s = afterTurn(s, [call("t", { i })], { maxTurns: 99, maxRepeated: 3 });
		expect(s.recentCalls).toHaveLength(3);
		expect(s.turns).toBe(10);
	});
});
