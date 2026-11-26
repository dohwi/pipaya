import { describe, expect, test } from "bun:test";
import { branchLabel, cleanManualProjects, dissolveProject, flattenBlocks, joinProject, leaveProject, projectBlocks, reorderProjectDir, subPath, tabLead, tabLeads, type RepoMap } from "../src/lib/projects";
import { withoutDirKeys } from "../src/lib/sidebar.svelte";
import type { DirBlock } from "../src/lib/nav";

const tab = (id: string) => ({ kind: "session", id, session: { id } }) as never;
const dir = (path: string, ...ids: string[]): DirBlock => ({ path, tabs: ids.map(tab) });
const repo = (root: string, top: string, branch: string | null) => ({ root, top, branch });

describe("projectBlocks", () => {
	const repos: RepoMap = {
		"/w/app": repo("/w/app", "/w/app", "main"),
		"/w/app-x": repo("/w/app", "/w/app-x", "feat/x"),
		"/w/app/client": repo("/w/app", "/w/app", "main"),
		"/w/blog": repo("/w/blog", "/w/blog", "main"),
		"/w/notes": null,
	};
	test("folders of one repository become one project where its first folder was; the main checkout leads", () => {
		const dirs = [dir("/w/notes", "n"), dir("/w/app-x", "x"), dir("/w/blog", "b"), dir("/w/app", "a"), dir("/w/app/client", "c")];
		const blocks = projectBlocks(dirs, repos);
		expect(blocks.map((b) => (b.kind === "dir" ? b.dir.path : `P:${b.root}`))).toEqual(["/w/notes", "P:/w/app", "/w/blog"]);
		const p = blocks[1]!;
		expect(p.kind === "project" && p.dirs.map((d) => d.path)).toEqual(["/w/app", "/w/app-x", "/w/app/client"]);
		expect(flattenBlocks(blocks).map((d) => d.path)).toEqual(["/w/notes", "/w/app", "/w/app-x", "/w/app/client", "/w/blog"]);
	});
	test("a repository with one folder listed, an unknown folder, and no repository info at all stay plain folders", () => {
		const dirs = [dir("/w/blog", "b"), dir("/w/new", "y")];
		expect(projectBlocks(dirs, repos).every((b) => b.kind === "dir")).toBe(true);
		expect(projectBlocks([dir("/w/app"), dir("/w/app-x")], {}).every((b) => b.kind === "dir")).toBe(true);
	});
});

describe("labels", () => {
	test("a working tree is named by its branch; a folder below it by its path there, the branch after it", () => {
		expect(branchLabel("/w/app-x", repo("/w/app", "/w/app-x", "feat/x"))).toEqual({ name: "feat/x", sub: "" });
		expect(branchLabel("/w/app/client/src", repo("/w/app", "/w/app", "main"))).toEqual({ name: "client/src", sub: "main" });
	});
	test("a detached HEAD falls back to the working tree's folder name", () => {
		expect(branchLabel("/w/app-x", repo("/w/app", "/w/app-x", null))).toEqual({ name: "app-x", sub: "" });
	});
	test("subPath", () => {
		expect(subPath("/a/b/c", "/a")).toBe("b/c");
		expect(subPath("/a", "/a")).toBe("");
		expect(subPath("/ab", "/a")).toBe("");
		expect(subPath("C:\\w\\app\\src", "C:\\w\\app")).toBe("src");
	});
});

describe("withoutDirKeys", () => {
	test("old folder fold entries are dropped; servers, projects and split tabs keep theirs", () => {
		expect(withoutDirKeys(["srv", "srv\u0000/w/app", "group\u0000g1", "project\u0000srv\u0000/w/app"])).toEqual(["srv", "group\u0000g1", "project\u0000srv\u0000/w/app"]);
	});
});

describe("hand-made projects", () => {
	const repos: RepoMap = {
		"/w/app": repo("/w/app", "/w/app", "main"),
		"/w/app-x": repo("/w/app", "/w/app-x", "feat/x"),
		"/w/api": repo("/w/api", "/w/api", "main"),
		"/w/web": null,
	};
	const dirs = [dir("/w/app", "a"), dir("/w/app-x", "x"), dir("/w/api", "b"), dir("/w/web", "c")];
	const roots = (bs: ReturnType<typeof projectBlocks>) => bs.map((b) => (b.kind === "dir" ? b.dir.path : `${b.root}[${b.dirs.map((d) => d.path).join(",")}]`));

	test("a hand-made project wins over the repository, keeps its order, and collapses to a plain folder when only one member is visible", () => {
		const over = { projects: [{ id: "c", name: "회사", dirs: ["/w/web", "/w/api"] }] };
		expect(roots(projectBlocks(dirs, repos, over))).toEqual(["/w/app[/w/app,/w/app-x]", "manual:c[/w/web,/w/api]"]);
		// Only one member visible: renders as a plain folder row instead of a 1-folder project wrapper
		expect(roots(projectBlocks([dir("/w/web")], repos, over))).toEqual(["/w/web"]);
		// A collapsed manual member stays apart from its git repository's automatic project until the project is dissolved
		const split = { projects: [{ id: "m", name: "임시", dirs: ["/w/app-x", "/w/hidden"] }] };
		expect(roots(projectBlocks([dir("/w/app", "a"), dir("/w/app-x", "x")], repos, split))).toEqual(["/w/app", "/w/app-x"]);
		// Legacy 1-dir, intra-project duplicate, or cross-project overlapping manual entries are cleaned (first valid project wins)
		expect(cleanManualProjects([{ id: "one", name: "One", dirs: ["/w/web"] }, { id: "dup", name: "Dup", dirs: ["/w/web", "/w/web"] }])).toEqual([]);
		expect(
			cleanManualProjects([
				{ id: "bad", name: "Bad", dirs: ["/w/a"] },
				{ id: "p1", name: "P1", dirs: ["/w/a", "/w/b"] },
				{ id: "p2", name: "P2", dirs: ["/w/a", "/w/c"] },
			]),
		).toEqual([{ id: "p1", name: "P1", dirs: ["/w/a", "/w/b"] }]);
		expect(roots(projectBlocks([dir("/w/app", "a"), dir("/w/app-x", "x")], repos, { projects: [{ id: "old", name: "Old", dirs: ["/w/app-x"] }] }))).toEqual(["/w/app[/w/app,/w/app-x]"]);
	});
	test("a folder taken out of its repository stands alone, and the rest of the project with one folder is no project", () => {
		expect(roots(projectBlocks(dirs, repos, { ungrouped: ["/w/app-x"] }))).toEqual(["/w/app", "/w/app-x", "/w/api", "/w/web"]);
	});
	test("joining: a new project with another folder, then a third one into it; moving a folder out dissolves a 2-folder source project", () => {
		let o = joinProject({}, "/w/web", { with: "/w/api", id: "p", name: "api" });
		expect(o.projects).toEqual([{ id: "p", name: "api", dirs: ["/w/api", "/w/web"] }]);
		o = joinProject(o, "/w/app-x", { root: "manual:p" });
		expect(o.projects[0]!.dirs).toEqual(["/w/api", "/w/web", "/w/app-x"]);
		o = joinProject(o, "/w/app-x", { root: "/w/app" });
		expect(o.projects[0]!.dirs).toEqual(["/w/api", "/w/web"]);
		expect(o.ungrouped).toEqual([]);
		// Moving one of the remaining two folders into another project dissolves the 1-folder source
		o = joinProject(o, "/w/web", { with: "/w/app", id: "q", name: "app" });
		expect(o.projects).toEqual([{ id: "q", name: "app", dirs: ["/w/app", "/w/web"] }]);
	});
	test("leaving: a 2-folder hand-made project dissolves automatically; a 3-folder one keeps the rest; dissolving undoes the project", () => {
		const two = { projects: [{ id: "p", name: "x", dirs: ["/w/api", "/w/web"] }], ungrouped: [] };
		expect(leaveProject(two, "/w/web", false)).toEqual({ projects: [], ungrouped: [] });
		const three = { projects: [{ id: "p", name: "x", dirs: ["/w/api", "/w/web", "/w/app-x"] }], ungrouped: [] };
		expect(leaveProject(three, "/w/web", false)).toEqual({ projects: [{ id: "p", name: "x", dirs: ["/w/api", "/w/app-x"] }], ungrouped: [] });
		expect(leaveProject(two, "/w/app-x", true).ungrouped).toEqual(["/w/app-x"]);
		expect(leaveProject({ projects: [{ id: "p", name: "x", dirs: ["/w/app-x"] }] }, "/w/app-x", true)).toEqual({ projects: [], ungrouped: ["/w/app-x"] });
		expect(dissolveProject(two, "p").projects).toEqual([]);
	});
	test("joinProject handles self-drop, duplicate manual joins, positional insert, and git project promotion", () => {
		expect(joinProject({}, "/w/web", { with: "/w/web", id: "p", name: "web" })).toEqual({ projects: [], ungrouped: [] });
		const base = { projects: [{ id: "p", name: "x", dirs: ["/w/api", "/w/web"] }], ungrouped: [] };
		expect(joinProject(base, "/w/api", { root: "manual:p" })).toEqual(base);
		expect(joinProject(base, "/w/app-x", { root: "manual:p", at: { path: "/w/api", after: false } }).projects[0]!.dirs).toEqual(["/w/app-x", "/w/api", "/w/web"]);
		// Unrelated folder joining a git project promotes it into a hand-made project
		const promoted = joinProject({}, "/w/web", { root: "/w/app", members: ["/w/app", "/w/app-x"], name: "app", id: "g1", gitRoot: null });
		expect(promoted.projects).toEqual([{ id: "g1", name: "app", dirs: ["/w/app", "/w/app-x", "/w/web"] }]);
		// Same-repo folder joining its git project stays a git project (simply clears ungrouped)
		const rejoined = joinProject({ ungrouped: ["/w/app-x"] }, "/w/app-x", { root: "/w/app", members: ["/w/app"], name: "app", id: "g2", gitRoot: "/w/app" });
		expect(rejoined).toEqual({ projects: [], ungrouped: [] });
	});
	test("reorderProjectDir reorders within a hand-made project and returns null on no-ops", () => {
		const o = { projects: [{ id: "p", name: "x", dirs: ["/a", "/b", "/c"] }], ungrouped: [] };
		expect(reorderProjectDir(o, "p", "/c", "/a", false)?.projects[0]?.dirs).toEqual(["/c", "/a", "/b"]);
		expect(reorderProjectDir(o, "p", "/a", "/b", true)?.projects[0]?.dirs).toEqual(["/b", "/a", "/c"]);
		expect(reorderProjectDir(o, "p", "/a", "/b", false)).toBeNull();
		expect(reorderProjectDir(o, "p", "/a", "/a", true)).toBeNull();
		expect(reorderProjectDir(o, "missing", "/a", "/b", true)).toBeNull();
	});
});

describe("tabLead", () => {
	const home = "/home/u";
	test("a hand-made project always gets the folder icon, even for a folder in a repository", () => {
		const r = repo("/home/u/w/billing", "/home/u/w/billing", "main");
		expect(tabLead("/home/u/w/billing", { manual: true, repo: r, home })).toEqual({ icon: "folder", title: "~/w/billing" });
	});
	test("a hand-made project's title: custom name · full path; empty name or missing home fall back to the path", () => {
		expect(tabLead("/home/u/w/api", { manual: true, customName: "프록시", home })).toEqual({ icon: "folder", title: "프록시 · ~/w/api" });
		expect(tabLead("/home/u/w/api", { manual: true, customName: "", home }).title).toBe("~/w/api");
		expect(tabLead("/home/u/w/api", { manual: true, customName: "프록시" }).title).toBe("프록시 · /home/u/w/api");
		expect(tabLead("/w/api", { manual: true, customName: "/w/api" }).title).toBe("/w/api");
	});
	test("git project: fork icon and branch; a subfolder shows its path with the branch after; detached HEAD uses the folder name", () => {
		expect(tabLead("/w/app-x", { manual: false, repo: repo("/w/app", "/w/app-x", "feat/x") })).toEqual({ icon: "fork", title: "feat/x" });
		expect(tabLead("/w/app/client/src", { manual: false, repo: repo("/w/app", "/w/app", "main") })).toEqual({ icon: "fork", title: "client/src (main)" });
		expect(tabLead("/w/app-x", { manual: false, repo: repo("/w/app", "/w/app-x", null) })).toEqual({ icon: "fork", title: "app-x" });
	});
	test("git project: a custom name wins; without repo info it is a folder with its short name", () => {
		expect(tabLead("/w/app-x", { manual: false, customName: "백엔드", repo: repo("/w/app", "/w/app-x", "feat/x") })).toEqual({ icon: "fork", title: "백엔드" });
		expect(tabLead("/w/notes", { manual: false, repo: null })).toEqual({ icon: "folder", title: "w/notes" });
	});
});

describe("tabLeads", () => {
	const lead = (d: DirBlock) => ({ icon: "folder" as const, title: d.path });
	test("the first non-empty folder has no separator, every later one has", () => {
		const out = tabLeads([dir("/a", "a1", "a2"), dir("/b", "b1"), dir("/c", "c1")], lead);
		expect(out).toEqual({
			a1: { icon: "folder", title: "/a", sep: false },
			b1: { icon: "folder", title: "/b", sep: true },
			c1: { icon: "folder", title: "/c", sep: true },
		});
	});
	test("empty folders are skipped at the start, middle and end", () => {
		const out = tabLeads([dir("/e1"), dir("/a", "a1"), dir("/e2"), dir("/b", "b1"), dir("/e3")], lead);
		expect(Object.keys(out)).toEqual(["a1", "b1"]);
		expect(out.a1!.sep).toBe(false);
		expect(out.b1!.sep).toBe(true);
	});
	test("one folder or none gives nothing", () => {
		expect(tabLeads([dir("/a", "a1")], lead)).toEqual({});
		expect(tabLeads([], lead)).toEqual({});
	});
});
