import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { ExtensionTasks as ExtensionTasksType } from "../src/lib/extension-tasks.svelte";

// Compile the real rune module with Svelte, rather than substituting fake $state globals (as tests/store-parts.test.ts does).
let ExtensionTasks: typeof ExtensionTasksType;
let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".extension-tasks-"));
	// the module only imports a type; strip it so the test needs no component
	const src = (await Bun.file(resolve("src/lib/extension-tasks.svelte.ts")).text()).replace(/^import type .*\n/m, "type ImportResult = { tone: string; title: string; detail: string };\n");
	const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	await writeFile(join(dir, "tasks.mjs"), compileModule(js, { filename: "extension-tasks.svelte.js", generate: "client" }).js.code);
	({ ExtensionTasks } = await import(join(dir, "tasks.mjs")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("ExtensionTasks.run", () => {
	test("a key is busy while its task runs and free afterwards", async () => {
		const t = new ExtensionTasks();
		let seen = false;
		await t.run("a", () => { seen = t.busy.a === true; });
		expect(seen).toBe(true);
		expect(t.busy.a).toBe(false);
	});
	test("a second run on a busy key is ignored, another key is not", async () => {
		const t = new ExtensionTasks();
		let release!: () => void;
		const first = t.run("a", () => new Promise<void>((r) => (release = r)));
		let ranSame = false, ranOther = false;
		await t.run("a", () => { ranSame = true; });
		await t.run("b", () => { ranOther = true; });
		release();
		await first;
		expect(ranSame).toBe(false);
		expect(ranOther).toBe(true);
	});
	test("the old error and notice are cleared when a task starts", async () => {
		const t = new ExtensionTasks();
		t.error = "old"; t.notice = "old";
		await t.run("a", () => {});
		expect(t.error).toBe("");
		expect(t.notice).toBe("");
	});
	test("a failure becomes the inline error and frees the key", async () => {
		const t = new ExtensionTasks();
		await t.run("a", () => { throw new Error("boom"); });
		expect(t.error).toBe("boom");
		expect(t.result).toBeNull();
		expect(t.busy.a).toBe(false);
	});
	test("with a failTitle the failure goes to the result dialog instead", async () => {
		const t = new ExtensionTasks();
		await t.run("a", async () => { throw new Error("bad file"); }, "Could not load");
		expect(t.error).toBe("");
		expect(t.result).toEqual({ tone: "danger", title: "Could not load", detail: "bad file" });
	});
	test("a thrown non-Error is shown as text", async () => {
		const t = new ExtensionTasks();
		await t.run("a", () => { throw "plain"; });
		expect(t.error).toBe("plain");
	});
	test("a notice set by the task survives (it is cleared only at the start)", async () => {
		const t = new ExtensionTasks();
		await t.run("a", () => { t.notice = "saved"; });
		expect(t.notice).toBe("saved");
	});
});
