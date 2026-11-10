import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/lib/api";
import { gitFailure } from "../src/lib/git-error";

describe("gitFailure", () => {
	test("a server without the git routes is told apart from a missing session", () => {
		expect(gitFailure(new ApiError(404, "not_found", "route not found"))).toEqual({ kind: "old-server" });
		expect(gitFailure(new ApiError(501, "not_implemented", "nope"))).toEqual({ kind: "old-server" });
		expect(gitFailure(new ApiError(404, "not_found", "session not found"))).toEqual({ kind: "gone" });
	});
	test("anything else keeps its own message", () => {
		expect(gitFailure(new ApiError(0, "network", "offline"))).toEqual({ kind: "other", message: "offline" });
		expect(gitFailure(new Error("boom"))).toEqual({ kind: "other", message: "boom" });
		expect(gitFailure("x")).toEqual({ kind: "other", message: "x" });
	});
});
