/** Which shell the `bash` tool runs commands in. POSIX: bash (or sh). Windows: PowerShell, else cmd; bash only exists there with Git or WSL, so never assume it. */
export interface CommandShell {
	kind: "bash" | "powershell" | "cmd";
	/** Human name shown to the model, e.g. "PowerShell". */
	name: string;
	/** Executable to spawn. */
	path: string;
}

type Which = (cmd: string) => string | null;

export function pickCommandShell(platform: NodeJS.Platform = process.platform, which: Which = Bun.which, env: Record<string, string | undefined> = process.env): CommandShell {
	if (platform === "win32") {
		const pwsh = which("pwsh");
		if (pwsh) return { kind: "powershell", name: "PowerShell", path: pwsh };
		const ps = which("powershell");
		if (ps) return { kind: "powershell", name: "Windows PowerShell", path: ps };
		return { kind: "cmd", name: "Command Prompt (cmd)", path: env.ComSpec || which("cmd") || "cmd.exe" };
	}
	const bash = which("bash");
	if (bash) return { kind: "bash", name: "bash", path: bash };
	return { kind: "bash", name: "sh", path: which("sh") || "sh" };
}

const PS_UTF8 = "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$ProgressPreference='SilentlyContinue'";

/** Full argv that runs `command` in `shell` and exits with the command's exit code. */
export function commandArgv(shell: CommandShell, command: string): string[] {
	if (shell.kind === "powershell") {
		const script = `${PS_UTF8}\n${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
		return [shell.path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
	}
	if (shell.kind === "cmd") return [shell.path, "/d", "/s", "/c", `chcp 65001>nul & ${command}`];
	return [shell.path, "-c", command];
}

/** One-line note for the tool description so the model writes commands in the right syntax. */
export function shellNote(shell: CommandShell): string {
	return shell.kind === "bash" ? "" : ` Commands run in ${shell.name} on Windows, not bash: use its syntax (e.g. Get-ChildItem, Select-String), not bash utilities.`;
}
