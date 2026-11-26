import { describe, expect, test } from "bun:test";
import { sortActiveFirst } from "../src/lib/list-order";

describe("sortActiveFirst", () => {
	test("handles empty and single-item lists without mutating the input", () => {
		const empty: { id: string; enabled: boolean }[] = [];
		const outEmpty = sortActiveFirst(empty, (x) => x.enabled);
		expect(outEmpty).toEqual([]);
		expect(outEmpty).not.toBe(empty);

		const single = [{ id: "a", enabled: false }];
		const outSingle = sortActiveFirst(single, (x) => x.enabled);
		expect(outSingle).toEqual([{ id: "a", enabled: false }]);
		expect(outSingle).not.toBe(single);
	});

	test("moves disabled items to the bottom while preserving relative order within each bucket", () => {
		const input = [
			{ name: "search", enabled: true },
			{ name: "tts_manager", enabled: false },
			{ name: "blender", enabled: true },
			{ name: "legacy", enabled: false },
			{ name: "openscad", enabled: true },
		];
		const snapshot = input.map((x) => x.name);

		const sorted = sortActiveFirst(input, (x) => x.enabled);
		expect(sorted.map((x) => x.name)).toEqual(["search", "blender", "openscad", "tts_manager", "legacy"]);
		// Input array must not be mutated
		expect(input.map((x) => x.name)).toEqual(snapshot);
	});

	test("keeps order intact when all items are enabled or all items are disabled", () => {
		const allOn = ["c", "a", "b"].map((name) => ({ name, enabled: true }));
		const allOff = ["c", "a", "b"].map((name) => ({ name, enabled: false }));

		expect(sortActiveFirst(allOn, (x) => x.enabled).map((x) => x.name)).toEqual(["c", "a", "b"]);
		expect(sortActiveFirst(allOff, (x) => x.enabled).map((x) => x.name)).toEqual(["c", "a", "b"]);
	});

	test("supports multi-tier numeric ranks including falsy 0 and negative values", () => {
		const items = [
			{ id: "off-1", rank: 2 },
			{ id: "shadow-1", rank: 1 },
			{ id: "on-1", rank: 0 },
			{ id: "off-2", rank: 2 },
			{ id: "pinned", rank: -1 },
			{ id: "on-2", rank: 0 },
			{ id: "shadow-2", rank: 1 },
		];

		const sorted = sortActiveFirst(items, (x) => x.rank);
		expect(sorted.map((x) => x.id)).toEqual(["pinned", "on-1", "on-2", "shadow-1", "shadow-2", "off-1", "off-2"]);
	});

	test("evaluates the score function once per item", () => {
		let calls = 0;
		const items = [1, 2, 3, 4, 5];
		sortActiveFirst(items, (n) => {
			calls++;
			return n % 2 === 0;
		});
		expect(calls).toBe(items.length);
	});

	test("sinks non-finite ranks (NaN, Infinity) to the bottom stably", () => {
		const items = [
			{ id: "nan-1", rank: Number.NaN },
			{ id: "ok-1", rank: 1 },
			{ id: "inf", rank: Number.POSITIVE_INFINITY },
			{ id: "ok-0", rank: 0 },
			{ id: "nan-2", rank: Number.NaN },
		];
		expect(sortActiveFirst(items, (x) => x.rank).map((x) => x.id)).toEqual(["ok-0", "ok-1", "nan-1", "inf", "nan-2"]);
	});
});
