import { describe, expect, test } from "bun:test";
import { applyLinkEvent, applyLiveEvent, emptyLinkData } from "../src/lib/server-link-model";

const session = (id: string, over: Record<string, unknown> = {}) => ({ id, title: id, closed: false, provider: "p", model: "m", ...over });
const ev = (type: string, data: unknown = {}, sessionId: string | null = null) => ({ type, data, sessionId, ts: 1 }) as never;

describe("a background server's live state", () => {
	test("sessions come, change sides and go", () => {
		const d = emptyLinkData();
		applyLinkEvent(d, ev("session_created", session("a")));
		applyLinkEvent(d, ev("session_created", session("b")));
		expect(d.sessions.map((s) => s.id)).toEqual(["b", "a"]);
		// a closed one leaves the list, and a deleted one goes for good
		applyLinkEvent(d, ev("session_updated", session("a", { closed: true })));
		expect(d.sessions.map((s) => s.id)).toEqual(["b"]);
		applyLinkEvent(d, ev("session_deleted", { id: "b" }));
		expect(d.sessions.length).toBe(0);
	});
	test("a run marks the session working, then done; a question marks it asking", () => {
		const d = emptyLinkData();
		applyLinkEvent(d, ev("run_started", {}, "a"));
		expect(d.running.a).toBe(true);
		applyLinkEvent(d, ev("question_requested", {}, "a"));
		applyLinkEvent(d, ev("question_requested", {}, "a"));
		applyLinkEvent(d, ev("question_resolved", {}, "a"));
		expect(d.awaiting.a).toBe(1);
		applyLinkEvent(d, ev("run_finished", { status: "ok" }, "a"));
		expect(d.running.a).toBe(false);
		expect(d.awaiting.a).toBe(0);
		applyLinkEvent(d, ev("session_unread", { sessionId: "a", kind: "failed" }));
		expect(d.failed.a).toBe(true);
		applyLinkEvent(d, ev("session_unread", { sessionId: "a", kind: null }));
		expect(d.failed.a).toBeUndefined();
	});
	test("groups and terminals are kept by id", () => {
		const d = emptyLinkData();
		applyLinkEvent(d, ev("group_created", { id: "g", name: "one" }));
		applyLinkEvent(d, ev("group_updated", { id: "g", name: "two" }));
		expect(d.groups).toEqual([{ id: "g", name: "two" } as never]);
		applyLinkEvent(d, ev("group_deleted", { id: "g" }));
		applyLinkEvent(d, ev("terminal_created", { id: "t" }));
		applyLinkEvent(d, ev("terminal_closed", { id: "t" }));
		expect(d.groups.length + d.terminals.length).toBe(0);
	});
});

describe("the queue and current tool the graph view shows", () => {
	test("a queued message counts until it is delivered, taken back, or its run ends", () => {
		const d = emptyLinkData();
		applyLiveEvent(d, ev("message_queued", { mode: "steer", text: "now" }, "a"));
		applyLiveEvent(d, ev("message_queued", { mode: "follow_up", text: "later" }, "a"));
		applyLiveEvent(d, ev("message_queued", { mode: "follow_up", text: "after", deferred: true }, "a"));
		expect(d.queued.a?.length).toBe(3);
		applyLiveEvent(d, ev("message_end", { message: { role: "user", content: [{ type: "text", text: "now" }] } }, "a"));
		applyLiveEvent(d, ev("message_dequeued", { mode: "follow_up", text: "later" }, "a"));
		expect(d.queued.a).toEqual([{ mode: "follow_up", text: "after", deferred: true }]);
		// a held message outlives its run, unless the run was stopped
		applyLiveEvent(d, ev("run_finished", { status: "ok" }, "a"));
		expect(d.queued.a?.length).toBe(1);
		applyLiveEvent(d, ev("run_finished", { status: "aborted" }, "a"));
		expect(d.queued.a).toBeUndefined();
	});
	test("the tool in progress is kept from its start to its end, and goes with the run", () => {
		const d = emptyLinkData();
		applyLiveEvent(d, ev("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "ls" } }, "a"));
		expect(d.tool.a).toEqual({ name: "bash", args: { command: "ls" } });
		applyLiveEvent(d, ev("tool_execution_end", { toolCallId: "1", toolName: "bash" }, "a"));
		expect(d.tool.a).toBeUndefined();
		applyLiveEvent(d, ev("tool_execution_start", { toolCallId: "2", toolName: "read", args: null }, "a"));
		expect(d.tool.a).toEqual({ name: "read", args: {} });
		applyLiveEvent(d, ev("run_finished", { status: "error" }, "a"));
		expect(d.tool.a).toBeUndefined();
	});
	test("a closed or deleted session leaves nothing behind; an event with no session is ignored", () => {
		const d = emptyLinkData();
		applyLiveEvent(d, ev("message_queued", { mode: "steer", text: "x" }, "a"));
		applyLiveEvent(d, ev("tool_execution_start", { toolName: "bash", args: {} }, "b"));
		applyLiveEvent(d, ev("session_updated", session("a", { closed: true })));
		applyLiveEvent(d, ev("session_deleted", { id: "b" }));
		applyLiveEvent(d, ev("message_queued", { mode: "steer", text: "y" }));
		expect([d.queued, d.tool]).toEqual([{}, {}]);
	});
});
