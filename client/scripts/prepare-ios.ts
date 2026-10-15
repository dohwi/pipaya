import { cpSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Every `AppIcon.appiconset` below `root` (the generated Xcode project may nest it). */
export function findAppIconSets(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (!statSync(path).isDirectory()) continue;
			if (name === "AppIcon.appiconset") found.push(path);
			else walk(path);
		}
	};
	walk(root);
	return found;
}

/**
 * `tauri ios init` generates the default Tauri logo and ignores src-tauri/icons/ios, so the project's own icons
 * (see scripts/make-icons.py) are copied over it. The asset catalog's Contents.json says which files it expects;
 * every one of them must exist in our set, otherwise the build would silently keep the Tauri logo for that size.
 */
export function installIosIcons(iconsDir: string, projectRoot: string): string {
	const source = resolve(iconsDir, "ios");
	const sets = findAppIconSets(projectRoot);
	if (sets.length !== 1) throw new Error(`Expected one AppIcon.appiconset in ${projectRoot}, found ${sets.length}`);
	const target = sets[0];
	const contents = JSON.parse(readFileSync(join(target, "Contents.json"), "utf8")) as { images?: { filename?: string }[] };
	const wanted = [...new Set((contents.images ?? []).map((i) => i.filename).filter((f): f is string => !!f))];
	const missing = wanted.filter((f) => !existsSync(join(source, f)));
	if (!wanted.length || missing.length) throw new Error(`iOS icons missing for: ${missing.join(", ") || "(Contents.json lists no files)"}`);
	for (const file of wanted) cpSync(join(source, file), join(target, file), { force: true });
	return target;
}

if (import.meta.main) {
	const target = installIosIcons(resolve(import.meta.dir, "../src-tauri/icons"), resolve(import.meta.dir, "../src-tauri/gen/apple"));
	console.log(`iOS app icons installed into ${target}`);
}
