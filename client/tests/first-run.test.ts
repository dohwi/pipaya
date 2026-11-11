import { describe, expect, test } from "bun:test";
import { firstRunWays } from "../src/lib/first-run";

describe("firstRunWays", () => {
	test("each environment lists only what it can do", () => {
		expect(firstRunWays({ tauri: false, platform: "web" })).toEqual(["manual"]);
		expect(firstRunWays({ tauri: true, platform: "desktop" })).toEqual(["local", "manual"]);
		expect(firstRunWays({ tauri: true, platform: "android" })).toEqual(["scan", "manual"]);
		expect(firstRunWays({ tauri: false, platform: "android" })).toEqual(["manual"]);
	});
});
