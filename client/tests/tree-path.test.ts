import { describe, expect, test } from "bun:test";
import { pathLength } from "../src/lib/tree-path";

describe("pathLength", () => {
	test("runs from the container's top to the middle of the open row", () => {
		expect(pathLength({ top: 100 }, { top: 164, height: 32 })).toBe(80);
	});
	test("no open row means no path", () => {
		expect(pathLength({ top: 100 }, undefined)).toBe(0);
		expect(pathLength({ top: 100 }, { top: 164, height: 0 })).toBe(0);
	});
	test("the first row's middle is half a row down", () => {
		expect(pathLength({ top: 50 }, { top: 50, height: 32 })).toBe(16);
	});
	test("ancestor scale is divided out so the path is in layout px", () => {
		expect(pathLength({ top: 0, scaleY: 0.5 }, { top: 32, height: 32 })).toBe(96);
	});
	test("a row above the container's top never gives a negative length", () => {
		expect(pathLength({ top: 100 }, { top: 0, height: 20 })).toBe(0);
	});
	test("the lead above the container is part of the path", () => {
		expect(pathLength({ top: 100 }, { top: 164, height: 32 }, 0.5, 2)).toBe(82);
		expect(pathLength({ top: 100 }, undefined, 0.5, 2)).toBe(0);
	});
	test("another anchor point inside the row", () => {
		expect(pathLength({ top: 0 }, { top: 32, height: 32 }, 0)).toBe(32);
	});
});
