import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { ApiError, type Api } from "../src/lib/api";
import type { ScheduleBook as ScheduleBookType } from "../src/lib/schedule-book.svelte";
import type { Schedule } from "../src/lib/types";

// Compile the real rune module with Svelte (as tests/debounced-list.test.ts does).
let ScheduleBook: typeof ScheduleBookType;
let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".schedule-book-"));
	const transpile = async (name: string) => ts.transpileModule(await Bun.file(resolve(`src/lib/${name}`)).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	await writeFile(join(dir, "abortable.mjs"), await transpile("abortable.ts"));
	const code = compileModule(await transpile("schedule-book.svelte.ts"), { filename: "schedule-book.svelte.js", generate: "client" }).js.code
		.replace('"./abortable"', '"./abortable.mjs"')
		.replace('"./api"', JSON.stringify(resolve("src/lib/api.ts")))
		.replace('"./schedules"', JSON.stringify(resolve("src/lib/schedules.ts")));
	await writeFile(join(dir, "schedule-book.mjs"), code);
	({ ScheduleBook } = await import(join(dir, "schedule-book.mjs")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const task = (over: Partial<Schedule>): Schedule => ({
	id: "t", sessionId: "s", title: null, prompt: "p", kind: "interval", runAt: null, everyMs: 600_000, enabled: true,
	nextRunAt: 1000, lastRunAt: null, lastStatus: null, lastError: null, failCount: 0, createdAt: 1, updatedAt: 1, ...over,
});
const apiOf = (answer: () => Promise<{ schedules: Schedule[] }>, seen: { n: number } = { n: 0 }) => ({ schedules: async () => (seen.n++, answer()) }) as unknown as Api;

describe("ScheduleBook", () => {
	test("reads the list and answers per server and per conversation", async () => {
		const book = new ScheduleBook();
		expect(book.all("a")).toEqual({ count: 0, next: null });
		book.follow("a", apiOf(async () => ({ schedules: [task({ id: "1", sessionId: "x", nextRunAt: 9 }), task({ id: "2", sessionId: "x", enabled: false })] })));
		await wait(5);
		expect(book.all("a")).toEqual({ count: 1, next: 9 });
		expect(book.of("a", "x")).toEqual({ count: 1, next: 9 });
		expect(book.of("a", "y").count).toBe(0);
		expect(book.all("b").count).toBe(0);
		expect(book.supported("a")).toBe(true);
	});
	test("an old server (no such route) is an empty list and unsupported, quietly", async () => {
		const book = new ScheduleBook();
		book.follow("old", apiOf(async () => { throw new ApiError(404, "not_found", "route not found"); }));
		await wait(5);
		expect(book.all("old").count).toBe(0);
		expect(book.supported("old")).toBe(false);
		expect(book.supported("other")).toBe(true);
	});
	test("another failure keeps what was shown and does not mark the server unsupported", async () => {
		const book = new ScheduleBook();
		book.follow("a", apiOf(async () => ({ schedules: [task({})] })))
		await wait(5);
		book.follow("a", apiOf(async () => { throw new ApiError(500, "http_error", "boom"); }));
		await wait(400);
		expect(book.all("a").count).toBe(1);
		expect(book.supported("a")).toBe(true);
	});
	test("after the first read, a burst of calls reads once: each call cancels the one before it", async () => {
		const book = new ScheduleBook();
		const seen = { n: 0 };
		const api = apiOf(async () => ({ schedules: [] }), seen);
		book.follow("a", api);
		await wait(5);
		expect(seen.n).toBe(1);
		for (let i = 0; i < 5; i++) book.follow("a", api)?.(); // each is cancelled by the next, as an effect's cleanup does
		const stop = book.follow("a", api);
		await wait(450);
		expect(seen.n).toBe(2);
		stop?.();
	});
	test("a server that disconnects (no api) asks nothing", () => {
		const book = new ScheduleBook();
		expect(book.follow("a", null)).toBeUndefined();
		expect(book.follow(null, apiOf(async () => ({ schedules: [] })))).toBeUndefined();
	});
});
