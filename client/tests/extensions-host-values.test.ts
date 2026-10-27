import { describe, expect, test } from "bun:test";
import { clone, identify, localId, object, plain, string, within, withoutKeybindings } from "../src/lib/extensions/host-values";

describe("what an extension hands over", () => {
	test("string accepts a non-blank text within the limit", () => {
		expect(string("hello", 10)).toBe("hello");
		for (const bad of ["", "   ", "x".repeat(11), 5, null, undefined, {}]) expect(() => string(bad, 10)).toThrow();
	});

	test("object accepts a plain object and refuses arrays, null and scalars", () => {
		expect(object({ a: 1 })).toEqual({ a: 1 });
		for (const bad of [[], null, undefined, "x", 3]) expect(() => object(bad)).toThrow();
	});

	test("plain is the lenient twin: the object, or undefined", () => {
		expect(plain({ a: 1 })).toEqual({ a: 1 });
		for (const v of [[], null, undefined, "x"]) expect(plain(v)).toBeUndefined();
	});

	test("localId allows lowercase words with digits and dashes, starting with a letter", () => {
		expect(localId("my-ext2")).toBe("my-ext2");
		for (const bad of ["My", "2fast", "-x", "a b", "a_b", "", "x".repeat(41)]) expect(() => localId(bad)).toThrow();
	});
});

describe("clone", () => {
	test("copies as plain JSON: functions and undefined drop out, nothing is shared", () => {
		const source = { a: 1, f: () => 1, u: undefined, nested: { list: [1, 2] } };
		const copy = clone(source);
		expect(copy).toEqual({ a: 1, nested: { list: [1, 2] } });
		copy.nested.list.push(3);
		expect(source.nested.list).toEqual([1, 2]);
	});
});

describe("identify", () => {
	test("finds the id and name of an entry that failed to parse, trimmed to a safe length", () => {
		expect(identify({ package: { manifest: { id: "x", name: "X" } } })).toEqual({ id: "x", name: "X" });
		expect(identify({ manifest: { id: "y" } })).toEqual({ id: "y" });
		expect(identify({ package: { manifest: { id: "i".repeat(200) } } }).id).toHaveLength(80);
		for (const junk of [null, 5, [], { package: 3 }, { package: { manifest: { id: "" } } }]) expect(identify(junk)).toEqual({});
	});
});

describe("withoutKeybindings", () => {
	test("keeps the document, or drops only the user's shortcuts", () => {
		const doc = { theme: "dark", keybindings: { a: "Ctrl+A" } };
		expect(withoutKeybindings(doc, false)).toBe(doc);
		expect(withoutKeybindings(doc, true)).toEqual({ theme: "dark" });
		expect(doc.keybindings).toEqual({ a: "Ctrl+A" });
	});
});

describe("within", () => {
	test("returns the result when the task finishes in time", async () => {
		expect(await within(100, async () => "ok")).toBe("ok");
	});

	test("rejects at the deadline and aborts the signal, even if the task ignores it", async () => {
		let aborted = false;
		await expect(within(20, (signal) => new Promise<string>(() => signal.addEventListener("abort", () => (aborted = true))))).rejects.toThrow();
		expect(aborted).toBe(true);
	});

	test("a task failure passes through unchanged", async () => {
		await expect(within(100, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
	});
});
