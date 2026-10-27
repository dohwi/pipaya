import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedGitHosts, installFromGit } from "../src/extensions/install.ts";

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

describe("git hosts", () => {
	test("GitHub is always allowed; others only when the operator lists them", () => {
		expect(allowedGitHosts({})).toEqual(["github.com"]);
		expect(allowedGitHosts({ PIPAYA_EXTENSION_HOSTS: "Git.Example.com, gitlab.com ,bad host,-x.com,github.com" })).toEqual(["github.com", "git.example.com", "gitlab.com"]);
	});

	test.each([
		["an unlisted host", { ...good, host: "evil.example" }],
		["a host with a path", { ...good, host: "evil.example/x" }],
		["a host with credentials", { ...good, host: "user@evil.example" }],
		["a host that is only a word", { ...good, host: "localhost" }],
	])("refuses %s before touching the network or disk", async (_name, src) => {
		const to = dest();
		await expect(installFromGit("ok", src, to)).rejects.toThrow("invalid source");
		expect(existsSync(join(to, "ok"))).toBe(false);
	});

	test("a listed host passes the host check (and fails later, on the clone, with a different error)", async () => {
		const to = dest();
		await expect(installFromGit("ok", { ...good, host: "git.example.invalid" }, to, ["github.com", "git.example.invalid"])).rejects.toThrow(/clone failed/);
	});
});
