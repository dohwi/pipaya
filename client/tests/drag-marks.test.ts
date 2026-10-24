import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { DragMarks as DragMarksType } from "../src/lib/drag-marks.svelte";

// Compile the real rune module with Svelte, rather than substituting fake $state globals (as tests/store-parts.test.ts does).
let DragMarks: typeof DragMarksType;
let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".drag-marks-"));
	const source = ts.transpileModule(await Bun.file(resolve("src/lib/drag-marks.svelte.ts")).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	await writeFile(join(dir, "drag-marks.mjs"), compileModule(source, { filename: "drag-marks.svelte.js", generate: "client" }).js.code);
	({ DragMarks } = await import(join(dir, "drag-marks.mjs")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("row highlight", () => {
	test("hovering a row marks it, leaving clears it", () => {
		const m = new DragMarks();
		m.hover("a", true);
		expect(m.over("a")).toBe(true);
		expect(m.over("b")).toBe(false);
		m.hover("a", false);
		expect(m.over("a")).toBe(false);
	});
	test("leaving a row does not clear the mark of the row that took over", () => {
		const m = new DragMarks();
		m.hover("a", true);
		m.hover("b", true);
		m.hover("a", false); // the old row's leave arrives after the new row's enter
		expect(m.over("b")).toBe(true);
	});
});

describe("tab drop line", () => {
	test("before and after sit on one row at a time", () => {
		const m = new DragMarks();
		m.setTab("a", "before");
		expect(m.tabLine("a")).toBe("before");
		expect(m.tabLine("b")).toBeNull();
		m.setTab("b", "after");
		expect(m.tabLine("a")).toBeNull();
		expect(m.tabLine("b")).toBe("after");
	});
	test("clearing a row that does not hold the line leaves it alone", () => {
		const m = new DragMarks();
		m.setTab("a", "after");
		m.setTab("b", null);
		expect(m.tabLine("a")).toBe("after");
		m.setTab("a", null);
		expect(m.tabLine("a")).toBeNull();
	});
});

describe("carried blocks", () => {
	test("the carried block fades and the block it would land beside shows a line", () => {
		const m = new DragMarks();
		m.setBlock("dir:/a", { id: "dir:/b", after: true });
		expect(m.blockMark("dir:/a")).toEqual({ carried: true, before: false, after: false });
		expect(m.blockMark("dir:/b")).toEqual({ carried: false, before: false, after: true });
		expect(m.blockMark("dir:/c")).toEqual({ carried: false, before: false, after: false });
	});
	test("a block never draws a line beside itself", () => {
		const m = new DragMarks();
		m.setBlock("dir:/a", { id: "dir:/a", after: false });
		expect(m.blockMark("dir:/a")).toEqual({ carried: true, before: false, after: false });
	});
	test("dropping clears everything", () => {
		const m = new DragMarks();
		m.setBlock("server:s", { id: "server:t", after: false });
		expect(m.blockMark("server:t").before).toBe(true);
		m.setBlock(null, null);
		expect(m.blockMark("server:s").carried).toBe(false);
		expect(m.blockMark("server:t").before).toBe(false);
	});
});
