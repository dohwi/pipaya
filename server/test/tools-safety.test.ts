import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv, safePath, safeReadPath } from "../src/tools.ts";

let root: string;
let cwd: string;
let outside: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pipaya-safe-"));
	cwd = join(root, "work");
	outside = join(root, "outside");
	mkdirSync(cwd);
	mkdirSync(outside);
	writeFileSync(join(outside, "secret.txt"), "secret");
	symlinkSync(outside, join(cwd, "link-dir"));
	symlinkSync(join(outside, "secret.txt"), join(cwd, "link-file"));
	mkdirSync(join(cwd, "sub"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("safePath", () => {
	test("allows normal and not-yet-existing paths inside cwd", () => {
		expect(safePath(cwd, "sub")).toBe(join(cwd, "sub"));
		expect(safePath(cwd, "new/dir/file.txt")).toBe(join(cwd, "new/dir/file.txt"));
		expect(safePath(cwd, ".")).toBe(cwd);
	});

	test("rejects lexical escapes", () => {
		expect(() => safePath(cwd, "../outside/secret.txt")).toThrow("outside");
		expect(() => safePath(cwd, join(outside, "secret.txt"))).toThrow("outside");
	});

	test("rejects symlinks that point outside cwd", () => {
		expect(() => safePath(cwd, "link-file")).toThrow("outside");
		expect(() => safePath(cwd, "link-dir")).toThrow("outside");
		expect(() => safePath(cwd, "link-dir/secret.txt")).toThrow("outside");
		expect(() => safePath(cwd, "link-dir/not-yet/created.txt")).toThrow("outside");
	});
});

describe("safeReadPath with skill roots", () => {
	test("a symlink inside a skill folder cannot lead outside it", () => {
		const skill = join(cwd, "..", "skill");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "ok");
		symlinkSync(outside, join(skill, "escape"));
		expect(safeReadPath(cwd, join(skill, "SKILL.md"), [skill])).toBe(join(skill, "SKILL.md"));
		expect(() => safeReadPath(cwd, join(skill, "escape", "secret.txt"), [skill])).toThrow("outside");
		expect(() => safeReadPath(cwd, join(skill, "escape"), [skill])).toThrow("outside");
	});
});

describe("buildChildEnv", () => {
	const source = {
		PATH: "/usr/bin", HOME: "/home/x", LC_ALL: "C", XDG_CONFIG_HOME: "/c",
		PIPAYA_TOKEN: "t", GOOGLE_APPLICATION_CREDENTIALS: "/k.json", AWS_SECRET_ACCESS_KEY: "s", OPENAI_API_KEY: "sk",
	};
	test("passes only the allow-list and withholds secrets", () => {
		const env = buildChildEnv(source);
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", LC_ALL: "C", XDG_CONFIG_HOME: "/c" });
	});
	test("PIPAYA_BASH_ENV opts extra names in, but never PIPAYA_*", () => {
		const env = buildChildEnv({ ...source, PIPAYA_BASH_ENV: "AWS_SECRET_ACCESS_KEY,PIPAYA_TOKEN" });
		expect(env.AWS_SECRET_ACCESS_KEY).toBe("s");
		expect(env.PIPAYA_TOKEN).toBeUndefined();
		expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
	});
});
