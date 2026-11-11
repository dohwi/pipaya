import { describe, expect, test } from "bun:test";
import { stepSessionTarget, stepWorkspaceTarget, type StepServer } from "../src/lib/step-session";
import { dirKey, groupKey } from "../src/lib/sidebar-model";
import type { DirBlock } from "../src/lib/nav";

const tab = (id: string) => ({ kind: "session", id }) as never;
const dir = (path: string, ...ids: string[]): DirBlock => ({ path, tabs: ids.map(tab) });
const grp = (id: string, ...members: string[]) => ({ kind: "group", id, members: members.map((m) => ({ id: m })) }) as never;

const A: StepServer = { id: "A", dirs: [dir("/a", "a1", "a2"), dir("/b", "a3")] };
const B: StepServer = { id: "B", dirs: [dir("/c", "b1", "b2")] };
const step = (servers: StepServer[], folded: string[], server: string | null, id: string | null, n: 1 | -1) =>
	stepSessionTarget(servers, folded, { server, id }, n);

describe("stepSessionTarget", () => {
	test("walks folders then crosses into the next server", () => {
		expect(step([A, B], [], "A", "a2", 1)).toEqual({ server: "A", id: "a3" });
		expect(step([A, B], [], "A", "a3", 1)).toEqual({ server: "B", id: "b1" });
		expect(step([A, B], [], "B", "b1", -1)).toEqual({ server: "A", id: "a3" });
	});
	test("wraps last to first across servers, both ways", () => {
		expect(step([A, B], [], "B", "b2", 1)).toEqual({ server: "A", id: "a1" });
		expect(step([A, B], [], "A", "a1", -1)).toEqual({ server: "B", id: "b2" });
	});
	test("a folded server, folder or split group is skipped", () => {
		expect(step([A, B], ["B"], "A", "a3", 1)).toEqual({ server: "A", id: "a1" });
		expect(step([A, B], [dirKey("A", "/b")], "A", "a2", 1)).toEqual({ server: "B", id: "b1" });
		const G: StepServer = { id: "A", dirs: [dir("/a", "x"), { path: "/g", tabs: [grp("g", "p", "q")] }, dir("/z", "y")] };
		expect(step([G], [groupKey("g")], "A", "x", 1)).toEqual({ server: "A", id: "p" });
		expect(step([G], [groupKey("g")], "A", "p", 1)).toEqual({ server: "A", id: "y" });
	});
	test("walks out of a folded folder from the open row", () => {
		expect(step([A, B], [dirKey("A", "/b")], "A", "a3", 1)).toEqual({ server: "B", id: "b1" });
	});
	test("an unreachable server is skipped when several are listed", () => {
		expect(step([A, { ...B, hidden: true }], [], "A", "a3", 1)).toEqual({ server: "A", id: "a1" });
	});
	test("nothing open: forward starts at the first, back at the last", () => {
		expect(step([A, B], [], "A", null, 1)).toEqual({ server: "A", id: "a1" });
		expect(step([A, B], [], "A", null, -1)).toEqual({ server: "B", id: "b2" });
	});
	test("one server behaves as before: server fold ignored, wraps inside, single row stays", () => {
		expect(step([A], ["A"], "A", "a3", 1)).toEqual({ server: "A", id: "a1" });
		expect(step([{ id: "A", dirs: [dir("/a", "only")] }], [], "A", "only", 1)).toBeNull();
	});
	test("same id on two servers is told apart", () => {
		const X: StepServer = { id: "X", dirs: [dir("/", "s")] };
		const Y: StepServer = { id: "Y", dirs: [dir("/", "s")] };
		expect(step([X, Y], [], "X", "s", 1)).toEqual({ server: "Y", id: "s" });
	});
});

describe("stepWorkspaceTarget", () => {
	const ws = (servers: StepServer[], folded: string[], server: string | null, id: string | null, n: 1 | -1) =>
		stepWorkspaceTarget(servers, folded, { server, id }, n);
	test("goes to the next folder's first pane, crossing into the next server", () => {
		expect(ws([A, B], [], "A", "a2", 1)).toEqual({ server: "A", id: "a3" });
		expect(ws([A, B], [], "A", "a3", 1)).toEqual({ server: "B", id: "b1" });
		expect(ws([A, B], [], "B", "b2", -1)).toEqual({ server: "A", id: "a3" });
	});
	test("wraps across servers, both ways", () => {
		expect(ws([A, B], [], "B", "b2", 1)).toEqual({ server: "A", id: "a1" });
		expect(ws([A, B], [], "A", "a1", -1)).toEqual({ server: "B", id: "b1" });
	});
	test("a folded or unreachable server is skipped, a folded folder is not", () => {
		expect(ws([A, B], ["B"], "A", "a3", 1)).toEqual({ server: "A", id: "a1" });
		expect(ws([A, { ...B, hidden: true }], [], "A", "a3", 1)).toEqual({ server: "A", id: "a1" });
		expect(ws([A, B], [dirKey("A", "/b")], "A", "a1", 1)).toEqual({ server: "A", id: "a3" });
	});
	test("a split group's panes belong to its folder", () => {
		const G: StepServer = { id: "A", dirs: [dir("/a", "x"), { path: "/g", tabs: [grp("g", "p", "q")] }] };
		expect(ws([G, B], [], "A", "q", 1)).toEqual({ server: "B", id: "b1" });
		expect(ws([G, B], [], "B", "b1", -1)).toEqual({ server: "A", id: "p" });
	});
	test("nothing open: forward starts at the first folder, back at the last", () => {
		expect(ws([A, B], [], "A", null, 1)).toEqual({ server: "A", id: "a1" });
		expect(ws([A, B], [], "A", null, -1)).toEqual({ server: "B", id: "b1" });
	});
	test("one server ignores its fold; empty folders and lists give nothing to skip to", () => {
		expect(ws([A], ["A"], "A", "a3", 1)).toEqual({ server: "A", id: "a1" });
		expect(ws([{ id: "A", dirs: [dir("/e"), dir("/a", "only")] }], [], "A", "only", 1)).toEqual({ server: "A", id: "only" });
		expect(ws([], [], null, null, 1)).toBeNull();
	});
});
