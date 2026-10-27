#!/usr/bin/env bun
// Fails when the places that carry the app and server version disagree. A release ships both from one commit, so they must match:
// the server tells the app its version, and the app offers "update the server" by comparing it with its own.
// Run by CI and by the release workflow; `bun scripts/check-versions.ts [expected]` also pins the value.
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const json = (path: string) => (JSON.parse(read(path)) as { version?: string }).version;

const found: Record<string, string | undefined> = {
	"server/package.json": json("server/package.json"),
	"client/package.json": json("client/package.json"),
	"client/src-tauri/tauri.conf.json": json("client/src-tauri/tauri.conf.json"),
	"client/src-tauri/Cargo.toml": /^version = "(.*)"$/m.exec(read("client/src-tauri/Cargo.toml"))?.[1],
	"client/src-tauri/Cargo.lock": /name = "pipaya"\nversion = "([^"]+)"/.exec(read("client/src-tauri/Cargo.lock"))?.[1],
};

const expected = process.argv[2]?.replace(/^v/, "") ?? found["client/src-tauri/tauri.conf.json"];
const shape = /^\d+\.\d+\.\d$/; // patch is one digit: 0.4.9 -> 0.5.0, never 0.4.10
let bad = 0;
for (const [file, version] of Object.entries(found)) {
	const ok = version === expected;
	if (!ok) bad++;
	console.log(`${ok ? "ok  " : "FAIL"} ${file.padEnd(36)} ${version ?? "(not found)"}`);
}
if (!expected || !shape.test(expected)) {
	console.log(`FAIL version "${expected}" is not major.minor.patch with a single-digit patch`);
	bad++;
}
if (bad) {
	console.error(`\n${bad} problem(s): run \`bun scripts/bump-version.ts <version>\` to set every place at once.`);
	process.exit(1);
}
console.log(`\nall versions are ${expected}`);
