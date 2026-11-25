import { describe, expect, test } from "bun:test";
import { attentionTarget, stepRowTarget, stepWorkspaceTarget, type AttentionMarks, type StepServer } from "../src/lib/step-session";
import { projectKey, type SidebarBlock } from "../src/lib/projects";
import { dirKey, groupKey } from "../src/lib/sidebar-model";
import type { DirBlock } from "../src/lib/nav";

const tab = (id: string) => ({ kind: "session", id }) as never;
const dir = (path: string, ...ids: string[]): DirBlock => ({ path, tabs: ids.map(tab) });
const grp = (id: string, ...members: string[]) => ({ kind: "group", id, members: members.map((m) => ({ id: m })) }) as never;
const proj = (root: string, ...dirs: DirBlock[]): SidebarBlock => ({ kind: "project", root, dirs });
const solo = (d: DirBlock): SidebarBlock => ({ kind: "dir", dir: d });

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
		expect(row([A, B], onlyB, "A", "a3", -1)).toEqual({ server: "A", id: "a1", dir: "/a" });
		expect(row([A, B], onlyB, "A", "a2", 1)).toEqual({ server: "A", id: "a3" });
		expect(row([A, B], onlyB, "A", "a3", 1)).toEqual({ server: "B", id: "b1", dir: "/c" });
		expect(row([A, B], onlyB, "B", "b2", 1)).toEqual({ server: "A", id: "a1", dir: "/a" });
	});
	test("a folded split tab shows its first pane only; a folded server is passed by", () => {
		const G: StepServer = { id: "A", dirs: [dir("/a", "x"), { path: "/g", tabs: [grp("g", "p", "q")] }, dir("/z", "y")] };
		const none = () => false;
		expect(row([G], none, "A", "x", 1)).toEqual({ server: "A", id: "p" });
		expect(row([G], none, "A", "p", 1)).toEqual({ server: "A", id: "q" });
		expect(row([G], none, "A", "p", 1, [groupKey("g")])).toEqual({ server: "A", id: "y" });
		expect(row([A, B], all, "A", "a3", 1, ["B"])).toEqual({ server: "A", id: "a1" });
	});
	test("a folded project is one row that opens the project; an open project walks its folders", () => {
		const d1 = dir("/p", "p1");
		const d2 = dir("/p-x", "x1", "x2");
		const dn = dir("/n", "n1");
		const S: StepServer = { id: "A", dirs: [d1, d2, dn], blocks: [proj("/p", d1, d2), solo(dn)] };
		const pFold = [projectKey("A", "/p")];
		const allFolded = () => true;
		// stepping up from /n onto the folded project lands on the project itself
		expect(row([S], allFolded, "A", "n1", -1, pFold)).toEqual({ server: "A", id: "p1", project: "/p" });
		expect(row([S], allFolded, "A", "n1", 1, pFold)).toEqual({ server: "A", id: "p1", project: "/p" });
		// from any pane inside the folded project, stepping goes straight to the neighbouring row
		expect(row([S], allFolded, "A", "p1", 1, pFold)).toEqual({ server: "A", id: "n1", dir: "/n" });
		expect(row([S], allFolded, "A", "x2", -1, pFold)).toEqual({ server: "A", id: "n1", dir: "/n" });
		// when nothing is open, forward lands on the folded project first
		expect(row([S], allFolded, "A", null, 1, pFold)).toEqual({ server: "A", id: "p1", project: "/p" });
		// empty folded projects are skipped
		const emptyProj: StepServer = { id: "A", dirs: [dir("/e1"), dir("/e2"), dn], blocks: [proj("/e1", dir("/e1"), dir("/e2")), solo(dn)] };
		expect(row([emptyProj], allFolded, "A", "n1", -1, [projectKey("A", "/e1")])).toBeNull();
		// a lone folded project has nowhere else to go when already inside it
		const loneProj: StepServer = { id: "A", dirs: [d1, d2], blocks: [proj("/p", d1, d2)] };
		expect(row([loneProj], allFolded, "A", "x1", 1, pFold)).toBeNull();
		// when the project is unfolded, its worktree rows are walked in order
		expect(row([S], () => false, "A", "p1", 1)).toEqual({ server: "A", id: "x1" });
		expect(row([S], () => false, "A", "x2", 1)).toEqual({ server: "A", id: "n1" });
		expect(row([S], allFolded, "A", "p1", 1)).toEqual({ server: "A", id: "x1", dir: "/p-x" });
	});
	test("a folded project inside a folded or unreachable server is skipped", () => {
		const d1 = dir("/p", "p1");
		const d2 = dir("/p-x", "x1");
		const P: StepServer = { id: "B", dirs: [d1, d2], blocks: [proj("/p", d1, d2)] };
		expect(row([A, P], () => true, "A", "a3", 1, ["B", projectKey("B", "/p")])).toEqual({ server: "A", id: "a1", dir: "/a" });
		expect(row([A, { ...P, hidden: true }], () => true, "A", "a3", 1, [projectKey("B", "/p")])).toEqual({ server: "A", id: "a1", dir: "/a" });
	});
	test("nothing open starts at an end; a single row has nowhere to go", () => {
		expect(row([A, B], all, "A", null, 1)).toEqual({ server: "A", id: "a1" });
		expect(row([A, B], all, "A", null, -1)).toEqual({ server: "B", id: "b2" });
		expect(row([{ id: "A", dirs: [dir("/a", "only")] }], all, "A", "only", 1)).toBeNull();
	});
});

describe("stepWorkspaceTarget", () => {
	// where it lands (the folder it names is checked on its own below)
	const ws = (servers: StepServer[], folded: string[], server: string | null, id: string | null, n: 1 | -1) => {
		const to = stepWorkspaceTarget(servers, folded, { server, id }, n);
		return to && { server: to.server, id: to.id };
	};
	test("names the folder it lands on, so the caller can open the tab last used there", () => {
		expect(stepWorkspaceTarget([A, B], [], { server: "A", id: "a1" }, 1)).toEqual({ server: "A", id: "a3", dir: "/b" });
	});
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
	const d1 = dir("/p", "p1");
	const d2 = dir("/p-x", "x1", "x2");
	const dn = dir("/n", "n1");
	const dm = dir("/m", "m1");
	// /p and /p-x are one project (listed together), /n and /m plain folders
	const S: StepServer = { id: "A", dirs: [d1, d2, dn, dm], blocks: [proj("/p", d1, d2), solo(dn), solo(dm)] };
	test("when unfolded, each worktree row is a stop, landing on its first tab", () => {
		expect(stepWorkspaceTarget([S], [], { server: "A", id: "p1" }, 1)).toEqual({ server: "A", id: "x1", dir: "/p-x" });
		expect(stepWorkspaceTarget([S], [], { server: "A", id: "x2" }, 1)).toEqual({ server: "A", id: "n1", dir: "/n" });
	});
	test("when folded, the whole project is one stop that opens the project", () => {
		const folded = [projectKey("A", "/p")];
		expect(stepWorkspaceTarget([S], folded, { server: "A", id: "n1" }, -1)).toEqual({ server: "A", id: "p1", project: "/p" });
		expect(stepWorkspaceTarget([S], folded, { server: "A", id: "m1" }, 1)).toEqual({ server: "A", id: "p1", project: "/p" });
		// from inside the folded project (any worktree pane) the step moves to the next / previous folder
		expect(stepWorkspaceTarget([S], folded, { server: "A", id: "x1" }, 1)).toEqual({ server: "A", id: "n1", dir: "/n" });
		expect(stepWorkspaceTarget([S], folded, { server: "A", id: "p1" }, -1)).toEqual({ server: "A", id: "m1", dir: "/m" });
		// empty folded projects are skipped
		const emptyProj: StepServer = { id: "A", dirs: [dir("/e1"), dir("/e2"), dn], blocks: [proj("/e1", dir("/e1"), dir("/e2")), solo(dn)] };
		expect(stepWorkspaceTarget([emptyProj], [projectKey("A", "/e1")], { server: "A", id: "n1" }, 1)).toEqual({ server: "A", id: "n1", dir: "/n" });
		// folded project in a folded or unreachable server is skipped
		const B2: StepServer = { id: "B", dirs: [d1, d2], blocks: [proj("/p", d1, d2)] };
		expect(stepWorkspaceTarget([A, B2], ["B", projectKey("B", "/p")], { server: "A", id: "a3" }, 1)).toEqual({ server: "A", id: "a1", dir: "/a" });
		expect(stepWorkspaceTarget([A, { ...B2, hidden: true }], [projectKey("B", "/p")], { server: "A", id: "a3" }, 1)).toEqual({ server: "A", id: "a1", dir: "/a" });
	});
});

describe("attentionTarget", () => {
	const none: AttentionMarks = { awaiting: {}, failed: {}, unread: {} };
	const with_ = (s: StepServer, m: Partial<AttentionMarks>) => ({ ...s, marks: { ...none, ...m } });
	test("a question beats a failure, a failure an unseen finish, across servers", () => {
		const servers = [with_(A, { unread: { a2: true } }), with_(B, { awaiting: { b2: 1 } })];
		expect(attentionTarget(servers, { server: "A", id: "a1" })).toEqual({ server: "B", id: "b2" });
		const fail = [with_(A, { unread: { a2: true } }), with_(B, { failed: { b1: true } })];
		expect(attentionTarget(fail, { server: "A", id: "a1" })).toEqual({ server: "B", id: "b1" });
	});
	test("pressing again walks on to the next one in the same state, and wraps", () => {
		const servers = [with_(A, { awaiting: { a1: 1, a3: 1 } }), with_(B, { awaiting: { b2: 1 } })];
		expect(attentionTarget(servers, { server: "A", id: "a1" })).toEqual({ server: "A", id: "a3" });
		expect(attentionTarget(servers, { server: "A", id: "a3" })).toEqual({ server: "B", id: "b2" });
		expect(attentionTarget(servers, { server: "B", id: "b2" })).toEqual({ server: "A", id: "a1" });
	});
	test("the open pane alone, or an unreachable server's stale marks, give nothing", () => {
		expect(attentionTarget([with_(A, { awaiting: { a1: 1 } })], { server: "A", id: "a1" })).toBeNull();
		expect(attentionTarget([with_(A, {}), { ...with_(B, { awaiting: { b1: 1 } }), hidden: true }], { server: "A", id: "a1" })).toBeNull();
		expect(attentionTarget([with_(A, { unread: { a2: true } })], { server: null, id: null })).toEqual({ server: "A", id: "a2" });
	});
});
