import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAppIconSets, installIosIcons } from "../scripts/prepare-ios";

const icons = join(import.meta.dir, "../src-tauri/icons");

/** What `tauri ios init` leaves behind: an appiconset holding Tauri's logo. */
function generated(files: string[], nested = "pipaya_iOS/Assets.xcassets") {
	const root = mkdtempSync(join(tmpdir(), "apple-"));
	const set = join(root, nested, "AppIcon.appiconset");
	mkdirSync(set, { recursive: true });
	writeFileSync(join(set, "Contents.json"), JSON.stringify({ images: files.map((filename) => ({ filename })) }));
	for (const f of files) writeFileSync(join(set, f), "tauri-logo");
	return { root, set };
}

describe("iOS app icons", () => {
	test("replaces the generated Tauri logo with the project icons", () => {
		const files = ["AppIcon-60x60@2x.png", "AppIcon-60x60@3x.png", "AppIcon-512@2x.png"];
		const { root, set } = generated(files);
		expect(installIosIcons(icons, root)).toBe(set);
		for (const f of files) expect(readFileSync(join(set, f)).equals(readFileSync(join(icons, "ios", f)))).toBe(true);
	});
	test("every file the Xcode template can list exists in the project's set", () => {
		// the names `tauri icon` produces and the template's Contents.json refers to
		const { root } = generated(["AppIcon-20x20@1x.png", "AppIcon-20x20@2x-1.png", "AppIcon-29x29@3x.png", "AppIcon-40x40@2x-1.png", "AppIcon-83.5x83.5@2x.png", "AppIcon-512@2x.png"]);
		expect(() => installIosIcons(icons, root)).not.toThrow();
	});
	test("the project's icons are opaque: iOS applies the corner mask, and an alpha channel is rejected by the App Store", () => {
		const png = readFileSync(join(icons, "ios/AppIcon-512@2x.png"));
		expect(png[25]).toBe(2); // IHDR colour type 2 = RGB, no alpha
	});
	test("fails rather than keeping the Tauri logo when a size is missing or the project is not generated", () => {
		expect(() => installIosIcons(icons, generated(["AppIcon-999x999@9x.png"]).root)).toThrow("iOS icons missing");
		expect(() => installIosIcons(icons, mkdtempSync(join(tmpdir(), "empty-")))).toThrow("found 0");
		expect(existsSync(icons)).toBe(true);
	});
	test("finds the icon set at any depth", () => {
		expect(findAppIconSets(generated(["a.png"], "a/b/c/Assets.xcassets").root)).toHaveLength(1);
	});
});
