import { describe, expect, test } from "bun:test";
import { applyLinkEvent, emptyLinkData } from "../src/lib/server-link-model";

const session = (id: string, over: Record<string, unknown> = {}) => ({ id, title: id, closed: false, archived: false, provider: "p", model: "m", ...over });
const ev = (type: string, data: unknown = {}, sessionId: string | null = null) => ({ type, data, sessionId, ts: 1 }) as never;

describe("a background server's live state", () => {
	test("sessions come, change sides and go", () => {
		const d = emptyLinkData();
		applyLinkEvent(d, ev("session_created", session("a")));
		applyLinkEvent(d, ev("session_created", session("b", { archived: true })));
		expect(d.sessions.map((s) => s.id)).toEqual(["a"]);
		expect(d.archived.map((s) => s.id)).toEqual(["b"]);
		applyLinkEvent(d, ev("session_updated", session("a", { archived: true })));
		expect(d.sessions).toEqual([]);
		expect(d.archived.map((s) => s.id).sort()).toEqual(["a", "b"]);
		applyLinkEvent(d, ev("session_updated", session("a", { closed: true })));
		applyLinkEvent(d, ev("session_deleted", { id: "b" }));
		expect(d.sessions.length + d.archived.length).toBe(0);
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
