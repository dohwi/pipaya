import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTools } from "../src/tools.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bash(cwd: string) {
	return buildTools(["bash"], cwd)[0]!;
}

describe("bash tool stops reliably", () => {
	test("timeout kills a grandchild that holds stdout open, and returns promptly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-kill-"));
		try {
			const started = Date.now();
			const run = bash(dir).execute("t1", { command: "sleep 300 & echo $! > pid; wait", timeout: 1 } as never, undefined as never);
			await expect(run).rejects.toThrow(/timed out/);
			expect(Date.now() - started).toBeLessThan(6000);
			await sleep(200);
			expect(existsSync(join(dir, "pid"))).toBe(true);
			expect(alive(Number(readFileSync(join(dir, "pid"), "utf8").trim()))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("abort signal kills the whole process tree", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-kill-"));
		try {
			const ctl = new AbortController();
			const started = Date.now();
			const run = bash(dir).execute("t2", { command: "(sleep 300 & echo $! > pid; wait) & wait" } as never, ctl.signal);
			setTimeout(() => ctl.abort(), 500);
			await expect(run).rejects.toThrow(/aborted/);
			expect(Date.now() - started).toBeLessThan(6000);
			await sleep(200);
			expect(alive(Number(readFileSync(join(dir, "pid"), "utf8").trim()))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a daemonised descendant that escapes the group cannot hang the tool after a kill", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-kill-"));
		try {
			const started = Date.now();
			// `setsid` inside gives the child a new session/group, so only the pipe-grace fallback can save us.
			const run = bash(dir).execute("t3", { command: "setsid sleep 4 & echo $! > pid; wait", timeout: 1 } as never, undefined as never);
			await expect(run).rejects.toThrow(/timed out/);
			expect(Date.now() - started).toBeLessThan(3900);
		} finally {
			const pidFile = join(dir, "pid");
			if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL"); } catch {} }
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
