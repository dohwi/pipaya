import { describe, expect, test } from "bun:test";
import { absoluteWorkdir, breadcrumbs, cdArgOf, cdHint, commonPrefix, expandHome, filterDirs, splitTyped, tabComplete, typedMatches } from "../src/lib/workdir-path";

const ctx = { root: "/home/u/workspace", home: "/home/u" };

describe("expandHome", () => {
	test("expands ~ and ~/x only", () => {
		expect(expandHome("~", "/home/u")).toBe("/home/u");
		expect(expandHome("~/work/a", "/home/u/")).toBe("/home/u/work/a");
		expect(expandHome("~bob/x", "/home/u")).toBe("~bob/x");
		expect(expandHome("a/~/b", "/home/u")).toBe("a/~/b");
		expect(expandHome("~/x", undefined)).toBe("~/x");
	});
});

describe("cdArgOf", () => {
	test("reads the argument of /cd", () => {
		expect(cdArgOf("/cd ~/wo")).toBe("~/wo");
		expect(cdArgOf("/cd ")).toBe("");
		expect(cdArgOf("/cd")).toBeNull();
		expect(cdArgOf("/cdx a")).toBeNull();
		expect(cdArgOf("/cd a\nb")).toBeNull();
	});
});

describe("cdHint", () => {
	test("home", () => {
		expect(cdHint("~", ctx)).toEqual({ dir: "/home/u", prefix: "~/", filter: "" });
		expect(cdHint("~/wo", ctx)).toEqual({ dir: "/home/u", prefix: "~/", filter: "wo" });
		expect(cdHint("~/workspace/pi", ctx)).toEqual({ dir: "/home/u/workspace", prefix: "~/workspace/", filter: "pi" });
		expect(cdHint("~/", { root: ctx.root })).toBeNull();
	});
	test("absolute", () => {
		expect(cdHint("/", ctx)).toEqual({ dir: "/", prefix: "/", filter: "" });
		expect(cdHint("/etc/ng", ctx)).toEqual({ dir: "/etc", prefix: "/etc/", filter: "ng" });
	});
	test("relative to the workspace root", () => {
		expect(cdHint("", ctx)).toEqual({ dir: "/home/u/workspace", prefix: "", filter: "" });
		expect(cdHint("pr", ctx)).toEqual({ dir: "/home/u/workspace", prefix: "", filter: "pr" });
		expect(cdHint("./a/b", ctx)).toEqual({ dir: "/home/u/workspace/a", prefix: "./a/", filter: "b" });
		expect(cdHint("../x", ctx)).toBeNull();
	});
});

describe("filterDirs / commonPrefix", () => {
	const e = [".git", "pipaya", "pipaya-wiki", "app", "Pipe"].map((name) => ({ name }));
	test("hides dot folders unless typed", () => {
		expect(filterDirs(e, "").map((x) => x.name)).toEqual(["pipaya", "pipaya-wiki", "app", "Pipe"]);
		expect(filterDirs(e, ".g").map((x) => x.name)).toEqual([".git"]);
	});
	test("prefix matches first, then contains", () => {
		expect(filterDirs(e, "pip").map((x) => x.name)).toEqual(["pipaya", "pipaya-wiki", "Pipe"]);
		expect(filterDirs(e, "ap").map((x) => x.name)).toEqual(["app"]);
		expect(filterDirs(e, "ya").map((x) => x.name)).toEqual(["pipaya", "pipaya-wiki"]);
	});
	test("common prefix", () => {
		expect(commonPrefix(["pipaya", "pipaya-wiki"])).toBe("pipaya");
		expect(commonPrefix([])).toBe("");
	});
});

describe("typing a path", () => {
	test("the directory to list and the part to filter by", () => {
		expect(splitTyped("/a/b/par")).toEqual({ dir: "/a/b", part: "par" });
		expect(splitTyped("/a/b/")).toEqual({ dir: "/a/b", part: "" });
		expect(splitTyped("/par")).toEqual({ dir: "/", part: "par" });
		expect(splitTyped("par")).toEqual({ dir: "", part: "par" });
	});
	test("breadcrumbs climb from the root", () => {
		expect(breadcrumbs("/")).toEqual([{ name: "/", path: "/" }]);
		expect(breadcrumbs("/a/b")).toEqual([{ name: "/", path: "/" }, { name: "a", path: "/a" }, { name: "b", path: "/a/b" }]);
		expect(breadcrumbs("")).toEqual([{ name: "/", path: "/" }]);
	});
	test("workspace entries become absolute", () => {
		expect(absoluteWorkdir("/x", "/w")).toBe("/x");
		expect(absoluteWorkdir(".", "/w")).toBe("/w");
		expect(absoluteWorkdir("a/b", "/w")).toBe("/w/a/b");
		expect(absoluteWorkdir(".", undefined)).toBe("");
	});
	test("matches only filter once the list belongs to the folder being typed", () => {
		const list = [{ name: "src" }, { name: "Spec" }, { name: "docs" }];
		expect(typedMatches(list, "/w/s", "/w").map((d) => d.name)).toEqual(["src", "Spec"]);
		expect(typedMatches(list, "/w/s", "/other").length).toBe(3);
		expect(typedMatches(list, "/w/", "/w").length).toBe(3);
	});
});

describe("Tab completion", () => {
	test("the only match is finished with a slash", () => {
		expect(tabComplete("/w", ["src"], undefined)).toEqual({ text: "/w/src/", whole: true });
	});
	test("several matches complete to their shared start and stay open", () => {
		expect(tabComplete("/w", ["src", "srv"], undefined)).toEqual({ text: "/w/sr", whole: false });
	});
	test("a highlighted folder wins and is finished", () => {
		expect(tabComplete("/w", ["src", "srv"], "srv")).toEqual({ text: "/w/srv/", whole: true });
	});
	test("at the root there is no doubled slash", () => {
		expect(tabComplete("/", ["etc"], undefined)).toEqual({ text: "/etc/", whole: true });
	});
});
