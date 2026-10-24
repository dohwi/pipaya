import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { CopyFlag as CopyFlagType } from "../src/lib/copy-flag.svelte";

// Compile the real rune module with Svelte; the clipboard it asks is a stand-in the test controls.
let CopyFlag: typeof CopyFlagType;
let setResult: (v: boolean) => void;
let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".copy-flag-"));
	const source = ts.transpileModule(await Bun.file(resolve("src/lib/copy-flag.svelte.ts")).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	await writeFile(join(dir, "copy-flag.mjs"), compileModule(source, { filename: "copy-flag.svelte.js", generate: "client" }).js.code.replace('"./clipboard"', '"./clipboard.mjs"'));
	await writeFile(join(dir, "clipboard.mjs"), `let ok = true; export const __set = (v) => (ok = v); export const copyText = async (t) => { globalThis.__copied = t; return ok; };`);
	({ CopyFlag } = await import(join(dir, "copy-flag.mjs")));
	setResult = (await import(join(dir, "clipboard.mjs"))).__set;
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CopyFlag", () => {
	test("a successful copy raises the flag, then lowers it after the pause", async () => {
		setResult(true);
		const f = new CopyFlag(20);
		expect(await f.copy("hello")).toBe(true);
		expect((globalThis as { __copied?: string }).__copied).toBe("hello");
		expect(f.done).toBe(true);
		await wait(40);
		expect(f.done).toBe(false);
	});
	test("a failed copy leaves the flag down", async () => {
		setResult(false);
		const f = new CopyFlag(20);
		expect(await f.copy("x")).toBe(false);
		expect(f.done).toBe(false);
		setResult(true);
	});
	test("copying again while the flag is up restarts the pause", async () => {
		const f = new CopyFlag(40);
		await f.copy("a");
		await wait(25);
		await f.copy("b");
		await wait(25);
		expect(f.done).toBe(true); // 50ms after the first copy, but only 25ms after the second
		await wait(30);
		expect(f.done).toBe(false);
	});
	test("dispose cancels the pending reset", async () => {
		const f = new CopyFlag(20);
		await f.copy("a");
		f.dispose();
		await wait(40);
		expect(f.done).toBe(true);
	});
});
