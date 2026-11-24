import { describe, expect, test } from "bun:test";
import { replySpeed } from "../src/lib/service-tier";

describe("replySpeed", () => {
	test("returns none when no tier metadata is present or speed is default", () => {
		expect(replySpeed([], undefined)).toEqual({ kind: "none" });
		expect(replySpeed([{}], {})).toEqual({ kind: "none" });
		expect(replySpeed([{ requestedTier: "default" }], { requestedTier: "default" })).toEqual({ kind: "none" });
		expect(replySpeed([{ servedTier: "default" }], { servedTier: "default" })).toEqual({ kind: "none" });
		expect(replySpeed([{ requestedTier: "default", servedTier: "default" }], { requestedTier: "default", servedTier: "default" })).toEqual({ kind: "none" });
	});

	test("shows requested non-default speed for proxy replies without servedTier", () => {
		expect(replySpeed([{ requestedTier: "priority" }], { requestedTier: "priority" })).toEqual({
			kind: "tier",
			tier: "priority",
			confirmed: false,
			label: "Fast",
		});
		expect(replySpeed([{ requestedTier: "ultrafast" }], { requestedTier: "ultrafast" })).toEqual({
			kind: "tier",
			tier: "ultrafast",
			confirmed: false,
			label: "Ultrafast",
		});
		expect(replySpeed([{ requestedTier: "flex" }], { requestedTier: "flex" })).toEqual({
			kind: "tier",
			tier: "flex",
			confirmed: false,
			label: "Flex",
		});
	});

	test("shows confirmed served non-default speed on direct OpenRouter replies", () => {
		expect(replySpeed([{ requestedTier: "priority", servedTier: "priority" }], { requestedTier: "priority", servedTier: "priority" })).toEqual({
			kind: "tier",
			tier: "priority",
			confirmed: true,
			label: "Fast",
		});
		expect(replySpeed([{ servedTier: "priority" }], { servedTier: "priority" })).toEqual({
			kind: "tier",
			tier: "priority",
			confirmed: true,
			label: "Fast",
		});
	});

	test("always shows fallback when requested and served tiers differ on any part of the turn", () => {
		expect(
			replySpeed(
				[
					{ requestedTier: "priority", servedTier: "default" },
					{ requestedTier: "priority", servedTier: "priority" },
				],
				{ requestedTier: "priority", servedTier: "priority" },
			),
		).toEqual({
			kind: "fell",
			asked: "priority",
			served: "default",
			label: "Fast → 표준",
		});
		expect(replySpeed([{ requestedTier: "ultrafast", servedTier: "priority" }], { requestedTier: "ultrafast", servedTier: "priority" })).toEqual({
			kind: "fell",
			asked: "ultrafast",
			served: "priority",
			label: "Ultrafast → Fast",
		});
		expect(replySpeed([{ requestedTier: "default", servedTier: "priority" }], { requestedTier: "default", servedTier: "priority" })).toEqual({
			kind: "fell",
			asked: "default",
			served: "priority",
			label: "표준 → Fast",
		});
	});
});
