import { describe, expect, test } from "bun:test";
import { hexOf } from "../src/lib/css-color";

describe("the colour the Android bars are painted with", () => {
	test("hex colours, long and short", () => {
		expect(hexOf("#161616")).toBe("#161616");
		expect(hexOf(" #FFF ")).toBe("#ffffff");
		expect(hexOf("#1a2")).toBe("#11aa22");
	});
	test("rgb() as the browser reports computed colours", () => {
		expect(hexOf("rgb(22, 22, 22)")).toBe("#161616");
		expect(hexOf("rgba(255, 255, 255, 0.5)")).toBe("#ffffff");
		expect(hexOf("rgb(300 0 0)")).toBe("#ff0000");
	});
	test("anything that is not one flat colour is refused rather than guessed", () => {
		for (const bad of ["", "var(--bg)", "linear-gradient(#000, #fff)", "red", "#12", "#12345"]) expect(hexOf(bad)).toBeUndefined();
	});
});
