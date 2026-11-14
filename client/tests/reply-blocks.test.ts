import { describe, expect, test } from "bun:test";
import { plainTextOf, replyActions, segmentsOf } from "../src/lib/reply-blocks";
import { SWIPE_MAX, SWIPE_TRIGGER, SwipeReply } from "../src/lib/swipe-reply";
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
});

describe("plainTextOf", () => {
	test("only text blocks, a blank line apart", () => {
		expect(plainTextOf([think("x"), text("one"), tool("1"), text("two")])).toBe("one\n\ntwo");
		expect(plainTextOf([tool("1")])).toBe("");
	});
});

describe("swipe to reply", () => {
	const drag = (s: SwipeReply, dxs: number[], dy = 0) => {
		s.start(1, 300, 100, true);
		return dxs.map((dx) => s.move(300 + dx, 100 + dy));
	};
	test("a long drag to the left arms the reply once, and letting go replies", () => {
		const s = new SwipeReply();
		const moves = drag(s, [-5, -40, -100, -120]);
		expect(moves.map((m) => m.handled)).toEqual([false, true, true, true]);
		expect(moves.filter((m) => m.justArmed)).toHaveLength(1);
		expect(s.swiping).toBe(true);
		expect(s.end()).toBe(true);
		expect(s.x).toBe(0);
	});
	test("the card follows the finger damped and stops at the maximum", () => {
		const s = new SwipeReply();
		drag(s, [-40]);
		expect(s.x).toBeCloseTo(-28);
		drag(s, [-400]);
		expect(s.x).toBe(-SWIPE_MAX);
	});
	test("letting go short of the trigger does not reply", () => {
		const s = new SwipeReply();
		drag(s, [-30, -50]);
		expect(-s.x).toBeLessThan(SWIPE_TRIGGER);
		expect(s.end()).toBe(false);
	});
	test("a vertical or rightward drag is a scroll and never swipes", () => {
		const down = new SwipeReply();
		expect(drag(down, [-5, -10], 40).every((m) => !m.handled)).toBe(true);
		expect(down.end()).toBe(false);
		const right = new SwipeReply();
		expect(drag(right, [20, 60]).every((m) => !m.handled)).toBe(true);
	});
	test("two fingers, or a place that keeps its own gestures, never start one", () => {
		const s = new SwipeReply();
		s.start(2, 0, 0, true);
		expect(s.move(-100, 0).handled).toBe(false);
		s.start(1, 0, 0, false);
		expect(s.move(-100, 0).handled).toBe(false);
	});
	test("drifting back below the trigger disarms it", () => {
		const s = new SwipeReply();
		drag(s, [-120]);
		expect(s.armed).toBe(true);
		s.move(300 - 20, 100);
		expect(s.armed).toBe(false);
		expect(s.end()).toBe(false);
	});
});

describe("replyActions", () => {
	const r = (stopReason: StopReason) => ({ stopReason });
	const none = { retry: false, cut: false, resume: false };

	test("a reply the output limit cut off says so, and only the newest one offers to go on", () => {
		expect(replyActions(r("length"), true, false)).toEqual({ retry: false, cut: true, resume: true });
		expect(replyActions(r("length"), false, false)).toEqual({ retry: false, cut: true, resume: false });
	});
	test("a failed or stopped reply offers retry, and only the newest one", () => {
		expect(replyActions(r("error"), true, false)).toEqual({ retry: true, cut: false, resume: false });
		expect(replyActions(r("aborted"), true, false)).toEqual({ retry: true, cut: false, resume: false });
		expect(replyActions(r("aborted"), false, false)).toEqual(none);
	});
	test("a reply still being written, a finished one and no reply at all offer nothing", () => {
		expect(replyActions(r("length"), true, true)).toEqual(none);
		expect(replyActions(r("error"), true, true)).toEqual(none);
		for (const s of ["stop", "toolUse", "pending", "deferred"] as const) expect(replyActions(r(s), true, false), s).toEqual(none);
		expect(replyActions(undefined, true, false)).toEqual(none);
	});
});
