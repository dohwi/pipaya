import { describe, expect, test } from "bun:test";
import { HOLD_PREVIOUS_MS as H, shownChat } from "../src/lib/hold-previous";

describe("shownChat", () => {
	const a = { id: "a" }, b = { id: "b" };
	test("a loaded conversation is drawn as is", () => {
		expect(shownChat(b, true, a, 0, 10)).toEqual({ chat: b, held: false, late: false });
	});
	test("while the new one loads, the previous stays (dimmed) for a moment", () => {
		expect(shownChat(b, false, a, 0, 10)).toEqual({ chat: a, held: true, late: false });
		expect(shownChat(b, false, a, 0, H - 1)).toEqual({ chat: a, held: true, late: false });
	});
	test("then the new one's skeleton takes over", () => {
		expect(shownChat(b, false, a, 0, H)).toEqual({ chat: b, held: false, late: true });
	});
	test("nothing to hold: a first open, the same conversation, or a pane without one", () => {
		expect(shownChat(b, false, null, 0, 10)).toEqual({ chat: b, held: false, late: false });
		expect(shownChat(a, false, a, 0, 10)).toEqual({ chat: a, held: false, late: false });
		expect(shownChat(null, false, a, 0, 10)).toEqual({ chat: null, held: false, late: false });
	});
});
