import { describe, expect, test } from "bun:test";
import { featuresOf, permissionLabels } from "../src/lib/extensions/labels";
import { PERMISSIONS, type ExtensionPackage } from "../src/lib/extensions/schema";

describe("permission labels", () => {
	test("every permission has a sentence, and nothing else does", () => {
		expect(Object.keys(permissionLabels).sort()).toEqual([...PERMISSIONS].sort());
		for (const label of Object.values(permissionLabels)) expect(label.trim().length).toBeGreaterThan(0);
	});
});

describe("package features", () => {
	const pkg = (over: object) => ({ manifest: { id: "x", permissions: [] }, ...over }) as unknown as ExtensionPackage;
	test("a package with nothing extra lists nothing", () => {
		expect(featuresOf(pkg({}))).toEqual([]);
	});
	test("each thing the package brings is listed once", () => {
		const list = featuresOf(pkg({ theme: {}, commands: [{}], locales: [{}] }));
		expect(list).toContain("테마");
		expect(list).toContain("템플릿 명령");
		expect(list).toContain("언어팩");
		expect(new Set(list).size).toBe(list.length);
		expect(list).not.toContain("");
	});
});
