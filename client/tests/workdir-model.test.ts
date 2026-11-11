import { describe, expect, test } from "bun:test";
import { normalizeWorkdir, relPath, workdirAbs, workdirText } from "../src/lib/workdir-model";

const ctx = { root: "/srv/work", home: "/home/me" };

describe("normalizeWorkdir", () => {
	test("the root, empty input and ./ prefixes are '.'", () => {
		expect(normalizeWorkdir("", ctx)).toEqual({ ok: true, path: "." });
		expect(normalizeWorkdir("  ./  ", ctx)).toEqual({ ok: true, path: "." });
		expect(normalizeWorkdir("/srv/work", ctx)).toEqual({ ok: true, path: "." });
	});
	test("a path inside the root becomes relative, one outside stays absolute", () => {
		expect(normalizeWorkdir("/srv/work/a/b/", ctx)).toEqual({ ok: true, path: "a/b" });
		expect(normalizeWorkdir("./a", ctx)).toEqual({ ok: true, path: "a" });
		expect(normalizeWorkdir("/etc", ctx)).toEqual({ ok: true, path: "/etc" });
	});
	test("~ expands to home, and fails without one", () => {
		expect(normalizeWorkdir("~/p", ctx)).toEqual({ ok: true, path: "/home/me/p" });
		expect(normalizeWorkdir("~", { root: "/srv/work" })).toEqual({ ok: false, error: "home" });
		expect(normalizeWorkdir("~/x", { root: "/srv/work", home: null })).toEqual({ ok: false, error: "home" });
	});
	test("refuses .. and empty segments in relative paths, and bad characters", () => {
		expect(normalizeWorkdir("a/../b", ctx)).toEqual({ ok: false, error: "relative" });
		expect(normalizeWorkdir("a//b", ctx)).toEqual({ ok: false, error: "relative" });
		expect(normalizeWorkdir("a\\b", ctx)).toEqual({ ok: false, error: "chars" });
		expect(normalizeWorkdir("a\0b", ctx)).toEqual({ ok: false, error: "chars" });
	});
	test("Windows roots: either slash and any letter case; reserved characters refused", () => {
		const win = { root: "C:\\Work" };
		expect(normalizeWorkdir("c:/work/app", win)).toEqual({ ok: true, path: "app" });
		expect(normalizeWorkdir("D:\\other", win)).toEqual({ ok: true, path: "D:\\other" });
		expect(normalizeWorkdir("C:\\a?b", win)).toEqual({ ok: false, error: "chars" });
	});
});

describe("workdir display", () => {
	test("relPath without a root leaves the path alone", () => {
		expect(relPath("/x/y", null)).toBe("/x/y");
		expect(relPath("/srv/work/a", "/srv/work")).toBe("a");
	});
	test("workdirAbs joins with the root's separator", () => {
		expect(workdirAbs(".", "/srv/work")).toBe("/srv/work");
		expect(workdirAbs("a", "/srv/work")).toBe("/srv/work/a");
		expect(workdirAbs("a", "C:\\Work")).toBe("C:\\Work\\a");
		expect(workdirAbs("/abs", "/srv/work")).toBe("/abs");
		expect(workdirAbs(".", null)).toBe("");
	});
	test("workdirText is null only for '.' with no root", () => {
		expect(workdirText(".", null)).toBeNull();
		expect(workdirText(".", "/srv/work")).toBe("/srv/work");
		expect(workdirText("a", "/srv/work")).toBe("/srv/work/a");
		expect(workdirText("/abs", null)).toBe("/abs");
	});
});
