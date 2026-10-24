import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { InlineRename as InlineRenameType } from "../src/lib/inline-rename.svelte";

// Compile the real rune module with Svelte, rather than substituting fake $state globals (as tests/store-parts.test.ts does).
let InlineRename: typeof InlineRenameType;
let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".inline-rename-"));
	const source = ts.transpileModule(await Bun.file(resolve("src/lib/inline-rename.svelte.ts")).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	await writeFile(join(dir, "inline-rename.mjs"), compileModule(source, { filename: "inline-rename.svelte.js", generate: "client" }).js.code);
	({ InlineRename } = await import(join(dir, "inline-rename.mjs")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("InlineRename", () => {
	test("starting edits that row with its current name", () => {
		const r = new InlineRename();
		r.start("a", "Old");
		expect(r.is("a")).toBe(true);
		expect(r.is("b")).toBe(false);
		expect(r.draft).toBe("Old");
	});
	test("commit returns what to save and leaves editing", () => {
		const r = new InlineRename();
		r.start("a", "Old");
		r.draft = "New name";
		expect(r.commit()).toEqual({ id: "a", name: "New name" });
		expect(r.id).toBeNull();
	});
	test("the draft is saved as typed, only a blank one is refused", () => {
		const r = new InlineRename();
		r.start("a", "x");
		r.draft = "  spaced  ";
		expect(r.commit()).toEqual({ id: "a", name: "  spaced  " });
		r.start("a", "x");
		r.draft = "   ";
		expect(r.commit()).toBeNull();
		expect(r.id).toBeNull();
	});
	test("committing when nothing is being edited saves nothing", () => {
		const r = new InlineRename();
		r.draft = "stray";
		expect(r.commit()).toBeNull();
	});
	test("cancel leaves editing without saving", () => {
		const r = new InlineRename();
		r.start("a", "Old");
		r.draft = "New";
		r.cancel();
		expect(r.id).toBeNull();
		expect(r.commit()).toBeNull();
	});
	test("blur after Enter does not save twice (the second commit finds nothing)", () => {
		const r = new InlineRename();
		r.start("a", "Old");
		r.draft = "New";
		expect(r.commit()).not.toBeNull();
		expect(r.commit()).toBeNull();
	});
});
