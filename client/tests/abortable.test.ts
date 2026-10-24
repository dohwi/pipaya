import { describe, expect, test } from "bun:test";
import { abortable } from "../src/lib/abortable";

const tick = () => new Promise((r) => setTimeout(r, 0));
const later = <T>() => {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
};

describe("abortable", () => {
	test("a finished request reports its value, then done", async () => {
		const seen: string[] = [];
		abortable(async () => 7, { ok: (v) => seen.push(`ok ${v}`), fail: () => seen.push("fail"), done: () => seen.push("done") });
		await tick();
		expect(seen).toEqual(["ok 7", "done"]);
	});
	test("a failed request reports its error, then done", async () => {
		const seen: string[] = [];
		abortable(async () => { throw new Error("boom"); }, { ok: () => seen.push("ok"), fail: (e) => seen.push(`fail ${(e as Error).message}`), done: () => seen.push("done") });
		await tick();
		expect(seen).toEqual(["fail boom", "done"]);
	});
	test("a cancelled request reports nothing, however it ends", async () => {
		const seen: string[] = [];
		const a = later<number>();
		const cancelA = abortable(() => a.promise, { ok: () => seen.push("ok"), fail: () => seen.push("fail"), done: () => seen.push("done") });
		cancelA();
		a.resolve(1);
		const b = later<number>();
		const cancelB = abortable(() => b.promise, { ok: () => seen.push("ok"), fail: () => seen.push("fail"), done: () => seen.push("done") });
		cancelB();
		b.reject(new Error("late"));
		await tick();
		expect(seen).toEqual([]);
	});
	test("cancelling aborts the signal the request was given", () => {
		let signal!: AbortSignal;
		const cancel = abortable((s) => ((signal = s), new Promise<void>(() => {})));
		expect(signal.aborted).toBe(false);
		cancel();
		expect(signal.aborted).toBe(true);
	});
	test("with a delay nothing is sent until it passes, and cancelling during it sends nothing", async () => {
		let sent = 0;
		const cancel = abortable(async () => void sent++, { delay: 20 });
		expect(sent).toBe(0);
		cancel();
		await new Promise((r) => setTimeout(r, 40));
		expect(sent).toBe(0);
		abortable(async () => void sent++, { delay: 5 });
		await new Promise((r) => setTimeout(r, 30));
		expect(sent).toBe(1);
	});
	test("the request that replaced a cancelled one is the only one that reports", async () => {
		const seen: number[] = [];
		const first = later<number>();
		const cancelFirst = abortable(() => first.promise, { ok: (v) => seen.push(v) });
		cancelFirst();
		abortable(async () => 2, { ok: (v) => seen.push(v) });
		first.resolve(1);
		await tick();
		expect(seen).toEqual([2]);
	});
});
