import { describe, expect, test } from "bun:test";
import { firstRunWays } from "../src/lib/first-run";
import { recentDirs } from "../src/lib/start-actions";

describe("firstRunWays", () => {
	test("each environment lists only what it can do", () => {
		expect(firstRunWays({ tauri: false, platform: "web" })).toEqual(["manual"]);
		expect(firstRunWays({ tauri: true, platform: "desktop" })).toEqual(["local", "manual"]);
		expect(firstRunWays({ tauri: true, platform: "android" })).toEqual(["scan", "manual"]);
		expect(firstRunWays({ tauri: false, platform: "android" })).toEqual(["manual"]);
	});
});

describe("recentDirs", () => {
	const w = (path: string, updatedAt: number) => ({ path, cwd: `/r/${path}`, active: 1, closed: 0, updatedAt });
	const info = { root: "/r", workdirs: [w("a", 1), w("b", 4), w("c", 3), w("d", 2)] };
	test("freshest first, capped", () => {
		expect(recentDirs(info, ".", 3).map((d) => d.path)).toEqual(["b", "c", "d"]);
	});
	test("keeps the current folder", () => {
		const r = recentDirs(info, "a", 3);
		expect(r.map((d) => d.path)).toEqual(["b", "c", "a"]);
		expect(r[2].current).toBe(true);
	});
	test("no info", () => expect(recentDirs(null, ".")).toEqual([]));
});
