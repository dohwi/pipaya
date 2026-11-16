import { describe, expect, test } from "bun:test";
import { fingerprint, fromCache, shapeOf, toCache } from "../src/lib/list-cache";

const session = (id: string, cwd: string, over: Record<string, unknown> = {}) =>
	({ id, title: id, name: id, purpose: "", cwd, provider: "p", model: "m", thinkingLevel: "off", systemPrompt: "long prompt", tools: [], parentId: null, closed: false, createdAt: 1, updatedAt: 1, ...over }) as never;
const term = (id: string, cwd: string) => ({ id, title: id, cwd, shell: "/bin/sh", pty: true, pid: 1, createdAt: 1 }) as never;

describe("list cache", () => {
	const fp = fingerprint("http://a:1", "tok");
	const lists = { sessions: [session("a", "/w/x"), session("b", "/w/y")], groups: [], terminals: [term("t", "/w/x")] };

	test("the fingerprint tells connections apart and never contains the token", () => {
		expect(fingerprint("http://a:1", "tok")).toBe(fp);
		expect(fingerprint("http://a:1", "other")).not.toBe(fp);
		expect(fingerprint("http://b:1", "tok")).not.toBe(fp);
		expect(fp).not.toContain("tok");
	});

	test("round trip keeps what the sidebar draws and drops the system prompt", () => {
		const c = toCache(fp, lists, { root: "/w", home: "/h", workdirs: [{ path: "x", cwd: "/w/x", active: 1, closed: 0, updatedAt: 1 }] }, 1000);
		const back = fromCache(JSON.parse(JSON.stringify(c)), fp, 2000);
		expect(back?.sessions.map((s) => s.id)).toEqual(["a", "b"]);
		expect(back?.sessions[0]?.systemPrompt).toBe("");
		expect(back?.terminals).toHaveLength(1);
		expect(back?.workspace).toEqual({ root: "/w", home: "/h" });
	});

	test("another connection, an old or a future copy, or a broken one is not used", () => {
		const c = toCache(fp, lists, null, 1000);
		expect(fromCache(c, fingerprint("http://a:1", "new-token"), 2000)).toBeNull();
		expect(fromCache(c, fp, 1000 + 31 * 24 * 3600_000)).toBeNull();
		expect(fromCache(c, fp, 1000 - 3600_000)).toBeNull();
		expect(fromCache({ ...c, v: 99 }, fp, 2000)).toBeNull();
		expect(fromCache({ ...c, sessions: [{ id: 1 }] }, fp, 2000)).toBeNull();
		expect(fromCache("nope", fp, 2000)).toBeNull();
		expect(fromCache(null, fp, 2000)).toBeNull();
	});

	test("the shape is the drawn tabs per folder, capped, and survives a copy that cannot be shown", () => {
		expect(shapeOf(toCache(fp, lists, null, 1, [2, 1]))).toEqual([2, 1]);
		expect(shapeOf(toCache(fp, lists, null, 1, [9, 3, 1, 5]))).toEqual([4, 3, 1]);
		expect(shapeOf({ ...toCache(fp, lists, null, 1, [3]), fp: "other", at: 0 })).toEqual([3]);
		expect(shapeOf(toCache(fp, lists, null, 1))).toBeNull();
		expect(shapeOf({ shape: [0, -1] })).toBeNull();
		expect(shapeOf("x")).toBeNull();
	});
});
