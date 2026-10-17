#!/usr/bin/env bun
// Sets one version everywhere it is written: bun scripts/bump-version.ts 0.2.0
// Then commit as `chore(release): v0.2.0`, merge to main and push the tag `v0.2.0` to publish.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error("usage: bun scripts/bump-version.ts <major.minor.patch>");
	process.exit(1);
}

const root = new URL("../", import.meta.url);
const edit = (path: string, update: (text: string) => string) => {
	const url = new URL(path, root);
	const before = readFileSync(url, "utf8");
	const after = update(before);
	if (before === after) console.log(`unchanged  ${path}`);
	else (writeFileSync(url, after), console.log(`updated    ${path}`));
};
const once = (text: string, pattern: RegExp, replacement: string, path: string) => {
	if (!pattern.test(text)) throw new Error(`version not found in ${path}`);
	return text.replace(pattern, replacement);
};

for (const path of ["server/package.json", "client/package.json", "client/src-tauri/tauri.conf.json"])
	edit(path, (t) => once(t, /("version":\s*")[^"]+(")/, `$1${version}$2`, path));
edit("client/src-tauri/Cargo.toml", (t) => once(t, /^version = ".*"$/m, `version = "${version}"`, "Cargo.toml"));
edit("client/src-tauri/Cargo.lock", (t) => once(t, /(name = "pipaya"\nversion = ")[^"]+(")/, `$1${version}$2`, "Cargo.lock"));
