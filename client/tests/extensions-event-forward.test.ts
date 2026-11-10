import { describe, expect, test } from "bun:test";
import { appEventsOf, serverEventOf } from "../src/lib/extensions/event-forward";

const ev = (type: string, data: Record<string, unknown> = {}, sessionId: string | null = "s1") => ({ id: 1, type, sessionId, ts: 9, data });

describe("appEventsOf", () => {
	test("session events carry only ids and a run's status, never their data", () => {
		expect(appEventsOf(ev("run_finished", { status: "done", text: "secret" }))).toEqual([{ type: "run_finished", sessionId: "s1", at: 9, status: "done" }]);
		expect(appEventsOf(ev("session_updated", { title: "x" }))).toEqual([{ type: "session_updated", sessionId: "s1", at: 9 }]);
	});
	test("group events name the group and no session", () => {
		expect(appEventsOf(ev("group_created", { id: "g1", layout: {} }))).toEqual([{ type: "group_created", sessionId: null, at: 9, groupId: "g1" }]);
	});
	test("a tool's end says which tool and whether it failed, without its args", () => {
		expect(appEventsOf(ev("tool_execution_end", { toolName: "bash", isError: 1, args: { cmd: "rm" } }))).toEqual([{ type: "tool_execution_end", sessionId: "s1", at: 9, toolName: "bash", isError: false }]);
	});
	test("other events are not forwarded", () => {
		expect(appEventsOf(ev("text_delta", { delta: "hi" }))).toEqual([]);
		expect(appEventsOf(ev("extensions_updated", {}, null))).toEqual([{ type: "extensions_updated", sessionId: null, at: 9 }]);
	});
});

describe("serverEventOf", () => {
	test("published events and stored entries go through as is", () => {
		expect(serverEventOf(ev("extension_event", { extension: "x", type: "t", data: { a: 1 } }))).toEqual({ kind: "event", extension: "x", type: "t", sessionId: "s1", data: { a: 1 } });
		expect(serverEventOf(ev("extension_entry", { id: 3, extension: "x", type: "t", data: 2 }))).toEqual({ kind: "entry", extension: "x", type: "t", sessionId: "s1", data: 2, id: 3 });
		expect(serverEventOf(ev("run_started"))).toBeNull();
	});
});
