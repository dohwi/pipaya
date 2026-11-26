import { describe, expect, test } from "bun:test";
import { canContinueRun, hasUnansweredPrompt, plainTextOf, replyActions, segmentsOf } from "../src/lib/reply-blocks";
import type { AssistantBlock, StopReason } from "../src/lib/types";

const text = (t: string): AssistantBlock => ({ type: "text", text: t });
const think = (t: string): AssistantBlock => ({ type: "thinking", text: t, done: true });
const tool = (id: string): AssistantBlock => ({ type: "tool", id, name: "read", args: {} });

describe("segmentsOf", () => {
	test("thoughts and tool calls between texts share one work box", () => {
		const segs = segmentsOf([think("a"), tool("1"), text("hi"), tool("2")], false);
		expect(segs.map((s) => s.kind)).toEqual(["work", "text", "work"]);
		expect(segs[0]).toMatchObject({ i: 0 });
		expect((segs[0] as { steps: unknown[] }).steps).toHaveLength(2);
		expect(segs[1]).toMatchObject({ kind: "text", text: "hi", i: 2 });
	});
	test("keys are the block indexes, so they stay put as the reply grows", () => {
		const before = segmentsOf([text("a")], true).map((s) => s.i);
		const after = segmentsOf([text("a"), tool("1")], true).map((s) => s.i);
		expect(after.slice(0, 1)).toEqual(before);
	});
	test("a live reply with nothing yet shows an empty work box; a finished one shows nothing", () => {
		expect(segmentsOf([], true)).toEqual([{ kind: "work", steps: [], i: -1 }]);
		expect(segmentsOf([], false)).toEqual([]);
	});
	test("given the last result, segments that did not change come back as the same objects", () => {
		const blocks = [think("a"), tool("1"), text("hi"), tool("2"), text("wr")];
		const first = segmentsOf(blocks, true);
		blocks[4] = text("writing");
		const next = segmentsOf(blocks, true, first);
		expect(next[0]).toBe(first[0]!);
		expect(next[1]).toBe(first[1]!);
		expect(next[2]).toBe(first[2]!);
		expect(next[3]).not.toBe(first[3]!);
		expect(next[3]).toEqual({ kind: "text", text: "writing", i: 4 });
		expect(next).toEqual(segmentsOf(blocks, true));
	});
	test("a work box that gained a step, or whose thought or call changed, is a new object", () => {
		const args = { path: "a" };
		const blocks: AssistantBlock[] = [{ type: "thinking", text: "a", done: false }, { type: "tool", id: "1", name: "read", args }];
		const first = segmentsOf(blocks, true);
		expect(segmentsOf(blocks, true, first)[0]).toBe(first[0]!);
		const grown = segmentsOf([...blocks, tool("2")], true, first);
		expect(grown[0]).not.toBe(first[0]!);
		expect((grown[0] as { steps: unknown[] }).steps).toHaveLength(3);
		expect(segmentsOf([{ type: "thinking", text: "a", done: true }, blocks[1]!], true, first)[0]).not.toBe(first[0]!);
		expect(segmentsOf([{ type: "thinking", text: "ab", done: false }, blocks[1]!], true, first)[0]).not.toBe(first[0]!);
		expect(segmentsOf([blocks[0]!, { type: "tool", id: "1", name: "read", args: { path: "a" } }], true, first)[0]).not.toBe(first[0]!);
	});
	test("a segment is reused only in its own place: a reply that shrank or changed shape gets fresh ones", () => {
		const first = segmentsOf([text("a"), tool("1")], false);
		const other = segmentsOf([tool("1"), text("a")], false, first);
		expect(other[0]).not.toBe(first[0]!);
		expect(other[1]).not.toBe(first[1]!);
		expect(segmentsOf([], true, first)).toEqual([{ kind: "work", steps: [], i: -1 }]);
	});
});

describe("plainTextOf", () => {
	test("only text blocks, a blank line apart", () => {
		expect(plainTextOf([think("x"), text("one"), tool("1"), text("two")])).toBe("one\n\ntwo");
		expect(plainTextOf([tool("1")])).toBe("");
	});
});

describe("replyActions", () => {
	const r = (stopReason: StopReason) => ({ stopReason });
	const none = { retry: false, cut: false, resume: false, interrupt: null };

	test("a reply the output limit cut off says so, and only the newest one offers to go on", () => {
		expect(replyActions(r("length"), true, false)).toEqual({ retry: false, cut: true, resume: true, interrupt: "cut" });
		expect(replyActions(r("length"), false, false)).toEqual({ retry: false, cut: true, resume: false, interrupt: "cut" });
		expect(replyActions(r("length"), true, false, false)).toEqual({ retry: false, cut: true, resume: false, interrupt: "cut" });
	});
	test("a failed or stopped reply reports its interrupt state, and only the newest one offers retry", () => {
		expect(replyActions(r("error"), true, false)).toEqual({ retry: true, cut: false, resume: false, interrupt: "error" });
		expect(replyActions(r("error"), false, false)).toEqual({ retry: false, cut: false, resume: false, interrupt: "error" });
		expect(replyActions(r("error"), true, false, false)).toEqual({ retry: false, cut: false, resume: false, interrupt: "error" });
		expect(replyActions(r("aborted"), true, false)).toEqual({ retry: true, cut: false, resume: false, interrupt: "aborted" });
		expect(replyActions(r("aborted"), false, false)).toEqual({ retry: false, cut: false, resume: false, interrupt: "aborted" });
	});
	test("a trailing toolUse turn with no follow-up is marked incomplete and retryable only on the last turn", () => {
		expect(replyActions(r("toolUse"), true, false)).toEqual({ retry: true, cut: false, resume: false, interrupt: "incomplete" });
		expect(replyActions(r("toolUse"), false, false)).toEqual(none);
		expect(replyActions(r("toolUse"), true, true)).toEqual(none);
		expect(replyActions(r("toolUse"), true, false, false)).toEqual({ retry: false, cut: false, resume: false, interrupt: "incomplete" });
	});
	test("a reply still being written, a finished one and no reply at all offer nothing", () => {
		expect(replyActions(r("length"), true, true)).toEqual(none);
		expect(replyActions(r("error"), true, true)).toEqual(none);
		for (const s of ["stop", "pending", "deferred"] as const) expect(replyActions(r(s), true, false), s).toEqual(none);
		expect(replyActions(undefined, true, false)).toEqual(none);
	});
});

describe("canContinueRun & hasUnansweredPrompt", () => {
	const idle = { ready: true, running: false, retrying: false, compacting: false, closed: false };
	test("only an idle, open, ready session can continue", () => {
		expect(canContinueRun(idle)).toBe(true);
		expect(canContinueRun({ ...idle, ready: false })).toBe(false);
		expect(canContinueRun({ ...idle, running: true })).toBe(false);
		expect(canContinueRun({ ...idle, retrying: true })).toBe(false);
		expect(canContinueRun({ ...idle, compacting: true })).toBe(false);
		expect(canContinueRun({ ...idle, closed: true })).toBe(false);
	});
	test("detects persisted user prompt with no reply, including seq 0, and ignores optimistic/sending/unsettled states", () => {
		expect(hasUnansweredPrompt({ kind: "user", seq: 0 }, true, false, true)).toBe(true);
		expect(hasUnansweredPrompt({ kind: "user", seq: 5 }, true, false, true)).toBe(true);
		expect(hasUnansweredPrompt({ kind: "user", seq: 0 }, true, false, false)).toBe(false);
		expect(hasUnansweredPrompt({ kind: "user", seq: null }, true, false, true)).toBe(false);
		expect(hasUnansweredPrompt({ kind: "user", seq: 0 }, true, true, true)).toBe(false);
		expect(hasUnansweredPrompt({ kind: "user", seq: 0 }, false, false, true)).toBe(false);
		expect(hasUnansweredPrompt({ kind: "assistant", seq: 1 }, true, false, true)).toBe(false);
		expect(hasUnansweredPrompt({ kind: "notice" }, true, false, true)).toBe(false);
		expect(hasUnansweredPrompt(undefined, true, false, true)).toBe(false);
	});
});
