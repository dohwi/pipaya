import { describe, expect, test } from "bun:test";
import { quickItems } from "../src/lib/graph-quick";

const m = (seq: number, message: unknown) => ({ seq, message, createdAt: seq }) as never;
const user = (seq: number, text: string) => m(seq, { role: "user", content: [{ type: "text", text }] });
const asst = (seq: number, ...content: unknown[]) => m(seq, { role: "assistant", content });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
const text = (t: string) => ({ type: "text", text: t });
const result = (seq: number, id: string, out: string, over: Record<string, unknown> = {}) =>
	m(seq, { role: "toolResult", toolCallId: id, content: [{ type: "text", text: out }], ...over });

describe("quickItems", () => {
	test("the tool calls between two texts are one work box, across the model calls of a turn", () => {
		const items = quickItems([
			user(1, "고쳐 줘"),
			asst(2, text("먼저 봅니다"), call("a", "read", { path: "x.ts" })),
			result(3, "a", "file body", { durationMs: 12 }),
			asst(4, call("b", "bash", { command: "ls" })),
			result(5, "b", "boom", { isError: true }),
			asst(6, text("고쳤습니다")),
		]);
		expect(items.map((i) => i.kind)).toEqual(["user", "agent", "work", "agent"]);
		const work = items[2] as Extract<(typeof items)[number], { kind: "work" }>;
		expect(work.steps.map((s) => [s.name, s.state, s.output])).toEqual([
			["read", "done", "file body"],
			["bash", "error", "boom"],
		]);
		expect(work.steps[0]!.durationMs).toBe(12);
	});

	test("a call with no result yet is pending; an exit code is kept", () => {
		const items = quickItems([asst(1, call("a", "bash")), result(2, "a", "", { details: { exitCode: 2 } }), asst(3, call("b", "bash"))]);
		const steps = (items[0] as { steps: { state: string; exitCode?: number }[] }).steps;
		expect(steps.map((s) => [s.state, s.exitCode])).toEqual([["done", 2], ["pending", undefined]]);
	});

	test("text after a tool starts a new reply; empty texts, thinking and stray results add nothing", () => {
		const items = quickItems([
			asst(1, { type: "thinking", thinking: "hmm" }, text("  "), call("a", "ls"), text("하나"), text("둘"), call("b", "ls")),
			result(2, "zzz", "lost"),
		]);
		expect(items.map((i) => (i.kind === "work" ? `work:${i.steps.length}` : `${i.kind}:${i.text}`))).toEqual(["work:1", "agent:하나\n\n둘", "work:1"]);
	});
});
