import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type * as FeedbackModule from "../src/lib/feedback.svelte";
import type * as SidebarModule from "../src/lib/sidebar.svelte";

// Compile the real rune module with Svelte, rather than substituting fake $state globals (as tests/compaction.test.ts does).
let Feedback: typeof FeedbackModule.Feedback;
let NOTICE_MAX: number;
let reorder: typeof SidebarModule.reorder;
let dir: string;

async function loadRunes(name: string) {
	const build = await Bun.build({
		entrypoints: [resolve(`src/lib/${name}.svelte.ts`)], target: "bun",
		plugins: [{ name: "runes", setup(builder) {
			builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
				const source = ts.transpileModule(await Bun.file(path).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
				return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
			});
		} }],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, `${name}.mjs`);
	await writeFile(file, await build.outputs[0]!.text());
	return import(file);
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "harness-store-parts-"));
	({ Feedback, NOTICE_MAX } = await loadRunes("feedback"));
	// sidebar.svelte.ts reads localStorage at construction only; reorder is a pure function
	(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {} };
	({ reorder } = await loadRunes("sidebar"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("sidebar reorder", () => {
	test("moves an entry before or after another", () => {
		expect(reorder(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
		expect(reorder(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
	});
	test("no change when dropped on itself or on something not listed", () => {
		expect(reorder(["a", "b"], "a", "a", true)).toBeNull();
		expect(reorder(["a", "b"], "a", "z", true)).toBeNull();
	});
});

describe("feedback", () => {
	test("a session's toast shows in its pane while on screen, globally otherwise", () => {
		const f = new Feedback();
		f.toast("global");
		f.toast("about s1", "error", "s1");
		expect(f.global(["s1"]).map((x) => x.text)).toEqual(["global"]);
		expect(f.of("s1", ["s1"]).map((x) => x.text)).toEqual(["about s1"]);
		expect(f.global([]).map((x) => x.text)).toEqual(["global", "about s1"]);
		for (const x of [...f.toasts]) f.dismissToast(x.id);
		expect(f.toasts).toEqual([]);
	});
	test("one notice per session, newest first, at most NOTICE_MAX", () => {
		const f = new Feedback();
		f.announce("a", "done");
		f.announce("a", "failed");
		expect(f.notices.map((n) => [n.sid, n.tone])).toEqual([["a", "failed"]]);
		for (let i = 0; i < NOTICE_MAX + 2; i++) f.announce(`s${i}`, "done");
		expect(f.notices.length).toBe(NOTICE_MAX);
		expect(f.notices[0]!.sid).toBe(`s${NOTICE_MAX + 1}`);
		for (const n of [...f.notices]) f.dismissNotice(n.id);
	});
});
