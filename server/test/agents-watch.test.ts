import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentsWatcher } from "../src/agents-watch.ts";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/events.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const roots: string[] = [];
const watchers: AgentsWatcher[] = [];

function setup(opts: { workdir?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "agents-watch-"));
	roots.push(root);
	const home = join(root, "home");
	const cwd = join(root, "proj");
	mkdirSync(join(home, ".agents", "skills"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const bus = new EventBus(openDb(":memory:"));
	const events: string[] = [];
	bus.subscribe((e) => { if (e.type === "skills_updated") events.push(e.type); });
	const w = new AgentsWatcher(bus, { home, workdirs: () => (opts.workdir === false ? [] : [cwd]), debounceMs: 50, rescanMs: 100 });
	watchers.push(w);
	w.start();
	return { home, cwd, events, w };
}

afterEach(() => {
	for (const w of watchers.splice(0)) w.stop();
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("AgentsWatcher", () => {
	test("global skill added/edited -> skills_updated", async () => {
		const f = setup();
		await sleep(100);
		mkdirSync(join(f.home, ".agents", "skills", "demo"));
		writeFileSync(join(f.home, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nx");
		await sleep(300);
		expect(f.events.length).toBeGreaterThan(0);
		const n = f.events.length;
		writeFileSync(join(f.home, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: e\n---\ny");
		await sleep(300);
		expect(f.events.length).toBeGreaterThan(n);
	});

	test("global AGENTS.md and other .agents file edits fire", async () => {
		const f = setup();
		await sleep(100);
		writeFileSync(join(f.home, ".agents", "AGENTS.md"), "hi");
		await sleep(300);
		const a = f.events.length;
		expect(a).toBeGreaterThan(0);
		mkdirSync(join(f.home, ".agents", "notes"));
		writeFileSync(join(f.home, ".agents", "notes", "t.md"), "body");
		await sleep(300);
		expect(f.events.length).toBeGreaterThan(a);
	});

	test("project .agents folder created AFTER start is picked up by rescan", async () => {
		const f = setup();
		await sleep(100);
		mkdirSync(join(f.cwd, ".agents", "skills", "p"), { recursive: true });
		await sleep(400); // rescan (100ms) attaches the watcher
		const n = f.events.length;
		writeFileSync(join(f.cwd, ".agents", "skills", "p", "SKILL.md"), "---\nname: p\ndescription: d\n---\nx");
		await sleep(300);
		expect(f.events.length).toBeGreaterThan(n);
	});

	test("bursts are debounced into one event", async () => {
		const f = setup();
		await sleep(100);
		for (let i = 0; i < 10; i++) writeFileSync(join(f.home, ".agents", `f${i}.md`), String(i));
		await sleep(300);
		expect(f.events.length).toBe(1);
	});

	test("stop() silences the watcher", async () => {
		const f = setup();
		await sleep(100);
		f.w.stop();
		writeFileSync(join(f.home, ".agents", "late.md"), "x");
		await sleep(300);
		expect(f.events.length).toBe(0);
	});
});
