import { describe, expect, test } from "bun:test";
import { stepRowTarget, stepWorkspaceTarget, type StepServer } from "../src/lib/step-session";
import { dirKey, groupKey } from "../src/lib/sidebar-model";
import type { DirBlock } from "../src/lib/nav";

const tab = (id: string) => ({ kind: "session", id }) as never;
const dir = (path: string, ...ids: string[]): DirBlock => ({ path, tabs: ids.map(tab) });
const grp = (id: string, ...members: string[]) => ({ kind: "group", id, members: members.map((m) => ({ id: m })) }) as never;

const A: StepServer = { id: "A", dirs: [dir("/a", "a1", "a2"), dir("/b", "a3")] };
const B: StepServer = { id: "B", dirs: [dir("/c", "b1", "b2")] };

describe("stepRowTarget", () => {
	const open = (...keys: string[]) => (server: string, path: string) => !keys.includes(dirKey(server, path));
	const row = (servers: StepServer[], dirFolded: (s: string, p: string) => boolean, server: string | null, id: string | null, n: 1 | -1, folded: string[] = []) =>
		stepRowTarget(servers, folded, dirFolded, { server, id }, n);
	const all = open(dirKey("A", "/a"), dirKey("A", "/b"), dirKey("B", "/c"));
	test("walks the tabs of open folders, crossing into the next server, and wraps", () => {
		expect(row([A, B], all, "A", "a1", 1)).toEqual({ server: "A", id: "a2" });
		expect(row([A, B], all, "A", "a2", 1)).toEqual({ server: "A", id: "a3" });
		expect(row([A, B], all, "A", "a3", 1)).toEqual({ server: "B", id: "b1" });
		expect(row([A, B], all, "B", "b2", 1)).toEqual({ server: "A", id: "a1" });
		expect(row([A, B], all, "A", "a1", -1)).toEqual({ server: "B", id: "b2" });
	});
	test("a folded folder is one row: it opens its first tab and the walk goes on from it", () => {
		const onlyB = open(dirKey("A", "/b"));
		expect(row([A, B], onlyB, "A", "a3", -1)).toEqual({ server: "A", id: "a1" });
		expect(row([A, B], onlyB, "A", "a2", 1)).toEqual({ server: "A", id: "a3" });
		expect(row([A, B], onlyB, "A", "a3", 1)).toEqual({ server: "B", id: "b1" });
		expect(row([A, B], onlyB, "B", "b2", 1)).toEqual({ server: "A", id: "a1" });
	});
	test("a folded split tab shows its first pane only; a folded server or project is passed by", () => {
		const G: StepServer = { id: "A", dirs: [dir("/a", "x"), { path: "/g", tabs: [grp("g", "p", "q")] }, dir("/z", "y")] };
		const none = () => false;
		expect(row([G], none, "A", "x", 1)).toEqual({ server: "A", id: "p" });
		expect(row([G], none, "A", "p", 1)).toEqual({ server: "A", id: "q" });
		expect(row([G], none, "A", "p", 1, [groupKey("g")])).toEqual({ server: "A", id: "y" });
		expect(row([A, B], all, "A", "a3", 1, ["B"])).toEqual({ server: "A", id: "a1" });
		expect(row([{ ...A, foldedDirs: ["/b"] }, B], all, "A", "a2", 1)).toEqual({ server: "B", id: "b1" });
	});
	test("nothing open starts at an end; a single row has nowhere to go", () => {
		expect(row([A, B], all, "A", null, 1)).toEqual({ server: "A", id: "a1" });
		expect(row([A, B], all, "A", null, -1)).toEqual({ server: "B", id: "b2" });
		expect(row([{ id: "A", dirs: [dir("/a", "only")] }], all, "A", "only", 1)).toBeNull();
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

describe("stepWorkspaceTarget with projects", () => {
	const ws = (servers: StepServer[], server: string | null, id: string | null, n: 1 | -1) => stepWorkspaceTarget(servers, [], { server, id }, n);
	// /p and /p-x are one project (listed together), /n a plain folder
	const S: StepServer = { id: "A", dirs: [dir("/p", "p1"), dir("/p-x", "x1", "x2"), dir("/n", "n1")] };
	test("each worktree row is a stop, landing on its first tab", () => {
		expect(ws([S], "A", "p1", 1)).toEqual({ server: "A", id: "x1" });
		expect(ws([S], "A", "x2", 1)).toEqual({ server: "A", id: "n1" });
	});
	test("the rows of a folded project are passed by", () => {
		const F: StepServer = { ...S, dirs: [...S.dirs, dir("/m", "m1")], foldedDirs: ["/p", "/p-x"] };
		expect(ws([F], "A", "n1", 1)).toEqual({ server: "A", id: "m1" });
		expect(ws([F], "A", "m1", 1)).toEqual({ server: "A", id: "n1" });
		// from inside the folded project (its tab is open) the step walks out of it
		expect(ws([F], "A", "x1", 1)).toEqual({ server: "A", id: "n1" });
	});
});
