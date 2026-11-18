import { describe, expect, test } from "bun:test";
import { BackTrail } from "../src/lib/back-trail";

const all = () => true;

describe("back trail", () => {
	test("back walks the conversations in reverse and then runs out", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: "2" });
		t.visit({ server: "a", session: "3" });
		expect(t.back(all)).toEqual({ server: "a", session: "2" });
		t.visit({ server: "a", session: "2" });
		expect(t.back(all)).toEqual({ server: "a", session: "1" });
		t.visit({ server: "a", session: "1" });
		expect(t.back(all)).toBeNull();
	});

	test("the blank new-chat screen is never a page to come back to", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: null });
		t.visit({ server: "a", session: "2" });
		expect(t.back(all)).toEqual({ server: "a", session: "1" });
		expect(t.back(all)).toBeNull();
	});

	test("going back to another server passes through its blank screen without being recorded", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "b", session: null });
		t.visit({ server: "b", session: "9" });
		expect(t.back(all)).toEqual({ server: "a", session: "1" });
		t.visit({ server: "a", session: null });
		t.visit({ server: "a", session: "1" });
		expect(t.depth).toBe(0);
		expect(t.back(all)).toBeNull();
	});

	test("closed conversations and the one on screen are skipped", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: "gone" });
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: "3" });
		t.visit({ server: "a", session: "1" });
		expect(t.back((p) => p.session !== "gone")).toEqual({ server: "a", session: "3" });
		t.visit({ server: "a", session: "3" });
		expect(t.back((p) => p.session !== "gone")).toEqual({ server: "a", session: "1" });
		t.visit({ server: "a", session: "1" });
		expect(t.back((p) => p.session !== "gone")).toBeNull();
	});

	test("keeps at most `max` pages", () => {
		const t = new BackTrail(3);
		for (let i = 0; i < 10; i++) t.visit({ server: "a", session: String(i) });
		expect(t.depth).toBe(3);
	});
});
