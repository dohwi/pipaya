import { describe, expect, test } from "bun:test";
import { ApiError, errorText } from "../src/lib/api";

describe("errorText", () => {
	test("message of an Error, a string as is", () => {
		expect(errorText(new Error("boom"))).toBe("boom");
		expect(errorText("plain")).toBe("plain");
	});
	test("fallback only when there is no message", () => {
		expect(errorText(new Error(""), "later")).toBe("later");
		expect(errorText(new Error("boom"), "later")).toBe("boom");
		expect(errorText(null)).not.toBe("");
	});
	test("a bare browser network error is not shown in the browser's English", () => {
		expect(errorText(new TypeError("Failed to fetch"))).not.toMatch(/fetch/i);
		expect(errorText(new TypeError("Load failed"))).not.toMatch(/load/i);
	});
	test("an unreachable server and a refused token have their own words", () => {
		expect(errorText(new ApiError(0, "network", "x"))).not.toBe("x");
		expect(errorText(new ApiError(401, "unauthorized", "x"))).not.toBe("x");
	});
});

describe("extension package errors", () => {
	test("a package that fails validation throws a PackageError carrying the field and the reason", async () => {
		const { parsePackage, PackageError } = await import("../src/lib/extensions/schema");
		let caught: unknown;
		try { parsePackage({ manifest: { id: "Bad Id", name: "x", version: "1.0.0", sdkVersion: 1, permissions: [] } }); } catch (e) { caught = e; }
		expect(caught).toBeInstanceOf(PackageError);
		expect((caught as InstanceType<typeof PackageError>).path).toBe("manifest.id");
		expect((caught as Error).message).toContain("manifest.id:");
	});
});
