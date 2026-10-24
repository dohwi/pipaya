import { describe, expect, test } from "bun:test";
import { asWorkdir, connectionState, dirKey, edgeOf, groupKey, newKey, shortName, unreachable } from "../src/lib/sidebar-model";

describe("server state", () => {
	test("the app's connection state maps onto the sidebar's", () => {
		expect(connectionState("online")).toBe("online");
		expect(connectionState("unauthorized")).toBe("unauthorized");
		expect(connectionState("incompatible")).toBe("incompatible");
		expect(connectionState("connecting")).toBe("checking");
		expect(connectionState("offline")).toBe("offline");
		expect(connectionState("anything else")).toBe("offline");
	});
	test("only offline, rejected and incompatible servers are unreachable", () => {
		expect(["online", "checking"].some((s) => unreachable(s as never))).toBe(false);
		expect(["offline", "unauthorized", "incompatible"].every((s) => unreachable(s as never))).toBe(true);
	});
});

describe("folder labels", () => {
	const dirs = [{ path: "/h/a/app" }, { path: "/h/b/app" }, { path: "/h/a/lib" }];
	test("a unique name stands alone", () => {
		expect(shortName("/h/a/lib", dirs, "/h")).toBe("lib");
	});
	test("clashing names borrow parents until they differ", () => {
		expect(shortName("/h/a/app", dirs, "/h")).toBe("a/app");
		expect(shortName("/h/b/app", dirs, "/h")).toBe("b/app");
	});
	test("a path with no segments falls back to the path itself", () => {
		expect(shortName("/", [{ path: "/" }], undefined)).toBe("/");
	});
});

describe("drop position", () => {
	const r = { top: 100, bottom: 140, height: 40 };
	test("edges reorder, the middle pairs", () => {
		expect(edgeOf(104, r, false)).toBe("before");
		expect(edgeOf(136, r, false)).toBe("after");
		expect(edgeOf(120, r, false)).toBeNull();
	});
	test("a carried group has no middle", () => {
		expect(edgeOf(119, r, true)).toBe("before");
		expect(edgeOf(121, r, true)).toBe("after");
	});
});

describe("keys", () => {
	test("the server's default folder is '.', others are absolute", () => {
		expect(asWorkdir("/w", "/w")).toBe(".");
		expect(asWorkdir("/w/x", "/w")).toBe("/w/x");
	});
	test("combined keys cannot collide with plain ones", () => {
		expect(dirKey("s", "/p")).toBe("s\u0000/p");
		expect(groupKey("g")).toBe("group\u0000g");
		expect(newKey(dirKey("s", "."))).toBe("new\u0000s\u0000.");
	});
});
