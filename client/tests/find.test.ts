import { describe, expect, test } from "bun:test";
import { matchesIn } from "../src/lib/find";

describe("matchesIn", () => {
	test("finds every occurrence, ignoring case", () => {
		expect(matchesIn("Foo foo FOO", "foo")).toEqual([[0, 3], [4, 7], [8, 11]]);
	});
	test("does not overlap matches", () => {
		expect(matchesIn("aaaa", "aa")).toEqual([[0, 2], [2, 4]]);
	});
	test("empty query matches nothing", () => {
		expect(matchesIn("abc", "")).toEqual([]);
	});
	test("works with Korean text", () => {
		expect(matchesIn("대화 검색, 세션 내 검색", "검색")).toEqual([[3, 5], [12, 14]]);
	});
});
