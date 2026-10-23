import { describe, expect, test } from "bun:test";
import { commandArgv, pickCommandShell, shellNote } from "../src/command-shell.ts";

const has = (...found: string[]) => (c: string) => (found.includes(c) ? `C:\\${c}.exe` : null);

describe("pickCommandShell", () => {
	test("windows prefers pwsh, then Windows PowerShell, then cmd, never bash", () => {
		expect(pickCommandShell("win32", has("pwsh", "powershell", "bash"), {})).toMatchObject({ kind: "powershell", name: "PowerShell", path: "C:\\pwsh.exe" });
		expect(pickCommandShell("win32", has("powershell"), {})).toMatchObject({ kind: "powershell", name: "Windows PowerShell" });
		expect(pickCommandShell("win32", has(), { ComSpec: "C:\\cmd.exe" })).toMatchObject({ kind: "cmd", path: "C:\\cmd.exe" });
	});

	test("posix uses bash, falling back to sh", () => {
		expect(pickCommandShell("linux", has("bash", "sh"), {})).toMatchObject({ kind: "bash", path: "C:\\bash.exe" });
		expect(pickCommandShell("linux", has("sh"), {})).toMatchObject({ kind: "bash", name: "sh" });
	});
});

describe("commandArgv", () => {
	test("bash uses -c", () => {
		expect(commandArgv({ kind: "bash", name: "bash", path: "/bin/bash" }, "ls")).toEqual(["/bin/bash", "-c", "ls"]);
	});
	test("powershell forces UTF-8 and keeps the exit code", () => {
		const argv = commandArgv({ kind: "powershell", name: "PowerShell", path: "pwsh" }, "Get-Date");
		expect(argv.slice(0, 5)).toEqual(["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
		expect(argv[5]).toContain("UTF8Encoding");
		expect(argv[5]).toContain("Get-Date");
		expect(argv[5]).toContain("$LASTEXITCODE");
	});
	test("cmd runs through /c with UTF-8 code page", () => {
		expect(commandArgv({ kind: "cmd", name: "cmd", path: "cmd.exe" }, "dir")).toEqual(["cmd.exe", "/d", "/s", "/c", "chcp 65001>nul & dir"]);
	});
	test("only non-bash shells add a note", () => {
		expect(shellNote({ kind: "bash", name: "bash", path: "bash" })).toBe("");
		expect(shellNote({ kind: "powershell", name: "PowerShell", path: "pwsh" })).toContain("PowerShell");
	});
});
