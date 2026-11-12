import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Api } from "../src/lib/api";
import type { ChatState as ChatStateType } from "../src/lib/chat.svelte";
import { setLang } from "../src/lib/i18n";
import {
	MAX_EVERY_MS,
	MIN_EVERY_MS,
	cadence,
	everyMs,
	everyProblem,
	isUsedUp,
	labelOf,
	parseLocal,
	resultOf,
	sortSchedules,
	splitEvery,
	toLocalInput,
} from "../src/lib/schedules";
import { rowMenuEntries } from "../src/lib/sidebar-model";
import { SETTINGS_TABS, queryWords, searchSettings } from "../src/lib/settings-search";
import type { PipayaEvent, Schedule, UserItem } from "../src/lib/types";

afterEach(() => setLang("ko"));

const task = (over: Partial<Schedule> = {}): Schedule => ({
	id: "t", sessionId: "s", title: null, prompt: "상태 알려줘", kind: "interval", runAt: null, everyMs: 600_000, enabled: true,
	nextRunAt: 1000, lastRunAt: null, lastStatus: null, lastError: null, failCount: 0, createdAt: 1, updatedAt: 1, ...over,
});

describe("interval", () => {
	test("units multiply out and split back to the largest even unit", () => {
		expect(everyMs({ amount: 5, unit: "minute" })).toBe(300_000);
		expect(everyMs({ amount: 2, unit: "hour" })).toBe(7_200_000);
		expect(everyMs({ amount: 30, unit: "day" })).toBe(MAX_EVERY_MS);
		expect(splitEvery(7_200_000)).toEqual({ amount: 2, unit: "hour" });
		expect(splitEvery(86_400_000)).toEqual({ amount: 1, unit: "day" });
		expect(splitEvery(90 * 60_000)).toEqual({ amount: 90, unit: "minute" });
		expect(splitEvery(MIN_EVERY_MS)).toEqual({ amount: 5, unit: "minute" });
	});
	test("the limits: 5 minutes to 30 days, whole numbers; 0, negative, fractions, NaN are refused", () => {
		expect(everyProblem({ amount: 5, unit: "minute" })).toBeNull();
		expect(everyProblem({ amount: 4, unit: "minute" })).not.toBeNull();
		expect(everyProblem({ amount: 30, unit: "day" })).toBeNull();
		expect(everyProblem({ amount: 31, unit: "day" })).not.toBeNull();
		expect(everyProblem({ amount: 721, unit: "hour" })).not.toBeNull(); // 30 days + 1 hour
		for (const amount of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(everyProblem({ amount, unit: "hour" }), String(amount)).not.toBeNull();
	});
	test("the wording follows the language", () => {
		expect(cadence({ kind: "interval", everyMs: 600_000 })).toBe("10분마다");
		expect(cadence({ kind: "interval", everyMs: 7_200_000 })).toBe("2시간마다");
		expect(cadence({ kind: "interval", everyMs: 86_400_000 })).toBe("1일마다");
		expect(cadence({ kind: "once", everyMs: null })).toBe("한 번");
		setLang("en");
		expect(cadence({ kind: "interval", everyMs: 600_000 })).toBe("Every 10 minutes");
		expect(cadence({ kind: "interval", everyMs: 3_600_000 })).toBe("Every 1 hour");
		expect(cadence({ kind: "once", everyMs: null })).toBe("Once");
	});
});

describe("date and time", () => {
	test("a local value round-trips", () => {
		const ms = new Date(2026, 10, 13, 9, 30).getTime();
		expect(toLocalInput(ms)).toBe("2026-11-13T09:30");
		expect(parseLocal("2026-11-13T09:30")).toBe(ms);
	});
	test("empty, partial and impossible dates are null (no silent roll-over)", () => {
		for (const v of ["", "  ", "2026-11-13", "2026-02-31T10:00", "2026-13-01T10:00", "2026-11-13T25:00", "not a date"]) expect(parseLocal(v), v).toBeNull();
	});
});

describe("labels and results", () => {
	test("the title, else the prompt's first non-empty line cut short, else nothing", () => {
		expect(labelOf(task({ title: " 아침 점검 " }))).toBe("아침 점검");
		expect(labelOf(task({ title: "", prompt: "\n\n  첫 줄\n둘째" }))).toBe("첫 줄");
		expect(labelOf(task({ title: null, prompt: "x".repeat(100) }), 10)).toBe(`${"x".repeat(9)}…`);
		expect(labelOf(task({ title: null, prompt: "" }))).toBe("");
	});
	test("no result before the first run; every status has a label and a tone", () => {
		expect(resultOf(task())).toBeNull();
		expect(resultOf(task({ lastStatus: "ok" }))).toEqual({ label: "보냄", tone: "ok" });
		expect(resultOf(task({ lastStatus: "skipped_busy" }))?.tone).toBe("warn");
		expect(resultOf(task({ lastStatus: "skipped_closed" }))?.tone).toBe("warn");
		expect(resultOf(task({ lastStatus: "skipped_expired" }))?.tone).toBe("warn");
		expect(resultOf(task({ lastStatus: "error", failCount: 2 }))).toEqual({ label: "실패 2회", tone: "danger" });
		expect(resultOf(task({ lastStatus: "error", failCount: 5, enabled: false }))?.label).toBe("실패로 꺼짐");
	});
	test("a one-time task that ran is used up; a fresh or an interval one is not", () => {
		expect(isUsedUp(task({ kind: "once", enabled: false, lastStatus: "ok" }))).toBe(true);
		expect(isUsedUp(task({ kind: "once", enabled: false, lastStatus: null }))).toBe(false);
		expect(isUsedUp(task({ kind: "interval", enabled: false, lastStatus: "ok" }))).toBe(false);
	});
	test("soonest first, switched-off ones last", () => {
		const list = [task({ id: "off", enabled: false, createdAt: 1 }), task({ id: "late", nextRunAt: 9000 }), task({ id: "soon", nextRunAt: 100 }), task({ id: "none", nextRunAt: null })];
		expect(sortSchedules(list).map((s) => s.id)).toEqual(["none", "soon", "late", "off"]);
		expect(sortSchedules([])).toEqual([]);
	});
});

describe("settings: section, search and the conversation menu", () => {
	test("the section belongs to the server and sits before the extensions", () => {
		const ids = SETTINGS_TABS.map((x) => x.id as string);
		expect(SETTINGS_TABS.find((x) => x.id === "schedules")).toMatchObject({ server: true, icon: "clock" });
		expect(ids.indexOf("schedules")).toBeGreaterThan(ids.indexOf("sessions"));
		expect(ids.indexOf("schedules")).toBeLessThan(ids.indexOf("srvext"));
	});
	test("found by Korean and English words", () => {
		const find = (q: string) => searchSettings(queryWords(q), { hasServer: true, shortcuts: [] }).map((h) => h.target.tab);
		for (const q of ["예약", "schedule", "반복", "interval", "cron"]) expect(find(q), q).toContain("schedules");
	});
	test("a conversation's menu offers 예약 추가… only when the caller can open it, and not for terminals or split tabs", () => {
		const calls: string[] = [];
		const act = { renameTab: () => {}, renameGroup: () => {}, groupWith: () => {}, closeSession: () => {}, closeTerminal: () => {}, schedule: (id: string) => calls.push(id) };
		const chat = rowMenuEntries({ kind: "session", x: { id: "s1", title: "Chat" } }, act);
		expect(chat.map((e) => e.icon)).toEqual(["pencil", "columns", "clock", "x"]);
		chat.find((e) => e.icon === "clock")!.run();
		expect(calls).toEqual(["s1"]);
		const { schedule: _, ...without } = act;
		expect(rowMenuEntries({ kind: "session", x: { id: "s1", title: "Chat" } }, without).map((e) => e.icon)).toEqual(["pencil", "columns", "x"]);
		expect(rowMenuEntries({ kind: "terminal", x: { id: "t1", title: "sh" } }, act).map((e) => e.icon)).not.toContain("clock");
		expect(rowMenuEntries({ kind: "group", g: { id: "g1", name: "G" } }, act).map((e) => e.icon)).not.toContain("clock");
	});
});

describe("a prompt a schedule sent", () => {
	let ChatState: typeof ChatStateType;
	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "pipaya-schedules-"));
		const build = await Bun.build({
			entrypoints: [resolve("src/lib/chat.svelte.ts")], target: "bun",
			plugins: [{ name: "runes", setup(builder) {
				builder.onResolve({ filter: /\/src\/lib\/api\.ts$/ }, ({ path }) => ({ path, external: true }));
				builder.onLoad({ filter: /chat\.svelte\.ts$/ }, async ({ path }) => {
					const source = ts.transpileModule(await Bun.file(path).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
					return { contents: compileModule(source.replace('from "./api"', `from ${JSON.stringify(resolve("src/lib/api.ts"))}`), { filename: path, generate: "client" }).js.code, loader: "js" };
				});
			} }],
		});
		if (!build.success) throw new Error(build.logs.join("\n"));
		const file = join(dir, "chat.mjs");
		await writeFile(file, await build.outputs[0]!.text());
		ChatState = (await import(file)).ChatState;
	});
	afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

	const ctx = { tokens: 1000, contextWindow: 128000 };
	const api = {
		messages: async () => [], tailMessages: async () => [], approvals: async () => [], questions: async () => [],
		getSession: async () => ({ status: { running: false, pendingToolCalls: [], streamingMessage: null, compacting: false }, context: ctx, compaction: { supported: true, autoEnabled: true }, usage: {} }),
	};
	const message = (seq: number, content: unknown): PipayaEvent => ({ id: seq, sessionId: "session", type: "message_end", data: { seq, message: { role: "user", content, timestamp: 1 } }, ts: 1 });
	const users = (chat: InstanceType<typeof ChatStateType>) => chat.items.filter((x): x is UserItem => x.kind === "user");

	test("the schedule block is hidden from the text and marks the message", () => {
		const chat = new ChatState("session", api as unknown as Api);
		chat.apply(message(0, [{ type: "text", text: "상태 알려줘" }, { type: "text", text: "<pipaya-schedule>This message was sent automatically by a scheduled task.</pipaya-schedule>" }]));
		chat.apply(message(1, [{ type: "text", text: "내가 쓴 글" }]));
		const [scheduled, typed] = users(chat);
		expect(scheduled).toMatchObject({ text: "상태 알려줘", scheduled: true });
		expect(typed!.text).toBe("내가 쓴 글");
		expect(typed!.scheduled).toBeUndefined();
	});
});
