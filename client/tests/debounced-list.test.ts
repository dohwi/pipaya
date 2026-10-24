import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { DebouncedList as DebouncedListType } from "../src/lib/debounced-list.svelte";

// Compile the real rune modules with Svelte, rather than substituting fake $state globals (as tests/store-parts.test.ts does).
let DebouncedList: typeof DebouncedListType;
let dir: string;
async function compileTo(name: string, outName: string, rewrite: (code: string) => string = (c) => c) {
	const source = ts.transpileModule(await Bun.file(resolve(`src/lib/${name}`)).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	const code = compileModule(source, { filename: outName.replace(".mjs", ".svelte.js"), generate: "client" }).js.code;
	await writeFile(join(dir, outName), rewrite(code));
}
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".debounced-list-"));
	const abortable = ts.transpileModule(await Bun.file(resolve("src/lib/abortable.ts")).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	await writeFile(join(dir, "abortable.mjs"), abortable);
	await compileTo("debounced-list.svelte.ts", "debounced-list.mjs", (c) => c.replace('"./abortable"', '"./abortable.mjs"'));
	({ DebouncedList } = await import(join(dir, "debounced-list.mjs")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const later = <T>() => {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
};

describe("DebouncedList", () => {
	test("a null query clears everything and asks nothing", () => {
		const l = new DebouncedList<string, number>(5);
		let asked = 0;
		l.follow("a", async () => (asked++, [1]))?.();
		l.rows = [9];
		l.follow(null, async () => (asked++, [2]));
		expect(l.rows).toEqual([]);
		expect(l.for).toBeNull();
		expect(l.loaded).toBe(false);
		expect(asked).toBe(0);
	});
	test("no loader (offline) clears like a null query", () => {
		const l = new DebouncedList<string, number>(5);
		l.rows = [1];
		l.loaded = true;
		l.follow("a", null);
		expect(l.rows).toEqual([]);
		expect(l.loaded).toBe(false);
	});
	test("an answer arrives after the pause and says which query it is for", async () => {
		const l = new DebouncedList<string, string>(10);
		l.follow("src", async (q) => [`${q}/a`, `${q}/b`]);
		expect(l.loaded).toBe(false);
		await wait(40);
		expect(l.rows).toEqual(["src/a", "src/b"]);
		expect(l.for).toBe("src");
		expect(l.loaded).toBe(true);
	});
	test("a failure is an empty, loaded answer for that query", async () => {
		const l = new DebouncedList<string, string>(5);
		l.follow("x", async () => { throw new Error("boom"); });
		await wait(30);
		expect(l.rows).toEqual([]);
		expect(l.for).toBe("x");
		expect(l.loaded).toBe(true);
	});
	test("cancelling during the pause asks nothing", async () => {
		const l = new DebouncedList<string, string>(20);
		let asked = 0;
		const cancel = l.follow("x", async () => (asked++, []));
		cancel?.();
		await wait(50);
		expect(asked).toBe(0);
		expect(l.loaded).toBe(false);
	});
	test("a slow answer to an old query never overwrites the newer one", async () => {
		const l = new DebouncedList<string, string>(1);
		const slow = later<string[]>();
		const cancelOld = l.follow("old", () => slow.promise);
		await wait(10);
		cancelOld?.();
		l.follow("new", async () => ["fresh"]);
		await wait(20);
		slow.resolve(["stale"]);
		await wait(10);
		expect(l.rows).toEqual(["fresh"]);
		expect(l.for).toBe("new");
	});
	test("the rows keep answering the old query until the new one arrives (the view compares `for`)", async () => {
		const l = new DebouncedList<string, string>(5);
		l.follow("a", async () => ["a1"]);
		await wait(30);
		l.follow("b", async () => ["b1"]);
		expect(l.for).toBe("a");
		await wait(30);
		expect(l.for).toBe("b");
	});
});
