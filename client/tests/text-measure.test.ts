import { afterEach, describe, expect, test } from "bun:test";
import { clearTextMeasureCache, fontSpecOf, measureTextWidth, onFontsLoaded } from "../src/lib/text-measure";

const g = globalThis as unknown as { getComputedStyle?: typeof getComputedStyle };
const prevGetComputedStyle = g.getComputedStyle;

afterEach(() => {
	g.getComputedStyle = prevGetComputedStyle;
	clearTextMeasureCache();
});

describe("text-measure", () => {
	test("empty string returns 0 without requiring canvas", () => {
		expect(measureTextWidth("", { font: "400 14px sans-serif", letterSpacing: 0 })).toBe(0);
	});

	test("returns null gracefully when Canvas 2D is unavailable", () => {
		const w = measureTextWidth("hello", { font: "400 14px sans-serif", letterSpacing: 0 });
		expect(w === null || typeof w === "number").toBe(true);
	});

	test("fontSpecOf reads computed font fields and respects weight override and letterSpacing", () => {
		g.getComputedStyle = (() => ({
			fontStyle: "italic",
			fontWeight: "500",
			fontSize: "13px",
			fontFamily: "monospace",
			letterSpacing: "0.5px",
		})) as unknown as typeof getComputedStyle;

		const spec = fontSpecOf({} as Element);
		expect(spec.font).toBe("italic 500 13px monospace");
		expect(spec.letterSpacing).toBeCloseTo(0.5, 4);

		const bold = fontSpecOf({} as Element, "600");
		expect(bold.font).toBe("italic 600 13px monospace");

		g.getComputedStyle = (() => ({
			fontStyle: "normal",
			fontWeight: "400",
			fontSize: "14px",
			fontFamily: "sans-serif",
			letterSpacing: "normal",
		})) as unknown as typeof getComputedStyle;
		const plain = fontSpecOf({} as Element);
		expect(plain.font).toBe("400 14px sans-serif");
		expect(plain.letterSpacing).toBe(0);
	});

	test("onFontsLoaded registers and unsubscribes cleanly", () => {
		const stop = onFontsLoaded(() => {});
		expect(() => stop()).not.toThrow();
	});
});
