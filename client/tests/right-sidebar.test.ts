import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { RightSidebarState as StateType } from "../src/lib/right-sidebar.svelte";

// Compile the real rune module with Svelte; storage and the motion token are stand-ins the test controls.
let RightSidebarState: typeof StateType;
let dir: string;
const js = (src: string) => ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".right-sidebar-"));
	const mod = compileModule(js(await Bun.file(resolve("src/lib/right-sidebar.svelte.ts")).text()), { filename: "right-sidebar.svelte.js", generate: "client" }).js.code;
	await writeFile(join(dir, "right-sidebar.mjs"), mod.replace('"./number"', '"./number.mjs"').replace('"./persist"', '"./persist.mjs"').replace('"./motion"', '"./motion.mjs"'));
	await writeFile(join(dir, "number.mjs"), js(await Bun.file(resolve("src/lib/number.ts")).text()));
	await writeFile(join(dir, "persist.mjs"), `export const K = { rightSidebar: "r", rightSidebarW: "rw" };
export const read = (k, f) => { const v = globalThis.__store.get(k); return v === undefined ? f : JSON.parse(v); };
export const write = (k, v) => void globalThis.__store.set(k, JSON.stringify(v));`);
	await writeFile(join(dir, "motion.mjs"), `export const ms = () => 100;`);
	({ RightSidebarState } = await import(join(dir, "right-sidebar.mjs")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
beforeEach(() => { (globalThis as { __store?: Map<string, string> }).__store = new Map(); });

// The header's "open" button must not show while the panel is still sliding shut (it would sit beside the panel's own toggle).
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
describe("RightSidebarState", () => {
	test("starts shut, and says so, until the user opens it", () => {
		const r = new RightSidebarState();
		expect(r.open).toBe(false);
		expect(r.shut).toBe(true);
	});

	test("opening takes the header's button away at once", () => {
		const r = new RightSidebarState();
		r.toggle();
		expect(r.open).toBe(true);
		expect(r.shut).toBe(false);
	});

	test("closing hands the button back only after the panel has closed", async () => {
		const r = new RightSidebarState();
		r.toggle();
		r.toggle();
		expect(r.open).toBe(false);
		expect(r.shut).toBe(false); // still sliding: only the panel's own toggle is on screen
		await wait(120);
		expect(r.shut).toBe(true);
	});

	test("a second click while it closes cancels the hand-over: the two buttons are never both live", async () => {
		const r = new RightSidebarState();
		r.toggle();
		r.toggle();
		await wait(20);
		r.toggle(); // open again mid-close
		expect(r.open).toBe(true);
		await wait(120);
		expect(r.shut).toBe(false);
	});

	test("the choice is remembered on the device", () => {
		new RightSidebarState().toggle();
		const again = new RightSidebarState();
		expect(again.open).toBe(true);
		expect(again.shut).toBe(false);
	});

	test("a width outside the limits is clamped, and kept", () => {
		const r = new RightSidebarState();
		r.setWidth(9999);
		expect(r.width).toBe(520);
		r.setWidth(10);
		expect(r.width).toBe(260);
		expect(new RightSidebarState().width).toBe(260);
	});
});
