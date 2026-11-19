import { describe, expect, test } from "bun:test";
import { compile } from "svelte/compiler";
import { GUARD_ID, guardEachBlocks } from "../scripts/each-guard-plugin";
import { keepFirstKeys } from "../src/lib/each-guard";
import { Window } from "happy-dom";

/** Run `fn` with a happy-dom document as the global one, collecting what goes to console.error. */
async function inDom(fn: (doc: Document) => unknown): Promise<string[]> {
	const win = new Window();
	const names = ["window", "document", "Node", "Element", "HTMLElement", "Text", "Comment", "DocumentFragment", "HTMLTemplateElement", "navigator"] as const;
	const g = globalThis as Record<string, unknown>;
	const keep = Object.fromEntries(names.map((n) => [n, g[n]]));
	for (const n of names) g[n] = n === "window" ? win : (win as unknown as Record<string, unknown>)[n];
	const errors: string[] = [];
	const error = console.error;
	console.error = (...a: unknown[]) => void errors.push(a.join(" "));
	try {
		await fn(win.document as unknown as Document);
	} finally {
		console.error = error;
		for (const n of names) g[n] = keep[n];
	}
	return errors;
}

const texts = (el: Element) => [...el.querySelectorAll("li")].map((x) => x.textContent);

const SOURCE = `<script>let { items } = $props();</script>
{#each items as x (x.id)}<p>{x.id}</p>{/each}
{#each items as x, i}<p>{i}</p>{/each}`;

describe("keepFirstKeys", () => {
	const byId = (x: unknown) => (x as { id: string }).id;
	test("returns the list itself when no key repeats", () => {
		const list = [{ id: "a" }, { id: "b" }];
		expect(keepFirstKeys(list, byId)).toBe(list);
	});
	test("keeps the first item of a repeated key, in order, and reports the key", () => {
		const seen: unknown[] = [];
		const out = keepFirstKeys([{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "a", n: 3 }, { id: "c", n: 4 }], byId, (k) => seen.push(k));
		expect(out.map((x) => x.n)).toEqual([1, 2, 4]);
		expect(seen).toEqual(["a"]);
	});
	test("passes the index to the key function", () => {
		expect(keepFirstKeys(["x", "x"], (_, i) => i)).toEqual(["x", "x"]);
	});
});

describe("guardEachBlocks", () => {
	for (const dev of [false, true]) {
		test(`rewrites the Svelte compiler's ${dev ? "dev" : "production"} output`, () => {
			const { code } = compile(SOURCE, { filename: "X.svelte", generate: "client", dev }).js;
			const out = guardEachBlocks(code, "components/X.svelte");
			expect(out).not.toBeNull();
			expect(out).toContain(`from ${JSON.stringify(GUARD_ID)}`);
			expect(out).not.toContain("svelte/internal/client");
			expect(out).not.toMatch(/\$\.each\(/);
			expect(out).toContain('$.each_in("components/X.svelte#1", ');
			expect(out).toContain('$.each_in("components/X.svelte#2", ');
			expect(out!.split("\n").length).toBe(code.split("\n").length);
		});
	}
	test("leaves a component without each blocks alone", () => {
		expect(guardEachBlocks(compile("<p>hi</p>", { generate: "client" }).js.code, "P.svelte")).toBeNull();
	});
	test("fails the build when the runtime import is not found", () => {
		expect(() => guardEachBlocks('import * as R from "svelte/internal/client";\nR.x; $.each(a)', "Y.svelte")).toThrow(/each guard/);
	});
});

describe("a built component with a repeated key", () => {
	test("draws the first item instead of throwing, and names the file", async () => {
		const { build } = await import("vite");
		const { svelte } = await import("@sveltejs/vite-plugin-svelte");
		const { eachGuard } = await import("../scripts/each-guard-plugin");
		const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
		const { join, resolve } = await import("node:path");
		// inside the client folder (tmp/ is not committed), so the build finds svelte in its node_modules
		mkdirSync(resolve("tmp"), { recursive: true });
		const dir = mkdtempSync(resolve("tmp", "each-guard-"));
		try {
			writeFileSync(join(dir, "List.svelte"), `<script>let { items } = $props();</script>
<ul>{#each items as x (x.id)}<li>{x.label}</li>{/each}</ul>`);
			writeFileSync(join(dir, "entry.svelte.js"), `import { mount, unmount, flushSync } from "svelte";
import List from "./List.svelte";
export function run(target) {
	const props = $state({ items: [{ id: "a", label: "A" }] });
	const app = mount(List, { target, props });
	props.items = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "a", label: "A again" }];
	flushSync();
	return () => unmount(app);
}`);
			await build({
				root: dir, logLevel: "silent", configFile: false, plugins: [svelte({ configFile: false }), eachGuard()],
				build: { outDir: join(dir, "out"), minify: true, lib: { entry: join(dir, "entry.svelte.js"), formats: ["es"], fileName: "entry" } },
			});
			const { run } = await import(join(dir, "out", "entry.js"));
			const errors = await inDom((doc) => {
				const target = doc.createElement("div");
				const stop = run(target);
				expect(texts(target)).toEqual(["A", "B"]);
				stop(); // a mounted root stays in Svelte's event registry and would outlive this window
			});
			expect(errors).toEqual([expect.stringContaining("List.svelte#1: a")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
});

describe("an extension component with a repeated key", () => {
	test("draws the first item instead of throwing, and names the extension", async () => {
		const { loadComponents } = await import("../src/lib/extensions/components");
		// the client build (bun resolves plain "svelte" to the server one)
		const { mount, unmount, flushSync } = await import("../node_modules/svelte/src/index-client.js" as string);
		const pkg = { manifest: { id: "dup-ext" }, components: { List: `<script>let { items } = $props();</script>
<ul>{#each items as x (x.id)}<li>{x.label}</li>{/each}</ul>` } };
		const { List } = loadComponents(pkg as never, {});
		const errors = await inDom((doc) => {
			const target = doc.createElement("div");
			const app = mount(List!, { target, props: { items: [{ id: "a", label: "A" }, { id: "a", label: "A again" }, { id: "b", label: "B" }] } });
			flushSync();
			expect(texts(target)).toEqual(["A", "B"]);
			unmount(app);
		});
		expect(errors).toEqual([expect.stringContaining("extension dup-ext: a")]);
	});
});
