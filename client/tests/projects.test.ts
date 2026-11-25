import { describe, expect, test } from "bun:test";
import { branchLabel, dissolveProject, flattenBlocks, joinProject, leaveProject, manualDirDividers, projectBlocks, subPath, tabLead, type RepoMap } from "../src/lib/projects";
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

	test("a hand-made project wins over the repository and keeps its own order, even with one folder", () => {
		const over = { projects: [{ id: "c", name: "회사", dirs: ["/w/web", "/w/api"] }] };
		expect(roots(projectBlocks(dirs, repos, over))).toEqual(["/w/app[/w/app,/w/app-x]", "manual:c[/w/web,/w/api]"]);
		expect(roots(projectBlocks([dir("/w/web")], repos, over))).toEqual(["manual:c[/w/web]"]);
	});
	test("a folder taken out of its repository stands alone, and the rest of the project with one folder is no project", () => {
		expect(roots(projectBlocks(dirs, repos, { ungrouped: ["/w/app-x"] }))).toEqual(["/w/app", "/w/app-x", "/w/api", "/w/web"]);
	});
	test("joining: a new project with another folder, then a third one into it; a git folder can go back", () => {
		let o = joinProject({}, "/w/web", { with: "/w/api", id: "p", name: "api" });
		expect(o.projects).toEqual([{ id: "p", name: "api", dirs: ["/w/api", "/w/web"] }]);
		o = joinProject(o, "/w/app-x", { root: "manual:p" });
		expect(o.projects[0]!.dirs).toEqual(["/w/api", "/w/web", "/w/app-x"]);
		o = joinProject(o, "/w/app-x", { root: "/w/app" });
		expect(o.projects[0]!.dirs).toEqual(["/w/api", "/w/web"]);
		expect(o.ungrouped).toEqual([]);
	});
	test("leaving: out of a hand-made project, or marked apart from its repository; dissolving undoes the project", () => {
		const o = { projects: [{ id: "p", name: "x", dirs: ["/w/api", "/w/web"] }], ungrouped: [] };
		expect(leaveProject(o, "/w/web", false)).toEqual({ projects: [{ id: "p", name: "x", dirs: ["/w/api"] }], ungrouped: [] });
		expect(leaveProject(o, "/w/app-x", true).ungrouped).toEqual(["/w/app-x"]);
		expect(leaveProject({ projects: [{ id: "p", name: "x", dirs: ["/w/app-x"] }] }, "/w/app-x", true)).toEqual({ projects: [], ungrouped: [] });
		expect(dissolveProject(o, "p").projects).toEqual([]);
	});
});

describe("manualDirDividers", () => {
	test("marks the first tab of each non-empty folder after the first", () => {
		expect([...manualDirDividers([dir("/a", "a1", "a2"), dir("/b", "b1"), dir("/c", "c1")])]).toEqual(["b1", "c1"]);
	});
	test("skips empty folders so no leading or duplicate divider is drawn", () => {
		expect([...manualDirDividers([dir("/empty"), dir("/a", "a1"), dir("/mid"), dir("/b", "b1")])]).toEqual(["b1"]);
		expect([...manualDirDividers([dir("/a", "a1")])]).toEqual([]);
		expect([...manualDirDividers([])]).toEqual([]);
	});
});

describe("tabLead", () => {
	test("manual project returns null so the tab bar uses a divider instead of text labels", () => {
		const r = repo("/home/u/w/backend/billing", "/home/u/w/backend/billing", "main");
		expect(tabLead("/home/u/w/backend/billing", { manual: true, repo: r, home: "/home/u" })).toBeNull();
		expect(tabLead("/home/u/w/api", { manual: true, customName: "프록시", home: "/home/u" })).toBeNull();
	});
	test("git project uses fork icon and branch name, with subfolder and detached HEAD handling", () => {
		expect(tabLead("/w/app-x", { manual: false, repo: repo("/w/app", "/w/app-x", "feat/x") })).toEqual({
			icon: "fork",
			label: "feat/x",
			title: "feat/x",
		});
		expect(tabLead("/w/app/client/src", { manual: false, repo: repo("/w/app", "/w/app", "main") })).toEqual({
			icon: "fork",
			label: "client/src",
			title: "client/src (main)",
		});
		expect(tabLead("/w/app-x", { manual: false, repo: repo("/w/app", "/w/app-x", null) })).toEqual({
			icon: "fork",
			label: "app-x",
			title: "app-x",
		});
		expect(tabLead("/w/app-x", { manual: false, customName: "백엔드", repo: repo("/w/app", "/w/app-x", "feat/x") })).toEqual({
			icon: "fork",
			label: "백엔드",
			title: "백엔드",
		});
	});
	test("git project falls back to folder icon and short name when repo info is absent", () => {
		expect(tabLead("/w/notes", { manual: false, repo: null })).toEqual({
			icon: "folder",
			label: "w/notes",
			title: "w/notes",
		});
	});
});
