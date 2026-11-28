import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import {
	BackgroundBashManager,
	BG_BASH_JOB_TOOL,
	BG_RING_BUFFER_BYTES,
	OutputRingBuffer,
} from "../src/bg-bash.ts";
import type { Config } from "../src/config.ts";
import { buildChildEnv, buildTools, DEFAULT_TOOLS, TOOL_DEFS } from "../src/tools.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path: string, timeoutMs = 4000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const v = readFileSync(path, "utf8").trim();
			if (v) return v;
		}
		await sleep(30);
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitDead(pid: number, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return;
		await sleep(30);
	}
}

function makeTools(cwd: string, mgr: BackgroundBashManager, sessionId: string) {
	const [bash, bashJob] = buildTools(["bash", BG_BASH_JOB_TOOL], cwd, [], {
		sessionId,
		bgBash: mgr.forSession(sessionId),
	});
	return { bash: bash!, bashJob: bashJob! };
}

describe("OutputRingBuffer", () => {
	test("supports incremental reads, tail reads, and UTF-8 safe eviction", () => {
		const ring = new OutputRingBuffer(20);
		ring.append("hello ");
		ring.append("world");
		const r1 = ring.read({ offset: 0 });
		expect(r1).toEqual({ output: "hello world", offset: 0, nextOffset: 11, truncated: false, dropped: false });
		expect(ring.read({ offset: r1.nextOffset })).toEqual({
			output: "",
			offset: 11,
			nextOffset: 11,
			truncated: false,
			dropped: false,
		});
		// Offset past totalBytes clamps cleanly.
		expect(ring.read({ offset: 999 })).toEqual({
			output: "",
			offset: 11,
			nextOffset: 11,
			truncated: false,
			dropped: false,
		});

		// Push multi-byte Korean text past 20-byte capacity: no U+FFFD replacement chars.
		ring.append("가나다라마바사"); // 21 bytes
		expect(ring.bufferedBytes).toBeLessThanOrEqual(20);
		const stale = ring.read({ offset: 0 });
		expect(stale.dropped).toBe(true);
		expect(stale.output).not.toContain("\uFFFD");
		expect(stale.output.endsWith("사")).toBe(true);

		// Incremental chunked reading respects maxBytes on UTF-8 boundary.
		const part1 = ring.read({ offset: stale.offset, maxBytes: 7 });
		expect(part1.truncated).toBe(true);
		expect(part1.output).not.toContain("\uFFFD");
		const part2 = ring.read({ offset: part1.nextOffset, maxBytes: 100 });
		expect(part1.output + part2.output).toBe(stale.output);

		// Tail read (offset omitted).
		const tail = ring.read({ maxBytes: 7 });
		expect(tail.truncated).toBe(true);
		expect(tail.output).not.toContain("\uFFFD");
		expect(tail.nextOffset).toBe(ring.totalBytes);

		// Defensive maxBytes handling: NaN falls back to default, tiny maxBytes still returns last codepoint.
		const nanRead = ring.read({ maxBytes: Number.NaN });
		expect(nanRead.output).toBe(stale.output);
		const tinyTail = ring.read({ maxBytes: 1 });
		expect(tinyTail.output).toBe("사");
		expect(tinyTail.truncated).toBe(true);
	});
});

describe("background bash tool & manager", () => {
	test("registers bash_job in TOOL_DEFS and DEFAULT_TOOLS", () => {
		expect(TOOL_DEFS[BG_BASH_JOB_TOOL]).toBeDefined();
		expect(DEFAULT_TOOLS).toContain(BG_BASH_JOB_TOOL);
	});

	test("background: true starts job, streams incremental output, and reports exitCode 0", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-"));
		const mgr = new BackgroundBashManager();
		try {
			const { bash, bashJob } = makeTools(dir, mgr, "s1");
			const started = await bash.execute(
				"c1",
				{ command: "echo line1; sleep 0.15; echo line2; sleep 0.15; echo done", background: true } as never,
				undefined as never,
			);
			const jobId = (started.details as { jobId: string; status: string; pid: number }).jobId;
			expect(jobId).toMatch(/^bg_/);
			expect((started.details as { status: string }).status).toBe("running");
			expect((started.details as { pid: number }).pid).toBeGreaterThan(0);

			let offset = 0;
			let combined = "";
			for (let i = 0; i < 20; i++) {
				const poll = await bashJob.execute(
					`p${i}`,
					{ action: "output", id: jobId, offset, waitSeconds: 2 } as never,
					undefined as never,
				);
				const d = poll.details as { status: string; exitCode: number | null; nextOffset: number };
				const body = (poll.content[0] as { text: string }).text;
				const sepIdx = body.indexOf("\n\n");
				const chunk = sepIdx >= 0 ? body.slice(sepIdx + 2) : "";
				if (chunk !== "(no new output)") combined += chunk;
				offset = d.nextOffset;
				if (d.status !== "running") {
					expect(d.status).toBe("exited");
					expect(d.exitCode).toBe(0);
					break;
				}
			}
			expect(combined).toContain("line1");
			expect(combined).toContain("line2");
			expect(combined).toContain("done");

			const listRes = await bashJob.execute("l1", { action: "list" } as never, undefined as never);
			const jobs = (listRes.details as { jobs: { jobId: string; status: string }[] }).jobs;
			expect(jobs.some((j) => j.jobId === jobId && j.status === "exited")).toBe(true);
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("stop kills entire process group including grandchildren holding stdout open, and is idempotent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-stop-"));
		const mgr = new BackgroundBashManager();
		try {
			const { bash, bashJob } = makeTools(dir, mgr, "s1");
			const started = await bash.execute(
				"c1",
				{ command: "(sleep 300 & echo $! > child.pid; wait) & wait", background: true } as never,
				undefined as never,
			);
			const jobId = (started.details as { jobId: string }).jobId;
			const childPid = Number(await waitForFile(join(dir, "child.pid")));
			expect(alive(childPid)).toBe(true);

			const stopped = await bashJob.execute("s1", { action: "stop", id: jobId } as never, undefined as never);
			expect((stopped.details as { status: string }).status).toBe("killed");
			await waitDead(childPid);
			expect(alive(childPid)).toBe(false);

			// Second stop is idempotent.
			const stoppedAgain = await bashJob.execute("s2", { action: "stop", id: jobId } as never, undefined as never);
			expect((stoppedAgain.details as { status: string }).status).toBe("killed");
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("caps memory on >200KB output while keeping latest valid UTF-8 tail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-big-"));
		const mgr = new BackgroundBashManager();
		try {
			const { bash, bashJob } = makeTools(dir, mgr, "s1");
			// Emit ~330KB of Korean text + final marker.
			const cmd = `bun -e 'const s = "가나다라마바사아자차".repeat(100) + "\\n"; for (let i = 0; i < 110; i++) process.stdout.write(s);' && echo FINAL_MARKER_999`;
			const started = await bash.execute("c1", { command: cmd, background: true } as never, undefined as never);
			const jobId = (started.details as { jobId: string }).jobId;

			const waited = await bashJob.execute(
				"w1",
				{ action: "wait", id: jobId, waitSeconds: 10 } as never,
				undefined as never,
			);
			const d = waited.details as { status: string; exitCode: number; totalBytes: number };
			expect(d.status).toBe("exited");
			expect(d.exitCode).toBe(0);
			expect(d.totalBytes).toBeGreaterThan(BG_RING_BUFFER_BYTES);

			const snap = mgr.list("s1").find((j) => j.jobId === jobId)!;
			expect(snap.bufferedBytes).toBeLessThanOrEqual(BG_RING_BUFFER_BYTES);
			expect(snap.baseOffset).toBeGreaterThan(0);

			const text = (waited.content[0] as { text: string }).text;
			expect(text).toContain("FINAL_MARKER_999");
			expect(text).not.toContain("\uFFFD");

			const fromZero = await bashJob.execute(
				"r0",
				{ action: "output", id: jobId, offset: 0 } as never,
				undefined as never,
			);
			expect((fromZero.details as { dropped: boolean }).dropped).toBe(true);
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("enforces strict session isolation between sessions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-iso-"));
		const mgr = new BackgroundBashManager();
		try {
			const a = makeTools(dir, mgr, "session-a");
			const b = makeTools(dir, mgr, "session-b");

			const started = await a.bash.execute("c1", { command: "echo secret && sleep 30", background: true } as never, undefined as never);
			const jobId = (started.details as { jobId: string }).jobId;

			expect(mgr.list("session-b")).toEqual([]);
			await expect(
				b.bashJob.execute("b1", { action: "output", id: jobId } as never, undefined as never),
			).rejects.toThrow(/not found/);
			await expect(
				b.bashJob.execute("b2", { action: "wait", id: jobId, waitSeconds: 1 } as never, undefined as never),
			).rejects.toThrow(/not found/);
			await expect(
				b.bashJob.execute("b3", { action: "stop", id: jobId } as never, undefined as never),
			).rejects.toThrow(/not found/);

			// Session A can still stop its own job.
			const stopped = await a.bashJob.execute("a1", { action: "stop", id: jobId } as never, undefined as never);
			expect((stopped.details as { status: string }).status).toBe("killed");
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("enforces maxRunningPerSession, maxRunningGlobal, and LRU eviction of finished jobs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-cap-"));
		const mgr = new BackgroundBashManager({ maxRunningPerSession: 2, maxRunningGlobal: 3, maxFinishedPerSession: 3 });
		try {
			const { bash, bashJob } = makeTools(dir, mgr, "s1");
			const s2 = makeTools(dir, mgr, "s2");

			// 1. Concurrency cap: 2 running allowed per session, 3rd rejected.
			const j1 = (await bash.execute("r1", { command: "sleep 30", background: true } as never, undefined as never)).details as { jobId: string };
			const j2 = (await bash.execute("r2", { command: "sleep 30", background: true } as never, undefined as never)).details as { jobId: string };
			await expect(
				bash.execute("r3", { command: "sleep 30", background: true } as never, undefined as never),
			).rejects.toThrow(/Too many background jobs/);

			// 2. Global cap: s2 can start 1 (total 3), then 2nd is rejected globally.
			const j3 = (await s2.bash.execute("r4", { command: "sleep 30", background: true } as never, undefined as never)).details as { jobId: string };
			await expect(
				s2.bash.execute("r5", { command: "sleep 30", background: true } as never, undefined as never),
			).rejects.toThrow(/across the server/);

			await bashJob.execute("k1", { action: "stop", id: j1.jobId } as never, undefined as never);
			await bashJob.execute("k2", { action: "stop", id: j2.jobId } as never, undefined as never);
			await s2.bashJob.execute("k3", { action: "stop", id: j3.jobId } as never, undefined as never);

			// 3. LRU eviction: 5 finished jobs -> only 3 newest retained.
			const finishedIds: string[] = [];
			for (let i = 0; i < 5; i++) {
				const s = await bash.execute(`f${i}`, { command: `echo job-${i}`, background: true } as never, undefined as never);
				const id = (s.details as { jobId: string }).jobId;
				await bashJob.execute(`w${i}`, { action: "wait", id, waitSeconds: 5 } as never, undefined as never);
				finishedIds.push(id);
				await sleep(10);
			}
			const retained = mgr.list("s1").map((j) => j.jobId);
			expect(retained.length).toBe(3);
			expect(retained).not.toContain(finishedIds[0]!);
			expect(retained).not.toContain(finishedIds[1]!);
			expect(retained).toContain(finishedIds[4]!);
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("abort signal immediately unblocks wait and output polling", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-abort-"));
		const mgr = new BackgroundBashManager();
		try {
			const { bash, bashJob } = makeTools(dir, mgr, "s1");
			const started = await bash.execute("c1", { command: "sleep 30", background: true } as never, undefined as never);
			const jobId = (started.details as { jobId: string }).jobId;

			// Already aborted signal rejects immediately.
			const pre = new AbortController();
			pre.abort();
			await expect(
				bashJob.execute("w0", { action: "wait", id: jobId, waitSeconds: 10 } as never, pre.signal),
			).rejects.toThrow(/aborted/i);

			// Aborting mid-wait unblocks promptly without killing the background job.
			const ctl = new AbortController();
			const t0 = Date.now();
			setTimeout(() => ctl.abort(), 150);
			await expect(
				bashJob.execute("w1", { action: "wait", id: jobId, waitSeconds: 20 } as never, ctl.signal),
			).rejects.toThrow(/aborted/i);
			expect(Date.now() - t0).toBeLessThan(2000);

			// Job is still running after wait abort.
			expect(mgr.list("s1").find((j) => j.jobId === jobId)?.status).toBe("running");
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("backgroundOnTimeout: true transitions timed-out foreground bash to background seamlessly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-timeout-"));
		const mgr = new BackgroundBashManager();
		try {
			const { bash, bashJob } = makeTools(dir, mgr, "s1");

			// 1. Finishes before timeout -> normal sync result, no background job created.
			const fast = await bash.execute(
				"fast",
				{ command: "echo quick", timeout: 5, backgroundOnTimeout: true } as never,
				undefined as never,
			);
			expect((fast.content[0] as { text: string }).text.trim()).toBe("quick");
			expect((fast.details as { timedOutToBackground?: boolean }).timedOutToBackground).toBeUndefined();
			expect(mgr.list("s1")).toEqual([]);

			// 2. Exceeds timeout -> transitions to background job without killing process or losing output.
			const slow = await bash.execute(
				"slow",
				{ command: "echo before-timeout; sleep 1.6; echo after-timeout", timeout: 1, backgroundOnTimeout: true } as never,
				undefined as never,
			);
			const details = slow.details as { jobId: string; status: string; timedOutToBackground: boolean; nextOffset: number };
			expect(details.timedOutToBackground).toBe(true);
			expect(details.status).toBe("running");
			expect(details.jobId).toMatch(/^bg_/);
			expect((slow.content[0] as { text: string }).text).toContain("before-timeout");

			const final = await bashJob.execute(
				"w1",
				{ action: "wait", id: details.jobId, offset: details.nextOffset, waitSeconds: 5 } as never,
				undefined as never,
			);
			const fd = final.details as { status: string; exitCode: number };
			expect(fd.status).toBe("exited");
			expect(fd.exitCode).toBe(0);
			expect((final.content[0] as { text: string }).text).toContain("after-timeout");
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("backgroundOnTimeout: true kills process and throws when session job limit is reached", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-to-cap-"));
		const mgr = new BackgroundBashManager({ maxRunningPerSession: 1 });
		try {
			const { bash } = makeTools(dir, mgr, "s1");
			await bash.execute("bg1", { command: "sleep 30", background: true } as never, undefined as never);
			await expect(
				bash.execute(
					"to1",
					{ command: "sleep 300 & echo $! > leak.pid; wait", timeout: 1, backgroundOnTimeout: true } as never,
					undefined as never,
				),
			).rejects.toThrow(/Too many background jobs/);
			const leakPid = Number(await waitForFile(join(dir, "leak.pid")));
			await waitDead(leakPid);
			expect(alive(leakPid)).toBe(false);
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("stopSession and shutdown terminate running background process groups cleanly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-clean-"));
		const mgr = new BackgroundBashManager();
		try {
			const a = makeTools(dir, mgr, "sA");
			const b = makeTools(dir, mgr, "sB");

			await a.bash.execute("a1", { command: "sleep 300 & echo $! > a.pid; wait", background: true } as never, undefined as never);
			await b.bash.execute("b1", { command: "sleep 300 & echo $! > b.pid; wait", background: true } as never, undefined as never);
			const pidA = Number(await waitForFile(join(dir, "a.pid")));
			const pidB = Number(await waitForFile(join(dir, "b.pid")));
			expect(alive(pidA)).toBe(true);
			expect(alive(pidB)).toBe(true);

			// Stopping session A kills only A's processes, leaving B untouched.
			mgr.stopSession("sA");
			await waitDead(pidA);
			expect(alive(pidA)).toBe(false);
			expect(alive(pidB)).toBe(true);

			// Shutdown kills B as well.
			mgr.shutdown();
			await waitDead(pidB);
			expect(alive(pidB)).toBe(false);
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("keeps job running when shell exits while group child is alive, and stop kills it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-subchild-"));
		const mgr = new BackgroundBashManager();
		try {
			const { bash, bashJob } = makeTools(dir, mgr, "s1");
			// Shell exits immediately after spawning a background child in the same process group.
			const started = await bash.execute(
				"c1",
				{ command: "sleep 300 & echo $! > child.pid", background: true } as never,
				undefined as never,
			);
			const jobId = (started.details as { jobId: string }).jobId;
			const childPid = Number(await waitForFile(join(dir, "child.pid")));
			expect(alive(childPid)).toBe(true);

			// Wait past POST_EXIT_PIPE_GRACE_MS (500ms): job must still be running, not prematurely marked exited.
			await sleep(750);
			const snap = mgr.list("s1").find((j) => j.jobId === jobId)!;
			expect(snap.status).toBe("running");

			const stopped = await bashJob.execute("s1", { action: "stop", id: jobId } as never, undefined as never);
			expect((stopped.details as { status: string }).status).toBe("killed");
			await waitDead(childPid);
			expect(alive(childPid)).toBe(false);
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reports non-zero exitCode, disables background tools when bgBash is null, and tombstones deleted sessions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-bg-misc-"));
		const mgr = new BackgroundBashManager();
		try {
			const { bash, bashJob } = makeTools(dir, mgr, "s1");
			const s = await bash.execute("nz", { command: "echo fail && exit 42", background: true } as never, undefined as never);
			const jobId = (s.details as { jobId: string }).jobId;
			const waited = await bashJob.execute("w1", { action: "wait", id: jobId, waitSeconds: 5 } as never, undefined as never);
			expect((waited.details as { status: string; exitCode: number }).status).toBe("exited");
			expect((waited.details as { exitCode: number }).exitCode).toBe(42);

			// Permanent stop tombstones the session against new starts.
			mgr.stopSession("s1", { permanent: true });
			await expect(
				bash.execute("after-del", { command: "echo hi", background: true } as never, undefined as never),
			).rejects.toThrow(/deleted/);

			// bgBash: null omits bash_job and rejects background bash calls.
			const restricted = buildTools(["bash", BG_BASH_JOB_TOOL], dir, [], { bgBash: null });
			expect(restricted.map((t) => t.name)).toEqual(["bash"]);
			await expect(
				restricted[0]!.execute("r1", { command: "echo hi", background: true } as never, undefined as never),
			).rejects.toThrow(/not available/);
			await expect(
				restricted[0]!.execute("r2", { command: "echo hi", backgroundOnTimeout: true } as never, undefined as never),
			).rejects.toThrow(/not available/);
		} finally {
			mgr.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("buildChildEnv strips secret-suffixed prefix vars and case-insensitive PIPAYA_ vars", () => {
		const env = buildChildEnv({
			PATH: "/usr/bin",
			MISE_DATA_DIR: "/tmp/mise",
			MISE_GITHUB_TOKEN: "ghp_secret",
			Pipaya_Token: "secret",
			PIPAYA_BASH_ENV: "Pipaya_Token",
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env.MISE_DATA_DIR).toBe("/tmp/mise");
		expect(env.MISE_GITHUB_TOKEN).toBeUndefined();
		expect(env.Pipaya_Token).toBeUndefined();
	});
});

describe("background bash integration (guard + session delete cleanup)", () => {
	let dir = "";
	let ws = "";
	let upstream: ReturnType<typeof startEchoUpstream>;
	let app: Awaited<ReturnType<typeof buildApp>>;

	const api = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
		const res = await app.server.inject({
			method,
			url,
			headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
			...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
		});
		return { status: res.statusCode, json: res.body ? res.json() : undefined };
	};
	const idle = async (id: string) => {
		const until = Date.now() + 8000;
		while (Date.now() < until) {
			if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
			await Bun.sleep(20);
		}
		throw new Error("never idle");
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-bg-app-"));
		ws = join(dir, "ws");
		mkdirSync(ws);
		upstream = startEchoUpstream();
		const cfg: Config = {
			host: "0.0.0.0",
			port: 0,
			dataDir: dir,
			dbPath: join(dir, "db.sqlite"),
			token: "test-token",
			workspaceRoot: ws,
			logLevel: "silent",
		};
		app = await buildApp(cfg, { strictResponses: true, home: dir });
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	});

	afterAll(async () => {
		await app?.close();
		upstream?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("guard.ts blocks dangerous commands even when background: true", async () => {
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, {
			text: `!bash ${JSON.stringify({ command: "rm -rf /", background: true })}`,
		});
		await idle(id);
		const result = (await api("GET", `/sessions/${id}/messages`)).json.messages
			.map((m: { message: { role: string; toolName?: string; content?: unknown } }) => m.message)
			.find((m: { role: string; toolName?: string }) => m.role === "toolResult" && m.toolName === "bash");
		expect(JSON.stringify(result?.content ?? "")).toContain("refused by guard");
	});

	test("deleting a session terminates its running background bash processes", async () => {
		const s1 = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		const s2 = (await api("POST", "/sessions", { cwd: ws })).json.id as string;

		await api("POST", `/sessions/${s1}/messages`, {
			text: `!bash ${JSON.stringify({ command: "sleep 300 & echo $! > s1.pid; wait", background: true })}`,
		});
		await idle(s1);
		await api("POST", `/sessions/${s2}/messages`, {
			text: `!bash ${JSON.stringify({ command: "sleep 300 & echo $! > s2.pid; wait", background: true })}`,
		});
		await idle(s2);

		const pid1 = Number(await waitForFile(join(ws, "s1.pid")));
		const pid2 = Number(await waitForFile(join(ws, "s2.pid")));
		expect(alive(pid1)).toBe(true);
		expect(alive(pid2)).toBe(true);

		const del = await api("DELETE", `/sessions/${s1}`);
		expect(del.status).toBe(204);
		await waitDead(pid1);
		expect(alive(pid1)).toBe(false);
		expect(alive(pid2)).toBe(true);

		// Clean up s2 as well.
		await api("DELETE", `/sessions/${s2}`);
		await waitDead(pid2);
		expect(alive(pid2)).toBe(false);
	});

	test("closing a session terminates its running background bash processes", async () => {
		const s1 = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${s1}/messages`, {
			text: `!bash ${JSON.stringify({ command: "sleep 300 & echo $! > close.pid; wait", background: true })}`,
		});
		await idle(s1);

		const pid = Number(await waitForFile(join(ws, "close.pid")));
		expect(alive(pid)).toBe(true);

		const closed = await api("PATCH", `/sessions/${s1}`, { closed: true });
		expect(closed.status).toBe(200);
		await waitDead(pid);
		expect(alive(pid)).toBe(false);
	});
});
