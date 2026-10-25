import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { EventBus, type PipayaEvent } from "../src/events.ts";
import { NotificationService, type DevicePresence } from "../src/notifications.ts";
import { UnreadTracker } from "../src/unread.ts";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const d of disposals.splice(0)) await d(); });

function setup() {
	const db = openDb(":memory:");
	const bus = new EventBus(db);
	const service = new NotificationService(db, bus, {}, () => 1000);
	const unread = new UnreadTracker(db, bus, (id) => service.watching(id));
	service.onLook = (ids) => unread.read(ids);
	for (const id of ["s1", "s2"]) db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES (?, 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run(id);
	const marks: PipayaEvent[] = [];
	bus.subscribe((e) => { if (e.type === "session_unread") marks.push(e); });
	disposals.push(async () => { unread.dispose(); await service.close(); db.close(); });
	const finish = (id: string, status = "ok") => bus.publish(id, "run_finished", { status, error: null, durationMs: 1, usage: {} });
	return { bus, service, unread, marks, finish };
}
const pc = (visible: string[], focused = true, active?: string): DevicePresence => ({ platform: "desktop", focused, enabled: true, visibleSessionIds: visible, activeSessionId: active });

describe("server-side unread marks", () => {
	test("a run that finishes while nobody is looking stays unread until a device reads it", () => {
		const { service, unread, marks, finish } = setup();
		finish("s1"); finish("s2", "error");
		expect(unread.list()).toEqual([{ sessionId: "s1", kind: "done" }, { sessionId: "s2", kind: "failed" }]);
		service.heartbeat("pc", pc(["s1"])); // the PC opens s1: it is read for every device
		expect(unread.list()).toEqual([{ sessionId: "s2", kind: "failed" }]);
		expect(marks.at(-1)!.data).toEqual({ sessionId: "s1", kind: null });
	});

	test("finishing in a session a focused device is showing leaves no mark", () => {
		const { service, unread, finish } = setup();
		service.heartbeat("pc", pc(["s1"]));
		finish("s1");
		expect(unread.list()).toEqual([]);
	});

	test("an unfocused window does not count as looking", () => {
		const { service, unread, finish } = setup();
		service.heartbeat("pc", pc(["s1"], false));
		finish("s1");
		expect(unread.list()).toEqual([{ sessionId: "s1", kind: "done" }]);
	});

	test("in a split view only the active pane is read", () => {
		const { service, unread, finish } = setup();
		finish("s1"); finish("s2");
		service.heartbeat("pc", pc(["s1", "s2"], true, "s1"));
		expect(unread.list()).toEqual([{ sessionId: "s2", kind: "done" }]);
	});

	test("starting a new run, or an aborted one, changes nothing it should not", () => {
		const { bus, unread, finish } = setup();
		finish("s1", "aborted");
		expect(unread.list()).toEqual([]);
		finish("s1");
		bus.publish("s1", "run_started", { mode: "prompt" });
		expect(unread.list()).toEqual([]);
	});

	test("read() is idempotent and only announces real changes", () => {
		const { unread, marks, finish } = setup();
		finish("s1");
		const before = marks.length;
		unread.read(["s1"]); unread.read(["s1"]);
		expect(marks.length).toBe(before + 1);
	});
});
