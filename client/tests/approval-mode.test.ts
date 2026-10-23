import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, errorText, isUnsupportedRoute } from "../src/lib/api";
import { approvalMode } from "../src/lib/store-model";
import { setLang } from "../src/lib/i18n";

afterEach(() => setLang("ko"));

describe("approvalMode", () => {
	test("auto and unset read as auto; ask and the retired read-only read as ask", () => {
		expect(approvalMode("auto")).toBe("auto");
		expect(approvalMode("ask")).toBe("ask");
		expect(approvalMode("readonly")).toBe("ask");
		expect(approvalMode(undefined)).toBe("auto");
	});
});

describe("a server older than the app", () => {
	const noRoute = new ApiError(404, "not_found", "route not found");
	const noSession = new ApiError(404, "not_found", "session not found");

	test("an unrouted request is told apart from a missing thing", () => {
		expect(isUnsupportedRoute(noRoute)).toBe(true);
		expect(isUnsupportedRoute(noSession)).toBe(false);
		expect(isUnsupportedRoute(new Error("route not found"))).toBe(false);
		expect(isUnsupportedRoute(new ApiError(500, "internal", "route not found"))).toBe(false);
	});

	test("the user hears that the server lacks the feature, not a bare 'not found'", () => {
		setLang("en");
		expect(errorText(noRoute)).toBe("This server does not support this yet. Update the server");
		expect(errorText(noSession)).toBe("Not found");
	});
});
