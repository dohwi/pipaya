import { describe, expect, test } from "bun:test";
import { promptDurations, type TranscriptUnit } from "../src/lib/prompt-duration";

const user = (ts: number, goal?: true): TranscriptUnit => ({ kind: "user", item: { ts, ...(goal ? { goal } : {}) } });
const turn = (...parts: { ts: number; durationMs?: number; streaming?: boolean; toolIds?: string[] }[]): TranscriptUnit => ({
	kind: "turn",
	items: parts.map((p) => ({
		ts: p.ts,
		durationMs: p.durationMs,
		streaming: p.streaming ?? false,
		blocks: (p.toolIds ?? []).map((id) => ({ type: "tool" as const, id, name: "bash", args: {} })),
	})),
});

describe("promptDurations", () => {
	test("single prompt -> single reply uses wall-clock time from prompt ts to reply end", () => {
		const units: TranscriptUnit[] = [user(1_000), turn({ ts: 1_200, durationMs: 2_500 })];
		expect(promptDurations(units, {}, false)).toEqual([{ elapsedMs: 2_700, endedAt: 3_700 }, undefined]);
	});

	test("multi-step turn includes tool execution time between LLM calls", () => {
		const units: TranscriptUnit[] = [
			user(10_000),
			turn({ ts: 10_200, durationMs: 2_000, toolIds: ["t1"] }, { ts: 75_000, durationMs: 3_000 }),
		];
		expect(promptDurations(units, { t1: { endedAt: 74_800 } }, false)).toEqual([
			{ elapsedMs: 68_000, endedAt: 78_000 },
			undefined,
		]);
	});

	test("uses tool endedAt when a tool finished after the last assistant message (e.g. aborted after tool)", () => {
		const units: TranscriptUnit[] = [user(1_000), turn({ ts: 1_500, durationMs: 1_000, toolIds: ["t1"] })];
		expect(promptDurations(units, { t1: { endedAt: 12_000 } }, false)).toEqual([
			{ elapsedMs: 11_000, endedAt: 12_000 },
			undefined,
		]);
	});

	test("spans automatic goal continuations under the main user prompt", () => {
		const units: TranscriptUnit[] = [
			user(1_000),
			turn({ ts: 2_000, durationMs: 5_000 }),
			user(8_000, true),
			turn({ ts: 9_000, durationMs: 10_000 }),
			{ kind: "notice" },
			user(50_000),
			turn({ ts: 51_000, durationMs: 2_000 }),
		];
		const out = promptDurations(units, {}, false);
		expect(out[0]).toEqual({ elapsedMs: 18_000, endedAt: 19_000 });
		expect(out[2]).toBeUndefined(); // goal continuation itself has no bubble
		expect(out[5]).toEqual({ elapsedMs: 3_000, endedAt: 53_000 });
	});

	test("hides duration for the active trailing prompt while running, keeping earlier completed prompts", () => {
		const units: TranscriptUnit[] = [
			user(1_000),
			turn({ ts: 1_500, durationMs: 4_000 }),
			user(10_000),
			turn({ ts: 10_500, durationMs: 2_000 }),
		];
		expect(promptDurations(units, {}, true)).toEqual([
			{ elapsedMs: 4_500, endedAt: 5_500 },
			undefined,
			undefined,
			undefined,
		]);
	});

	test("hides duration when any assistant part in the span is still streaming", () => {
		const units: TranscriptUnit[] = [user(1_000), turn({ ts: 2_000, durationMs: 1_000, streaming: true })];
		expect(promptDurations(units, {}, false)).toEqual([undefined, undefined]);
	});

	test("returns undefined for missing turns, zero timestamps, or clock skew (end <= start)", () => {
		const units: TranscriptUnit[] = [
			user(1_000),
			{ kind: "notice" },
			user(0),
			turn({ ts: 5_000, durationMs: 1_000 }),
			user(10_000),
			turn({ ts: 9_000, durationMs: 500 }),
		];
		expect(promptDurations(units, {}, false)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
	});
});
