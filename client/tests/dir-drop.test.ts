import { describe, expect, test } from "bun:test";
import { applyDirDrop, leaveToStandalone, resolveDirDrop, type DirDropContext } from "../src/lib/dir-drop";
import type { DirBlock } from "../src/lib/nav";
import { projectBlocks, type ProjectOverrides, type RepoMap, type SidebarBlock } from "../src/lib/projects";

const tab = (id: string) => ({ kind: "session", id, session: { id } }) as never;
const dir = (path: string, ...ids: string[]): DirBlock => ({ path, tabs: ids.map(tab) });
const repo = (root: string, top: string, branch: string | null) => ({ root, top, branch });

const RECT = { top: 100, bottom: 132, height: 32 }; // 32px row: before < 108.96, over [108.96, 123.04], after > 123.04

const shape = (blocks: readonly SidebarBlock[]) =>
	blocks.map((b) => (b.kind === "dir" ? b.dir.path : `${b.manual ? "M" : "G"}:${b.root}[${b.dirs.map((d) => d.path).join(",")}]`));

/** Apply a drop result onto an in-memory sidebar state and return the resulting rendered blocks. */
function runDrop(
	dirs: DirBlock[],
	repos: RepoMap,
	over: ProjectOverrides,
	dragPath: string,
	drop: NonNullable<ReturnType<typeof resolveDirDrop>>,
	id = "new1",
) {
	const blocks = projectBlocks(dirs, repos, over);
	const ctx: DirDropContext = {
		blocks,
		dirOrder: dirs.map((d) => d.path),
		repos,
		overrides: over,
		labelOf: (p) => p.slice(p.lastIndexOf("/") + 1),
		projectNameOf: (r) => (r.startsWith("manual:") ? (over.projects?.find((p) => `manual:${p.id}` === r)?.name ?? r) : r.slice(r.lastIndexOf("/") + 1)),
		newId: () => id,
	};
	const res = applyDirDrop(ctx, dragPath, drop);
	if (!res) return { res, blocks, over, dirs };
	const byPath = new Map(dirs.map((d) => [d.path, d]));
	const nextDirs = res.dirOrder ? res.dirOrder.map((p) => byPath.get(p)!) : dirs;
	const nextOver = res.overrides ?? over;
	return { res, blocks: projectBlocks(nextDirs, repos, nextOver), over: nextOver, dirs: nextDirs };
}

describe("resolveDirDrop", () => {
	test("plain folder over plain folder splits into before / over / after and skips adjacent in-place edges", () => {
		const blocks = projectBlocks([dir("/a"), dir("/b"), dir("/c")], {});
		// /a over /b: top edge is in-place (null), middle merges, bottom edge reorders after /b
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/a", hit: { kind: "dir", path: "/b" }, y: 102, headerRect: RECT })).toBeNull();
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/a", hit: { kind: "dir", path: "/b" }, y: 116, headerRect: RECT })).toEqual({ id: "dir:/b", place: "over" });
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/a", hit: { kind: "dir", path: "/b" }, y: 130, headerRect: RECT })).toEqual({ id: "dir:/b", place: "after" });
		// /a over /c: top edge is not adjacent so before is valid
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/a", hit: { kind: "dir", path: "/c" }, y: 102, headerRect: RECT })).toEqual({ id: "dir:/c", place: "before" });
		// self is always null
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/a", hit: { kind: "dir", path: "/a" }, y: 116, headerRect: RECT })).toBeNull();
	});

	test("hovering below an expanded folder's header always targets `after` (never merges)", () => {
		const blocks = projectBlocks([dir("/a"), dir("/b"), dir("/c")], {});
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/a", hit: { kind: "dir", path: "/b" }, y: 180, headerRect: RECT })).toEqual({ id: "dir:/b", place: "after" });
		// /b over /a's tab list is in-place (`after` /a where /b already sits) -> null
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/b", hit: { kind: "dir", path: "/a" }, y: 180, headerRect: RECT })).toBeNull();
	});

	test("folders in the same project never show `over` and split 50/50 for reorder", () => {
		const over: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/a", "/b", "/c"] }] };
		const blocks = projectBlocks([dir("/a"), dir("/b"), dir("/c")], {}, over);
		// /a -> /c middle-top (112 < 116) = before, middle-bottom (120 > 116) = after
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/a", hit: { kind: "dir", path: "/c" }, y: 112, headerRect: RECT })).toEqual({ id: "dir:/c", place: "before" });
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/a", hit: { kind: "dir", path: "/c" }, y: 120, headerRect: RECT })).toEqual({ id: "dir:/c", place: "after" });
		// adjacent in-place within same project -> null
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/a", hit: { kind: "dir", path: "/b" }, y: 104, headerRect: RECT })).toBeNull();
	});

	test("git project pins main checkout first: dragging main or before main within the same git project is blocked", () => {
		const repos: RepoMap = {
			"/r": repo("/r", "/r", "main"),
			"/r-1": repo("/r", "/r-1", "f1"),
			"/r-2": repo("/r", "/r-2", "f2"),
		};
		const blocks = projectBlocks([dir("/r"), dir("/r-1"), dir("/r-2")], repos);
		expect(resolveDirDrop({ blocks, repos, dragPath: "/r", hit: { kind: "dir", path: "/r-2" }, y: 125, headerRect: RECT })).toBeNull();
		expect(resolveDirDrop({ blocks, repos, dragPath: "/r-2", hit: { kind: "dir", path: "/r" }, y: 105, headerRect: RECT })).toBeNull();
		expect(resolveDirDrop({ blocks, repos, dragPath: "/r-2", hit: { kind: "dir", path: "/r" }, y: 125, headerRect: RECT })).toEqual({ id: "dir:/r", place: "after" });
		expect(resolveDirDrop({ blocks, repos, dragPath: "/r-2", hit: { kind: "dir", path: "/r-1" }, y: 105, headerRect: RECT })).toEqual({ id: "dir:/r-1", place: "before" });
	});

	test("project header hit-testing distinguishes folded vs expanded and own vs external folders", () => {
		const over: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/a", "/b"] }] };
		const blocks = projectBlocks([dir("/x"), dir("/a"), dir("/b"), dir("/y")], {}, over);
		// External /y over expanded project header: top = before, middle & bottom = over (join)
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/y", hit: { kind: "project", root: "manual:p1", folded: false }, y: 102, headerRect: RECT })).toEqual({ id: "project:manual:p1", place: "before" });
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/y", hit: { kind: "project", root: "manual:p1", folded: false }, y: 116, headerRect: RECT })).toEqual({ id: "project:manual:p1", place: "over" });
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/y", hit: { kind: "project", root: "manual:p1", folded: false }, y: 130, headerRect: RECT })).toEqual({ id: "project:manual:p1", place: "over" });
		// External /x over folded project header: top = in-place (null), middle = over, bottom = after
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/x", hit: { kind: "project", root: "manual:p1", folded: true }, y: 102, headerRect: RECT })).toBeNull();
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/x", hit: { kind: "project", root: "manual:p1", folded: true }, y: 116, headerRect: RECT })).toEqual({ id: "project:manual:p1", place: "over" });
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/x", hit: { kind: "project", root: "manual:p1", folded: true }, y: 130, headerRect: RECT })).toEqual({ id: "project:manual:p1", place: "after" });
		// Own member /b over its own project header: top half = before (pull out above project), bottom half = null
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/b", hit: { kind: "project", root: "manual:p1", folded: false }, y: 105, headerRect: RECT })).toEqual({ id: "project:manual:p1", place: "before" });
		expect(resolveDirDrop({ blocks, repos: {}, dragPath: "/b", hit: { kind: "project", root: "manual:p1", folded: false }, y: 125, headerRect: RECT })).toBeNull();
	});
});

describe("applyDirDrop", () => {
	test("dropping folder A onto folder C merges them into a new hand-made project anchored at C's position", () => {
		const { res, blocks, over } = runDrop([dir("/a"), dir("/b"), dir("/c")], {}, {}, "/a", { id: "dir:/c", place: "over" }, "p9");
		expect(res?.revealRoot).toBe("manual:p9");
		expect(over.projects).toEqual([{ id: "p9", name: "c", dirs: ["/c", "/a"] }]);
		expect(shape(blocks)).toEqual(["/b", "M:manual:p9[/c,/a]"]);
	});

	test("dropping an earlier folder onto a manual project keeps the project in place", () => {
		const init: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/c", "/d"] }] };
		const { blocks, over } = runDrop([dir("/a"), dir("/b"), dir("/c"), dir("/d")], {}, init, "/a", { id: "project:manual:p1", place: "over" });
		expect(over.projects).toEqual([{ id: "p1", name: "P1", dirs: ["/c", "/d", "/a"] }]);
		expect(shape(blocks)).toEqual(["/b", "M:manual:p1[/c,/d,/a]"]);
	});

	test("dropping an external folder between folders inside a manual project inserts at that exact slot", () => {
		const init: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/c", "/d"] }] };
		const { blocks, over } = runDrop([dir("/a"), dir("/b"), dir("/c"), dir("/d")], {}, init, "/a", { id: "dir:/d", place: "before" });
		expect(over.projects).toEqual([{ id: "p1", name: "P1", dirs: ["/c", "/a", "/d"] }]);
		expect(shape(blocks)).toEqual(["/b", "M:manual:p1[/c,/a,/d]"]);
	});

	test("reordering folders within a manual project updates its stored order", () => {
		const init: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/a", "/b", "/c"] }] };
		const { blocks, over } = runDrop([dir("/a"), dir("/b"), dir("/c")], {}, init, "/c", { id: "dir:/a", place: "before" });
		expect(over.projects).toEqual([{ id: "p1", name: "P1", dirs: ["/c", "/a", "/b"] }]);
		expect(shape(blocks)).toEqual(["M:manual:p1[/c,/a,/b]"]);
	});

	test("dropping an unrelated folder onto a git project promotes it into a hand-made project", () => {
		const repos: RepoMap = {
			"/r": repo("/r", "/r", "main"),
			"/r-wt": repo("/r", "/r-wt", "feat"),
			"/notes": null,
		};
		const { res, blocks, over } = runDrop([dir("/notes"), dir("/r"), dir("/r-wt")], repos, {}, "/notes", { id: "project:/r", place: "over" }, "g1");
		expect(res?.revealRoot).toBe("manual:g1");
		expect(over.projects).toEqual([{ id: "g1", name: "r", dirs: ["/r", "/r-wt", "/notes"] }]);
		expect(shape(blocks)).toEqual(["M:manual:g1[/r,/r-wt,/notes]"]);
	});

	test("dropping an ungrouped worktree back onto its git project rejoins without promoting", () => {
		const repos: RepoMap = {
			"/r": repo("/r", "/r", "main"),
			"/r-1": repo("/r", "/r-1", "f1"),
			"/r-2": repo("/r", "/r-2", "f2"),
		};
		const init: ProjectOverrides = { ungrouped: ["/r-2"] };
		const { res, blocks, over } = runDrop([dir("/r-2"), dir("/r"), dir("/r-1")], repos, init, "/r-2", { id: "project:/r", place: "over" }, "unused");
		expect(res?.revealRoot).toBeUndefined();
		expect(over).toEqual({ projects: [], ungrouped: [] });
		expect(shape(blocks)).toEqual(["G:/r[/r,/r-1,/r-2]"]);
	});

	test("pulling a folder out of a 2-folder project dissolves it; a 3-folder project keeps the remaining two", () => {
		const two: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/a", "/b"] }] };
		// Pull /b out onto /x after -> p1 dissolves (only /a left)
		const r1 = runDrop([dir("/a"), dir("/b"), dir("/x")], {}, two, "/b", { id: "dir:/x", place: "after" });
		expect(r1.over.projects).toEqual([]);
		expect(shape(r1.blocks)).toEqual(["/a", "/x", "/b"]);
		// Pull /b out via its own project header top half -> p1 dissolves
		const r2 = runDrop([dir("/a"), dir("/b"), dir("/x")], {}, two, "/b", { id: "project:manual:p1", place: "before" });
		expect(r2.over.projects).toEqual([]);
		expect(shape(r2.blocks)).toEqual(["/b", "/a", "/x"]);
		// Pull /c out of a 3-folder project -> p1 stays with [/a, /b]
		const three: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/a", "/b", "/c"] }] };
		const r3 = runDrop([dir("/a"), dir("/b"), dir("/c"), dir("/x")], {}, three, "/c", { id: "dir:/x", place: "after" });
		expect(r3.over.projects).toEqual([{ id: "p1", name: "P1", dirs: ["/a", "/b"] }]);
		expect(shape(r3.blocks)).toEqual(["M:manual:p1[/a,/b]", "/x", "/c"]);
	});

	test("pulling a git-repo folder out of a manual project dissolves a 2-folder project and keeps the pulled folder standalone", () => {
		const repos: RepoMap = {
			"/r": repo("/r", "/r", "main"),
			"/r-wt": repo("/r", "/r-wt", "feat"),
			"/notes": null,
		};
		const init: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/notes", "/r-wt"] }] };
		const { blocks, over } = runDrop([dir("/notes"), dir("/r-wt"), dir("/r")], repos, init, "/r-wt", { id: "dir:/r", place: "after" });
		expect(over.projects).toEqual([]);
		expect(over.ungrouped).toContain("/r-wt");
		expect(shape(blocks)).toEqual(["/notes", "/r", "/r-wt"]);

		// Pulling the non-git folder out instead dissolves p1 and lets /r-wt return to its git project with /r
		const r2 = runDrop([dir("/notes"), dir("/r-wt"), dir("/r")], repos, init, "/notes", { id: "dir:/r", place: "after" });
		expect(r2.over).toEqual({ projects: [], ungrouped: [] });
		expect(shape(r2.blocks)).toEqual(["G:/r[/r,/r-wt]", "/notes"]);

		// leaveToStandalone on a 2-folder manual project of same-repo worktrees dissolves it and marks the leaving folder ungrouped
		const sameRepo: ProjectOverrides = { projects: [{ id: "p2", name: "P2", dirs: ["/r", "/r-wt"] }] };
		const sameBlocks = projectBlocks([dir("/r"), dir("/r-wt")], repos, sameRepo);
		const projBlock = sameBlocks[0]!;
		expect(projBlock.kind).toBe("project");
		if (projBlock.kind === "project") {
			const next = leaveToStandalone(sameRepo, "/r-wt", projBlock, sameBlocks, repos);
			expect(next).toEqual({ projects: [], ungrouped: ["/r-wt"] });
			expect(shape(projectBlocks([dir("/r"), dir("/r-wt")], repos, next))).toEqual(["/r", "/r-wt"]);
		}
	});

	test("moving a folder from a 2-folder project P1 onto P2 transfers it and dissolves P1", () => {
		const init: ProjectOverrides = {
			projects: [
				{ id: "p1", name: "P1", dirs: ["/a", "/d"] },
				{ id: "p2", name: "P2", dirs: ["/b", "/c"] },
			],
		};
		const { blocks, over } = runDrop([dir("/a"), dir("/d"), dir("/b"), dir("/c")], {}, init, "/a", { id: "dir:/b", place: "over" });
		expect(over.projects).toEqual([{ id: "p2", name: "P2", dirs: ["/b", "/c", "/a"] }]);
		expect(shape(blocks)).toEqual(["/d", "M:manual:p2[/b,/c,/a]"]);
	});

	test("dropping a folder onto the sole visible member of a collapsed manual project reuses and reveals that project", () => {
		const init: ProjectOverrides = { projects: [{ id: "p1", name: "회사", dirs: ["/a", "/hidden"] }] };
		const { res, blocks, over } = runDrop([dir("/a"), dir("/b")], {}, init, "/b", { id: "dir:/a", place: "over" }, "unused-new-id");
		expect(res?.revealRoot).toBe("manual:p1");
		expect(over.projects).toEqual([{ id: "p1", name: "회사", dirs: ["/a", "/hidden", "/b"] }]);
		expect(shape(blocks)).toEqual(["M:manual:p1[/a,/b]"]);
	});

	test("reordering a standalone folder past a folded project moves it cleanly around the whole project", () => {
		const init: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/b", "/c"] }] };
		const { blocks } = runDrop([dir("/a"), dir("/b"), dir("/c"), dir("/d")], {}, init, "/a", { id: "project:manual:p1", place: "after" });
		expect(shape(blocks)).toEqual(["M:manual:p1[/b,/c]", "/a", "/d"]);
	});

	test("reordering within a manual project whose members are non-contiguous in dirOrder never jumps the project block", () => {
		// dirOrder has /x between /a and /b, so P1 is anchored at /a (index 0) above /x.
		const init: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/a", "/b"] }] };
		const { res, blocks } = runDrop([dir("/a"), dir("/x"), dir("/b")], {}, init, "/a", { id: "dir:/b", place: "after" });
		expect(res?.dirOrder).toBeUndefined();
		expect(shape(blocks)).toEqual(["M:manual:p1[/b,/a]", "/x"]);
	});

	test("reordering within a git project without main checkout keeps the project block anchored above interleaved folders", () => {
		const repos: RepoMap = {
			"/r-1": repo("/r", "/r-1", "f1"),
			"/r-2": repo("/r", "/r-2", "f2"),
			"/x": null,
		};
		const { blocks } = runDrop([dir("/r-1"), dir("/x"), dir("/r-2")], repos, {}, "/r-1", { id: "dir:/r-2", place: "after" });
		expect(shape(blocks)).toEqual(["G:/r[/r-2,/r-1]", "/x"]);
	});

	test("dropping before/after a project anchors against its earliest member in dirOrder, not internal member order", () => {
		// dirOrder is [/a, /x, /b], P1 has internal order [/b, /a]: P1 renders at /a's slot (before /x).
		const init: ProjectOverrides = { projects: [{ id: "p1", name: "P1", dirs: ["/b", "/a"] }] };
		const afterRes = runDrop([dir("/a"), dir("/x"), dir("/b"), dir("/z")], {}, init, "/z", { id: "project:manual:p1", place: "after" });
		expect(shape(afterRes.blocks)).toEqual(["M:manual:p1[/b,/a]", "/z", "/x"]);
		const beforeRes = runDrop([dir("/a"), dir("/x"), dir("/b"), dir("/z")], {}, init, "/z", { id: "project:manual:p1", place: "before" });
		expect(shape(beforeRes.blocks)).toEqual(["/z", "M:manual:p1[/b,/a]", "/x"]);
	});
});
