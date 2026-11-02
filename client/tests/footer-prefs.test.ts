import { describe, expect, test } from "bun:test";
import { DEFAULT_FOOTER, FOOTER_ITEMS, moveFooterItem, sanitizeFooter, visibleFooter } from "../src/lib/footer-prefs";

describe("footer preferences", () => {
	test("nothing stored gives the default", () => {
		expect(sanitizeFooter(null)).toEqual(DEFAULT_FOOTER);
		expect(sanitizeFooter([])).toEqual(DEFAULT_FOOTER);
	});
	test("drops unknown and repeated ids, and appends items added later", () => {
		const p = sanitizeFooter({ order: ["speed", "nope", "speed", "mcp"], hidden: ["cache", "cache", 3], layout: "x", align: "start" });
		expect(p.order.slice(0, 2)).toEqual(["speed", "mcp"]);
		expect(p.order.length).toBe(FOOTER_ITEMS.length);
		expect(p.hidden).toEqual(["cache"]);
		expect(p.layout).toBe("auto");
		expect(p.align).toBe("start");
	});
	test("moves one place and stops at the ends", () => {
		expect(moveFooterItem(["a", "b", "c"] as never, "b" as never, -1)).toEqual(["b", "a", "c"]);
		expect(moveFooterItem(["a", "b", "c"] as never, "a" as never, -1)).toEqual(["a", "b", "c"]);
		expect(moveFooterItem(["a", "b", "c"] as never, "c" as never, 1)).toEqual(["a", "b", "c"]);
	});
	test("visible skips hidden", () => {
		expect(visibleFooter({ ...DEFAULT_FOOTER, hidden: ["elapsed", "speed"] })).not.toContain("speed");
	});
});
