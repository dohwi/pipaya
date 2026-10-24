import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { DirBrowser as DirBrowserType } from "../src/lib/dir-browser.svelte";

// Compile the real rune module with Svelte; workdir-path is plain TypeScript, so it is transpiled and imported as is.
let DirBrowser: typeof DirBrowserType;
let dir: string;
const tsOpts = { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } };
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".dir-browser-"));
	await writeFile(join(dir, "workdir-path.mjs"), ts.transpileModule(await Bun.file(resolve("src/lib/workdir-path.ts")).text(), tsOpts).outputText);
	const source = ts.transpileModule(await Bun.file(resolve("src/lib/dir-browser.svelte.ts")).text(), tsOpts).outputText;
	await writeFile(join(dir, "dir-browser.mjs"), compileModule(source, { filename: "dir-browser.svelte.js", generate: "client" }).js.code.replace('"./workdir-path"', '"./workdir-path.mjs"'));
	({ DirBrowser } = await import(join(dir, "dir-browser.mjs")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const entry = (p: string) => ({ name: p.split("/").pop()!, path: p });
function tree(): Record<string, { parent?: string; dirs: string[] }> {
	return {
		"/home": { parent: "/", dirs: ["alpha", "alpine", "beta"] },
		"/home/alpha": { parent: "/home", dirs: ["src", "docs"] },
		"/home/beta": { parent: "/home", dirs: [] },
		"/": { dirs: ["home"] },
	};
}
function source(fs = tree()) {
	const calls: { path: string | undefined; hidden: boolean }[] = [];
	const made: [string, string][] = [];
	const gates: Record<string, () => void> = {};
	return {
		calls, made, gates,
		src: {
			async list(path: string | undefined, hidden: boolean) {
				calls.push({ path, hidden });
				const p = path ?? "/home";
				if (gates[p]) await new Promise<void>((r) => (gates[p] = r));
				const node = fs[p.replace(/(.)\/$/, "$1")];
				if (!node) throw new Error(`no such folder: ${p}`);
				return { path: p.replace(/(.)\/$/, "$1"), parent: node.parent ?? null, home: "/home", entries: node.dirs.map((d) => entry(`${p === "/" ? "" : p}/${d}`)), truncated: false } as never;
			},
			async mkdir(parent: string, name: string) { made.push([parent, name]); return { path: `${parent}/${name}` }; },
			errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
		},
	};
}

describe("go", () => {
	test("lists a folder and writes it into the path box with a trailing slash", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home/alpha");
		expect(b.listing?.path).toBe("/home/alpha");
		expect(b.typed).toBe("/home/alpha/");
		expect(b.loading).toBe(false);
		expect(b.error).toBe("");
	});
	test("with no server there is nothing to do", async () => {
		const b = new DirBrowser(() => null, 5);
		await b.go("/x");
		expect(b.listing).toBeNull();
	});
	test("only the newest request lands, even when an older one answers later", async () => {
		const s = source(); s.gates["/home/alpha"] = () => {};
		const b = new DirBrowser(() => s.src, 5);
		const slow = b.go("/home/alpha");
		await b.go("/home/beta");
		s.gates["/home/alpha"]!();
		await slow;
		expect(b.listing?.path).toBe("/home/beta");
		expect(b.typed).toBe("/home/beta/");
	});
	test("a starting folder that is gone falls back to the home, once", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/gone");
		expect(b.listing?.path).toBe("/home");
		expect(s.calls.map((c) => c.path)).toEqual(["/gone", undefined]);
		expect(b.error).toBe("");
	});
	test("a failure after the fallback is shown as the error", async () => {
		const fs = tree(); delete (fs as Record<string, unknown>)["/home"];
		const s = source(fs); const b = new DirBrowser(() => s.src, 5);
		await b.go("/gone");
		expect(b.error).toContain("no such folder");
		expect(b.loading).toBe(false);
	});
	test("while typing, a missing folder is not an error: the last list stays and `missing` is set", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home/alpha");
		await b.go("/home/alph", true);
		expect(b.error).toBe("");
		expect(b.missing).toBe(true);
		expect(b.listing?.path).toBe("/home/alpha");
	});
	test("a live listing does not overwrite what the user is typing", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		b.typed = "/home/be";
		await b.go("/home", true);
		expect(b.typed).toBe("/home/be");
	});
	test("the hidden flag is passed on", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		b.hidden = true;
		await b.go("/home");
		expect(s.calls.at(-1)).toEqual({ path: "/home", hidden: true });
	});
});

describe("typing", () => {
	test("an absolute path is listed after a pause, a relative one never", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		const n = s.calls.length;
		b.typed = "relative/dir";
		b.typedChanged();
		await wait(30);
		expect(s.calls.length).toBe(n);
		b.typed = "/home/alpha/";
		b.typedChanged();
		await wait(30);
		expect(s.calls.at(-1)).toEqual({ path: "/home/alpha", hidden: false });
	});
	test("typing within the folder on screen does not list again", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		const n = s.calls.length;
		b.typed = "/home/al";
		b.typedChanged();
		await wait(30);
		expect(s.calls.length).toBe(n);
		expect(b.shown.map((d) => d.name)).toEqual(["alpha", "alpine"]);
	});
	test("a quick second keystroke replaces the first, and dispose drops a pending one", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 20);
		await b.go("/home");
		const n = s.calls.length;
		b.typed = "/home/alpha/"; b.typedChanged();
		b.typed = "/home/beta/"; b.typedChanged();
		await wait(50);
		expect(s.calls.slice(n).map((c) => c.path)).toEqual(["/home/beta"]);
		b.typed = "/home/alpha/"; b.typedChanged();
		b.dispose();
		await wait(50);
		expect(s.calls.length).toBe(n + 1);
	});
	test("typing resets the highlighted row", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		b.active = 1;
		b.typed = "/home/a";
		b.typedChanged();
		expect(b.active).toBe(-1);
	});
});

describe("keys", () => {
	test("arrows wrap around the shown rows", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		expect(b.arrow("ArrowDown")).toBe(true);
		expect(b.active).toBe(0);
		b.arrow("ArrowUp");
		expect(b.active).toBe(2);
		b.arrow("ArrowDown");
		expect(b.active).toBe(0);
	});
	test("arrows do nothing when no folder is shown", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home/beta");
		expect(b.arrow("ArrowDown")).toBe(false);
		expect(b.active).toBe(-1);
	});
	test("Tab completes the common start of the matches and lists nothing new while it is still ambiguous", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		b.typed = "/home/al";
		expect(b.tab()).toBe(true);
		expect(b.typed.startsWith("/home/al")).toBe(true);
	});
	test("Tab with one match completes it with a slash and lists it at once", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		b.typed = "/home/be";
		expect(b.tab()).toBe(true);
		expect(b.typed).toBe("/home/beta/");
		await wait(10);
		expect(b.listing?.path).toBe("/home/beta");
	});
	test("Tab with nothing to complete is left to the browser", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		expect(b.tab()).toBe(false);
		await b.go("/home");
		b.typed = "/home/zzz";
		expect(b.tab()).toBe(false);
	});
	test("Backspace over the trailing slash clears the highlight, elsewhere it does not", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		b.active = 1; b.backspaced(false);
		expect(b.active).toBe(1);
		b.backspaced(true);
		expect(b.active).toBe(-1);
	});
});

describe("submit", () => {
	test("opens the highlighted row", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		b.active = 0;
		b.submit(false); await wait(5);
		expect(b.listing?.path).toBe("/home/alpha");
	});
	test("opens the exact match of what is typed, or the only match", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		b.typed = "/home/beta";
		b.submit(false); await wait(5);
		expect(b.listing?.path).toBe("/home/beta");
		await b.go("/home");
		b.typed = "/home/be";
		b.submit(false); await wait(5);
		expect(b.listing?.path).toBe("/home/beta");
	});
	test("a second Enter on an already-listed path asks to confirm it, unless busy or missing", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home/alpha");
		expect(b.submit(false)).toEqual({ confirm: "/home/alpha" });
		expect(b.submit(true)).toBeUndefined();
		b.missing = true;
		expect(b.submit(false)).toBeUndefined();
	});
	test("an unlisted path is simply gone to", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		await b.go("/home");
		b.typed = "/home/alpha/";
		const r = b.submit(false); await wait(5);
		expect(r).toBeUndefined();
		expect(b.listing?.path).toBe("/home/alpha");
	});
});

describe("new folder", () => {
	test("makes the folder in the one on screen, opens it and closes the field", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		s.src.list = (async (p: string | undefined) => ({ path: p ?? "/home", parent: "/home", home: "/home", entries: [], truncated: false })) as never;
		await b.go("/home/alpha");
		b.startCreating();
		b.newName = "  fresh ";
		await b.mkdir();
		expect(s.made).toEqual([["/home/alpha", "fresh"]]);
		expect(b.creating).toBe(false);
		expect(b.newName).toBe("");
		expect(b.listing?.path).toBe("/home/alpha/fresh");
	});
	test("an empty name or no listing does nothing", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		b.newName = "x"; await b.mkdir();
		await b.go("/home");
		b.newName = "   "; await b.mkdir();
		expect(s.made).toEqual([]);
	});
	test("a failure is shown and the field stays open", async () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		s.src.mkdir = async () => { throw new Error("exists"); };
		await b.go("/home");
		b.startCreating(); b.newName = "dup";
		await b.mkdir();
		expect(b.error).toBe("exists");
		expect(b.creating).toBe(true);
	});
	test("cancelling closes the field and forgets the name", () => {
		const s = source(); const b = new DirBrowser(() => s.src, 5);
		b.startCreating(); b.newName = "x"; b.cancelCreating();
		expect(b.creating).toBe(false);
		expect(b.newName).toBe("");
	});
});
