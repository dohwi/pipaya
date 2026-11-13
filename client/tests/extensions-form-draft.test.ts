import { describe, expect, test } from "bun:test";
import { followsSaved } from "../src/lib/extensions/form-draft";

const off = JSON.stringify({ mode: "basic", notify: false });
const on = JSON.stringify({ mode: "basic", notify: true });

describe("a settings form follows the saved value", () => {
	test("a value changed elsewhere reaches an untouched form", () => {
		// the form shows what it was taken from; another device (or the extension) saves a new value
		expect(followsSaved(off, off, on)).toBe(true);
	});
	test("the user's own save coming back is taken", () => {
		expect(followsSaved(on, off, on)).toBe(true);
	});
	test("what the user is changing is never overwritten", () => {
		const editing = JSON.stringify({ mode: "advanced", notify: false });
		expect(followsSaved(editing, off, on)).toBe(false);
	});
});
