import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashLeavesProject, buildChildEnv, leavesProject, safePath, safeReadPath } from "../src/tools.ts";

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

	// The working-directory restriction is disabled on purpose (see "Disable working-directory path restriction").
	test("allows paths outside cwd", () => {
		expect(safePath(cwd, "../outside/secret.txt")).toBe(join(outside, "secret.txt"));
		expect(safePath(cwd, join(outside, "secret.txt"))).toBe(join(outside, "secret.txt"));
	});

	test("allows symlinks that point outside cwd", () => {
		expect(safePath(cwd, "link-dir/secret.txt")).toBe(join(cwd, "link-dir/secret.txt"));
		expect(safePath(cwd, "link-dir/not-yet/created.txt")).toBe(join(cwd, "link-dir/not-yet/created.txt"));
	});
});

describe("safeReadPath with skill roots", () => {
	test("a symlink inside a skill folder is no longer blocked (restriction disabled)", () => {
		const skill = join(cwd, "..", "skill");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "ok");
		symlinkSync(outside, join(skill, "escape"));
		expect(safeReadPath(cwd, join(skill, "SKILL.md"), [skill])).toBe(join(skill, "SKILL.md"));
		expect(safeReadPath(cwd, join(skill, "escape", "secret.txt"), [skill])).toBe(join(skill, "escape", "secret.txt"));
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

describe("leavesProject (what `ask` mode confirms)", () => {
	test("write/edit: judged by the target's real location", () => {
		expect(leavesProject("write", { path: "sub/new.txt" }, cwd)).toBe(false);
		expect(leavesProject("write", { path: join(cwd, "sub", "new.txt") }, cwd)).toBe(false);
		expect(leavesProject("edit", { path: "../outside/secret.txt" }, cwd)).toBe(true);
		expect(leavesProject("write", { path: join(outside, "x") }, cwd)).toBe(true);
		expect(leavesProject("write", { path: "link-dir/x.txt" }, cwd)).toBe(true); // a link inside leads out
		expect(leavesProject("edit", { path: "link-file" }, cwd)).toBe(true);
		expect(leavesProject("write", {}, cwd)).toBe(true); // no path to judge
	});
	test("a tool the server cannot judge counts as reaching out", () => {
		expect(leavesProject("some_extension_tool", { anything: 1 }, cwd)).toBe(true);
	});
});

describe("bashLeavesProject", () => {
	const inside = (c: string) => expect(bashLeavesProject(cwd, c), c).toBe(false);
	const out = (c: string) => expect(bashLeavesProject(cwd, c), c).toBe(true);
	test("commands that stay in the project", () => {
		inside("ls -la");
		inside("bun test && git status");
		inside("echo hi > sub/out.txt");
		inside(`cat ${join(cwd, "sub")}/a.txt`);
		inside("curl -s https://example.com/../x | head");
		inside("npm run build 2>/dev/null");
		inside("sed -i '/foo/d' notes.txt");
		inside("grep -rn 'a/b' .");
	});
	test("absolute paths, .., ~ and $HOME that resolve outside", () => {
		out(`cat ${outside}/secret.txt`);
		out("cat ../outside/secret.txt");
		out("rm -rf /");
		out("cat /etc/passwd");
		out("ls ~");
		out("cat ~/.ssh/id_rsa");
		out("cat $HOME/.bashrc");
		out("cat ${HOME}/.bashrc");
		out("cp a.txt /tmp/x.txt");
		out("tar -czf out.tgz --directory=/etc .");
		out("cat $SOMEDIR/file");
		out("echo hi > ../x");
		out("(cd .. && ls)");
		out("cd sub && ls .."); // `..` is read against the project root, not after the cd: the project's parent is outside
		out("cat link-dir/secret.txt ../x");
	});
});
