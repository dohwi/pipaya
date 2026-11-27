import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { ApiError, type Api } from "../src/lib/api";
import type { GoalBook as GoalBookType } from "../src/lib/goal-book.svelte";
import type { Goal } from "../src/lib/types";

let GoalBook: typeof GoalBookType;
let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".goal-book-"));
	const transpile = async (name: string) => ts.transpileModule(await Bun.file(resolve(`src/lib/${name}`)).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	await writeFile(join(dir, "abortable.mjs"), await transpile("abortable.ts"));
	const code = compileModule(await transpile("goal-book.svelte.ts"), { filename: "goal-book.svelte.js", generate: "client" }).js.code
		.replace('"./abortable"', '"./abortable.mjs"')
		.replace('"./api"', JSON.stringify(resolve("src/lib/api.ts")));
	await writeFile(join(dir, "goal-book.mjs"), code);
	({ GoalBook } = await import(join(dir, "goal-book.mjs")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const goal = (over: Partial<Goal>): Goal => ({
	sessionId: "s1", goalId: "g1", objective: "Ship it", status: "active", tokenBudget: null,
	tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1, ...over,
});
const apiOf = (answer: () => Promise<{ goals: Goal[] }>, seen: { n: number } = { n: 0 }) => ({ goals: async () => (seen.n++, answer()) }) as unknown as Api;

describe("GoalBook", () => {
	test("tracks multiple servers independently and supports immediate reconnect refresh", async () => {
		const book = new GoalBook({ pauseMs: 120 });
		book.follow("a", apiOf(async () => ({ goals: [goal({ sessionId: "sa", status: "active" })] })));
		book.follow("b", apiOf(async () => ({ goals: [goal({ sessionId: "sb", status: "paused" })] })));
		await wait(15);
		expect(book.of("a", "sa")?.status).toBe("active");
		expect(book.of("b", "sb")?.status).toBe("paused");
		expect(book.bySessionId("sb")?.status).toBe("paused");

		book.follow("b", apiOf(async () => ({ goals: [goal({ sessionId: "sb", status: "complete" })] })), { immediate: true });
		await wait(15);
		expect(book.of("b", "sb")?.status).toBe("complete");
		expect(book.of("a", "sa")?.status).toBe("active");
	});

	test("retries transient errors while online, stops when offline, and marks 404 unsupported without retrying", async () => {
		const book = new GoalBook({ pauseMs: 10, retryDelays: [15, 25] });
		let calls = 0;
		book.follow("a", apiOf(async () => {
			calls++;
			if (calls < 3) throw new ApiError(503, "unavailable", "booting");
			return { goals: [goal({ sessionId: "s1", status: "paused" })] };
		}), { retry: () => true });
		await wait(90);
		expect(calls).toBe(3);
		expect(book.of("a", "s1")?.status).toBe("paused");
		expect(book.isFresh("a")).toBe(true);

		let offCalls = 0;
		let online = true;
		book.follow("b", apiOf(async () => {
			offCalls++;
			online = false;
			throw new ApiError(503, "unavailable", "down");
		}), { retry: () => online });
		await wait(80);
		expect(offCalls).toBe(1);
		expect(book.isFresh("b")).toBe(false);

		let oldCalls = 0;
		book.follow("old", apiOf(async () => {
			oldCalls++;
			throw new ApiError(404, "not_found", "route not found");
		}), { retry: () => true });
		await wait(80);
		expect(oldCalls).toBe(1);
		expect(book.supported("old")).toBe(false);
	});

	test("ensure() skips fresh/in-flight servers and forget() removes cached state", async () => {
		const book = new GoalBook({ pauseMs: 80 });
		let n = 0;
		const slowApi = {
			goals: async () => {
				n++;
				await wait(40);
				return { goals: [goal({ sessionId: "s1" })] };
			},
		} as unknown as Api;
		book.ensure("a", slowApi);
		book.ensure("a", slowApi);
		await wait(60);
		expect(n).toBe(1);
		expect(book.isFresh("a")).toBe(true);
		book.ensure("a", slowApi);
		expect(n).toBe(1);

		book.forget("a");
		expect(book.of("a", "s1")).toBeNull();
		expect(book.isFresh("a")).toBe(false);
	});
});
