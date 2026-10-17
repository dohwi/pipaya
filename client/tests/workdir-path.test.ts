import { describe, expect, test } from "bun:test";
import { cdArgOf, cdHint, commonPrefix, expandHome, filterDirs } from "../src/lib/workdir-path";

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
