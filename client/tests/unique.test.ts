import { describe, expect, test } from "bun:test";
import { unique, uniqueBy } from "../src/lib/unique";
import { crashReport } from "../src/lib/crash-report";
import { sidebarDirs } from "../src/lib/nav";
import type { Session } from "../src/lib/types";

describe("uniqueBy", () => {
	test("keeps the first item of each key, in order", () => {
		expect(uniqueBy([{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "a", n: 3 }], (x) => x.id)).toEqual([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
		expect(unique(["red", "blue", "red"])).toEqual(["red", "blue"]);
	});

	test("hands the same array back when nothing repeats", () => {
		const list = ["a", "b"];
		expect(unique(list)).toBe(list);
	});
});

describe("sidebarDirs", () => {
	test("a session listed twice gets one tab", () => {
		const s = { id: "s1", title: "x", cwd: "/w", createdAt: 1, updatedAt: 1 } as Session;
		const dirs = sidebarDirs([s, { ...s }], [], []);
		expect(dirs[0]!.tabs.map((t) => t.id)).toEqual(["s1"]);
	});
});

describe("crashReport", () => {
	const ctx = { at: Date.UTC(2026, 10, 17), url: "http://100.85.51.107:1420/?token=secret", userAgent: "UA" };

	test("names the Svelte error code, drops the query and keeps the top of the stack", () => {
		const e = new Error("https://svelte.dev/e/each_key_duplicate");
		e.stack = "Error: https://svelte.dev/e/each_key_duplicate\n    at each (each.js:1)\n    at QuestionReply (QuestionReply.svelte:90)";
		const r = crashReport(e, ctx);
		expect(r).toContain("code: each_key_duplicate");
		expect(r).toContain("url: http://100.85.51.107:1420/\n");
		expect(r).not.toContain("secret");
		expect(r).toContain("  at QuestionReply (QuestionReply.svelte:90)");
		expect(r.split("\n")[0]).toBe("error: https://svelte.dev/e/each_key_duplicate");
	});

	test("reads the code of a dev build message and anything thrown that is not an Error", () => {
		expect(crashReport(new Error("each_key_duplicate\nKeyed each block has duplicate key `a`"), ctx)).toContain("code: each_key_duplicate");
		expect(crashReport("boom", ctx)).toContain("error: boom");
	});
});
