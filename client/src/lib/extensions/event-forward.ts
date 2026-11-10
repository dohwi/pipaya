/**
 * Which server events client extensions hear about, and in what shape. Only metadata is forwarded (ids, a status, a tool
 * name), never event data, messages, tool arguments or credentials; what server extensions publish is meant for client
 * extensions and goes through as is. Pure, so the rule is tested apart from the store.
 */
import type { PipayaEvent } from "../types";
import type { ExtensionEvent, ServerExtensionEvent } from "./sdk";

const SESSION_EVENTS = new Set<string>(["run_started", "run_finished", "session_created", "session_updated", "session_deleted", "compaction_finished", "question_requested", "question_resolved"]);
const GROUP_EVENTS = new Set<string>(["group_created", "group_updated", "group_deleted"]);

/** The app events for `extensions.emit`, in the order they used to go out. */
export function appEventsOf(e: PipayaEvent): ExtensionEvent[] {
	const sid = e.sessionId;
	const out: ExtensionEvent[] = [];
	if (SESSION_EVENTS.has(e.type)) {
		const status = e.type === "run_finished" && typeof e.data.status === "string" ? e.data.status : undefined;
		out.push({ type: e.type as ExtensionEvent["type"], sessionId: sid, at: e.ts, ...(status === undefined ? {} : { status }) });
	}
	if (GROUP_EVENTS.has(e.type)) out.push({ type: e.type as ExtensionEvent["type"], sessionId: null, at: e.ts, groupId: String((e.data as { id?: unknown }).id ?? "") });
	else if (e.type === "extensions_updated") out.push({ type: "extensions_updated", sessionId: null, at: e.ts });
	if (e.type === "turn_end") out.push({ type: "turn_end", sessionId: sid, at: e.ts });
	else if (e.type === "tool_execution_end") {
		const d = e.data as { toolName?: unknown; isError?: unknown };
		out.push({ type: "tool_execution_end", sessionId: sid, at: e.ts, toolName: String(d.toolName ?? ""), isError: d.isError === true });
	}
	return out;
}

/** What a server extension published (`extension_event`) or stored (`extension_entry`), for `extensions.emitServer`. */
export function serverEventOf(e: PipayaEvent): ServerExtensionEvent | null {
	if (e.type === "extension_event") {
		const d = e.data as { extension: string; type: string; data: unknown };
		return { kind: "event", extension: d.extension, type: d.type, sessionId: e.sessionId, data: d.data };
	}
	if (e.type === "extension_entry") {
		const d = e.data as { id: number; extension: string; type: string; data: unknown };
		return { kind: "entry", extension: d.extension, type: d.type, sessionId: e.sessionId, data: d.data, id: d.id };
	}
	return null;
}
