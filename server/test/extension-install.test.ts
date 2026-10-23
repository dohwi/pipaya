import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFromGit } from "../src/extensions/install.ts";

const dirs: string[] = [];
const dest = () => {
	const d = mkdtempSync(join(tmpdir(), "pipaya-install-test-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const good = { repo: "owner/repo", ref: "v1.0.0", commit: "a".repeat(40) };

describe("installFromGit input checks", () => {
	test.each([
		["bad id", "../evil", good],
		["id with uppercase", "Evil", good],
		["repo with a host", "ok", { ...good, repo: "evil.com/x/y" }],
		["repo with a flag", "ok", { ...good, repo: "--upload-pack=x/y" }],
		["ref starting with a dash", "ok", { ...good, ref: "--upload-pack=x" }],
		["short commit", "ok", { ...good, commit: "abc123" }],
		["dir escaping the repo", "ok", { ...good, dir: "../x" }],
		["absolute dir", "ok", { ...good, dir: "/etc" }],
	])("rejects %s before touching the network or disk", async (_name, id, src) => {
		const to = dest();
		await expect(installFromGit(id, src, to)).rejects.toThrow("invalid source");
		expect(existsSync(join(to, id))).toBe(false);
	});
});
