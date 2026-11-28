import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { FileCheckpoints } from "../src/file-checkpoints.ts";
import { SessionStore } from "../src/store.ts";
import { buildTools } from "../src/tools.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

function mkTmp(prefix = "pipaya-ckpt-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function makeFixture(limits?: { maxFileBytes?: number; maxCheckpointsPerSession?: number; maxBytesPerSession?: number }) {
	const root = mkTmp();
	const ws = join(root, "ws");
	mkdirSync(ws, { recursive: true });
	const db = openDb(":memory:");
	cleanups.push(() => db.close());
	const store = new SessionStore(db);
	const now = Date.now();
	const session = {
		id: "sess-1",
		title: "test",
		name: "A1",
		purpose: "",
		cwd: ws,
		provider: "mock",
		model: "mock-1",
		thinkingLevel: "off" as const,
		serviceTier: null,
		systemPrompt: "",
		tools: ["read", "write", "edit"],
		parentId: null,
		closed: false,
		activeDir: null,
		createdAt: now,
		updatedAt: now,
	};
	store.create(session);
	const ckpt = new FileCheckpoints(db, limits);
	return { root, ws, db, store, session, ckpt };
}

function makeTools(ws: string, ckpt: FileCheckpoints, sessionId: string, getTurn: () => number) {
	const readTracker = new Map<string, { mtimeMs: number; size: number }>();
	const tools = buildTools(["write", "edit"], ws, [], {
		sessionId,
		getCwd: () => ws,
		readTracker,
		fileCheckpoint: {
			beforeWrite: (file) => ckpt.beforeWrite(sessionId, getTurn(), ws, file),
			afterWrite: (token, content) => ckpt.afterWrite(token as any, content),
		},
	});
	const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
	return {
		write: (path: string, content: string) => byName.write!.execute("tc-w", { path, content }),
		edit: (path: string, oldText: string, newText: string) => byName.edit!.execute("tc-e", { path, oldText, newText }),
	};
}

describe("FileCheckpoints unit", () => {
	test("same file modified twice in one turn stores only earliest original and restores it", async () => {
		const { ws, db, session, ckpt } = makeFixture();
		const target = join(ws, "hello.txt");
		writeFileSync(target, "original\n", "utf8");

		const turn = 1;
		const t = makeTools(ws, ckpt, session.id, () => turn);
		await t.edit("hello.txt", "original", "v1");
		await t.edit("hello.txt", "v1", "v2");

		expect(readFileSync(target, "utf8")).toBe("v2\n");
		const rowCount = (db.query("SELECT COUNT(*) AS c FROM file_checkpoints WHERE session_id = ?").get(session.id) as { c: number }).c;
		expect(rowCount).toBe(1);

		const turns = ckpt.listTurns(session.id);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.turnSeq).toBe(1);
		expect(turns[0]!.files).toEqual([{ relPath: "hello.txt", action: "restore", skippedReason: null }]);

		const res = await ckpt.rewind(session.id, 1, ws);
		expect(res.applied).toBe(true);
		expect(res.conflicts).toEqual([]);
		expect(res.restored).toEqual(["hello.txt"]);
		expect(readFileSync(target, "utf8")).toBe("original\n");
		expect(ckpt.listTurns(session.id)).toEqual([]);
	});

	test("newly created file via write is deleted on rewind", async () => {
		const { ws, session, ckpt } = makeFixture();
		const t = makeTools(ws, ckpt, session.id, () => 2);
		await t.write("sub/new-file.txt", "created content");
		await t.edit("sub/new-file.txt", "created", "updated");

		const target = join(ws, "sub/new-file.txt");
		expect(existsSync(target)).toBe(true);

		const res = await ckpt.rewind(session.id, 2, ws);
		expect(res.applied).toBe(true);
		expect(res.deleted).toEqual(["sub/new-file.txt"]);
		expect(existsSync(target)).toBe(false);
	});

	test("multi-turn rewind to turn 1 reverts both turn 1 and turn 2", async () => {
		const { ws, session, ckpt } = makeFixture();
		writeFileSync(join(ws, "a.txt"), "a0", "utf8");

		let turn = 1;
		const t = makeTools(ws, ckpt, session.id, () => turn);
		await t.write("a.txt", "a1");
		await t.write("b.txt", "b1");

		turn = 3;
		await t.write("a.txt", "a2");
		await t.write("b.txt", "b2");
		await t.write("c.txt", "c1");

		// Preview turn 1
		const preview = await ckpt.rewind(session.id, 1, ws, { dryRun: true });
		expect(preview.applied).toBe(false);
		expect(preview.dryRun).toBe(true);
		expect(preview.files.map((f) => `${f.action}:${f.path}`).sort()).toEqual([
			"delete:b.txt",
			"delete:c.txt",
			"restore:a.txt",
		]);
		// Disk untouched by dryRun
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a2");

		// Execute rewind to turn 1
		const res = await ckpt.rewind(session.id, 1, ws);
		expect(res.applied).toBe(true);
		expect(res.restored).toEqual(["a.txt"]);
		expect(res.deleted.sort()).toEqual(["b.txt", "c.txt"]);
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a0");
		expect(existsSync(join(ws, "b.txt"))).toBe(false);
		expect(existsSync(join(ws, "c.txt"))).toBe(false);
	});

	test("external modification conflict blocks rewind by default and succeeds with force: true", async () => {
		const { ws, session, ckpt } = makeFixture();
		const target = join(ws, "config.txt");
		writeFileSync(target, "before", "utf8");

		const t = makeTools(ws, ckpt, session.id, () => 1);
		await t.write("config.txt", "agent-edit");

		// External user edit on disk
		writeFileSync(target, "user-manual-edit", "utf8");

		const blocked = await ckpt.rewind(session.id, 1, ws);
		expect(blocked.applied).toBe(false);
		expect(blocked.conflicts).toEqual(["config.txt"]);
		expect(blocked.files[0]?.conflict).toBe(true);
		expect(blocked.files[0]?.conflictReason).toBe("modified");
		// File was NOT overwritten
		expect(readFileSync(target, "utf8")).toBe("user-manual-edit");

		const forced = await ckpt.rewind(session.id, 1, ws, { force: true });
		expect(forced.applied).toBe(true);
		expect(forced.restored).toEqual(["config.txt"]);
		expect(readFileSync(target, "utf8")).toBe("before");
	});

	test("empty file (0 bytes) is captured and restored accurately", async () => {
		const { ws, session, ckpt } = makeFixture();
		const target = join(ws, "empty.txt");
		writeFileSync(target, "", "utf8");

		const t = makeTools(ws, ckpt, session.id, () => 0);
		await t.write("empty.txt", "non-empty now");
		expect(readFileSync(target, "utf8")).toBe("non-empty now");

		const res = await ckpt.rewind(session.id, 0, ws);
		expect(res.applied).toBe(true);
		expect(res.restored).toEqual(["empty.txt"]);
		expect(readFileSync(target, "utf8")).toBe("");
	});

	test("oversized file and binary file are recorded as skipped and not overwritten", async () => {
		const { ws, session, ckpt } = makeFixture({ maxFileBytes: 64 });
		const big = join(ws, "big.txt");
		const bin = join(ws, "data.bin");
		writeFileSync(big, "x".repeat(128), "utf8");
		writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

		const t = makeTools(ws, ckpt, session.id, () => 1);
		await t.write("big.txt", "smaller");
		await t.write("data.bin", "text");

		const res = await ckpt.rewind(session.id, 1, ws);
		expect(res.applied).toBe(true);
		expect(res.skipped).toEqual([
			{ path: "big.txt", reason: "too_large" },
			{ path: "data.bin", reason: "binary" },
		]);
		expect(readFileSync(big, "utf8")).toBe("smaller");
		expect(readFileSync(bin, "utf8")).toBe("text");
	});

	test("symlink escape, outside workspace, and .git internals are blocked", async () => {
		const { root, ws, session, ckpt } = makeFixture();
		const outside = join(root, "secret.txt");
		writeFileSync(outside, "top-secret", "utf8");

		// 1. Symlink inside workspace pointing outside
		const linkPath = join(ws, "escape.txt");
		symlinkSync(outside, linkPath);

		// 2. .git/HEAD inside workspace
		mkdirSync(join(ws, ".git"), { recursive: true });
		writeFileSync(join(ws, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");

		// 3. Regular file later swapped with symlink before rewind (TOCTOU defense)
		const normal = join(ws, "normal.txt");
		writeFileSync(normal, "safe-before", "utf8");

		const t = makeTools(ws, ckpt, session.id, () => 1);
		await t.write("escape.txt", "pwned");
		await t.write(".git/HEAD", "ref: refs/heads/evil\n");
		await t.write("../secret.txt", "outside-write");
		await t.write("normal.txt", "safe-after");

		// Swap normal.txt with a symlink to outside before rewind
		rmSync(normal);
		symlinkSync(outside, normal);

		const res = await ckpt.rewind(session.id, 1, ws, { force: true });
		expect(res.applied).toBe(true);
		expect(res.restored).toEqual([]);
		expect(res.skipped.map((s) => `${s.path}:${s.reason}`).sort()).toEqual([
			".git/HEAD:sensitive_path",
			"escape.txt:symlink_escape",
			"normal.txt:symlink_escape",
		]);
		// Outside file was NOT reverted to "safe-before"
		expect(readFileSync(outside, "utf8")).toBe("outside-write");
	});

	test("prunes oldest turns when per-session checkpoint limit is exceeded", async () => {
		const { ws, session, ckpt } = makeFixture({ maxCheckpointsPerSession: 2 });
		let turn = 1;
		const t = makeTools(ws, ckpt, session.id, () => turn);
		await t.write("f1.txt", "1");
		turn = 2;
		await t.write("f2.txt", "2");
		turn = 3;
		await t.write("f3.txt", "3");

		const turns = ckpt.listTurns(session.id);
		expect(turns.map((x) => x.turnSeq)).toEqual([2, 3]);
	});

	test("byte cap prunes older turns before inserting so new turns keep capturing snapshots", async () => {
		const { ws, session, ckpt } = makeFixture({ maxBytesPerSession: 100 });
		writeFileSync(join(ws, "a.txt"), "a".repeat(70), "utf8");
		writeFileSync(join(ws, "b.txt"), "b".repeat(70), "utf8");

		let turn = 1;
		const t = makeTools(ws, ckpt, session.id, () => turn);
		await t.write("a.txt", "a-new");

		turn = 2;
		await t.write("b.txt", "b-new");

		// Turn 1 was pruned to make room for turn 2 (70 + 70 > 100), so turn 2 is captured normally.
		const turns = ckpt.listTurns(session.id);
		expect(turns.map((x) => x.turnSeq)).toEqual([2]);
		expect(turns[0]?.files[0]?.action).toBe("restore");

		const res = await ckpt.rewind(session.id, 2, ws);
		expect(res.applied).toBe(true);
		expect(res.restored).toEqual(["b.txt"]);
		expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("b".repeat(70));
	});

	test("enforces per-session quota even within a single turn and blocks nested/case-variant .git", async () => {
		const { ws, session, ckpt } = makeFixture({ maxCheckpointsPerSession: 2 });
		const t = makeTools(ws, ckpt, session.id, () => 1);
		await t.write("f1.txt", "1");
		await t.write("f2.txt", "2");
		await t.write("f3.txt", "3");

		mkdirSync(join(ws, "sub/.GIT"), { recursive: true });
		writeFileSync(join(ws, "sub/.GIT/config"), "git-cfg", "utf8");
		await t.write("sub/.GIT/config", "modified");

		const res = await ckpt.rewind(session.id, 1, ws, { dryRun: true });
		const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
		expect(byPath["f1.txt"]?.action).toBe("delete");
		expect(byPath["f2.txt"]?.action).toBe("delete");
		expect(byPath["f3.txt"]?.action).toBe("skip");
		expect(byPath["f3.txt"]?.skippedReason).toBe("limit_exceeded");
		expect(byPath["sub/.GIT/config"]?.action).toBe("skip");
		expect(byPath["sub/.GIT/config"]?.skippedReason).toBe("sensitive_path");
	});

	test("deleting session cascades and removes all file checkpoints", async () => {
		const { ws, db, store, session, ckpt } = makeFixture();
		const t = makeTools(ws, ckpt, session.id, () => 1);
		await t.write("a.txt", "hello");

		const before = (db.query("SELECT COUNT(*) AS c FROM file_checkpoints WHERE session_id = ?").get(session.id) as { c: number }).c;
		expect(before).toBe(1);

		store.delete(session.id);

		const after = (db.query("SELECT COUNT(*) AS c FROM file_checkpoints WHERE session_id = ?").get(session.id) as { c: number }).c;
		expect(after).toBe(0);
	});
});

describe("FileCheckpoints HTTP routes", () => {
	async function startTestApp() {
		const root = mkTmp("pipaya-ckpt-app-");
		const dataDir = join(root, "data");
		const ws = join(root, "ws");
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(ws, { recursive: true });

		let releaseStream: (() => void) | null = null;
		let streamStarted: (() => void) | null = null;
		const upstream = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
				await req.json();
				const enc = new TextEncoder();
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(
							enc.encode(
								`data: ${JSON.stringify({
									id: "chatcmpl-test",
									object: "chat.completion.chunk",
									created: 1,
									model: "mock-1",
									choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
								})}\n\n`,
							),
						);
						streamStarted?.();
						streamStarted = null;
						const finish = () => {
							try {
								controller.enqueue(
									enc.encode(
										`data: ${JSON.stringify({
											id: "chatcmpl-test",
											object: "chat.completion.chunk",
											created: 1,
											model: "mock-1",
											choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
										})}\n\n`,
									),
								);
								controller.enqueue(enc.encode("data: [DONE]\n\n"));
								controller.close();
							} catch { /* already closed */ }
						};
						releaseStream = finish;
						req.signal.addEventListener("abort", () => {
							try { controller.close(); } catch { /* already closed */ }
						}, { once: true });
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			},
		});
		cleanups.push(() => upstream.stop(true));

		const cfg: Config = {
			host: "127.0.0.1",
			port: 0,
			token: "test-token",
			dataDir,
			dbPath: join(dataDir, "pipaya.db"),
			workspaceRoot: ws,
			logLevel: "silent",
		};
		const app = await buildApp(cfg);
		cleanups.push(() => app.close());
		const auth = { authorization: `Bearer ${cfg.token}` };

		await app.server.inject({
			method: "PUT",
			url: "/configuration/providers/mock",
			headers: { ...auth, "content-type": "application/json" },
			payload: JSON.stringify({
				name: "Mock",
				baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
				api: "openai-completions",
				authRequired: false,
				models: [{ id: "mock-1", name: "Mock 1", contextWindow: 8192, maxTokens: 1024, reasoning: false, vision: false }],
			}),
		});
		await app.server.inject({
			method: "PUT",
			url: "/configuration/defaults",
			headers: { ...auth, "content-type": "application/json" },
			payload: JSON.stringify({ provider: "mock", model: "mock-1" }),
		});

		return {
			app,
			cfg,
			ws,
			auth,
			waitForStream: () => new Promise<void>((r) => { streamStarted = r; }),
			release: () => { releaseStream?.(); releaseStream = null; },
		};
	}

	test("GET /checkpoints and POST /rewind support dryRun, files_and_chat truncation, and 404/400", async () => {
		const { app, ws, auth, waitForStream, release } = await startTestApp();

		const created = await app.server.inject({
			method: "POST",
			url: "/sessions",
			headers: auth,
			payload: { title: "rewind-test", cwd: ws },
		});
		expect(created.statusCode).toBe(201);
		const sessionId = created.json().id as string;

		// Run turn 0 and turn 2 through the real session pipeline
		const s0 = waitForStream();
		await app.server.inject({ method: "POST", url: `/sessions/${sessionId}/messages`, headers: auth, payload: { text: "turn 0" } });
		await s0;
		release();
		await app.sessions.idle();

		const s2 = waitForStream();
		await app.server.inject({ method: "POST", url: `/sessions/${sessionId}/messages`, headers: auth, payload: { text: "turn 2" } });
		await s2;
		release();
		await app.sessions.idle();

		// Record a checkpoint at turn 2
		const file = join(ws, "app.ts");
		writeFileSync(file, "const v = 1;\n", "utf8");
		const snap = await app.sessions.checkpoints.beforeWrite(sessionId, 2, ws, file);
		writeFileSync(file, "const v = 2;\n", "utf8");
		app.sessions.checkpoints.afterWrite(snap!, "const v = 2;\n");

		// GET /checkpoints
		const listRes = await app.server.inject({
			method: "GET",
			url: `/sessions/${sessionId}/checkpoints`,
			headers: auth,
		});
		expect(listRes.statusCode).toBe(200);
		expect(listRes.json().turns).toHaveLength(1);
		expect(listRes.json().turns[0].turnSeq).toBe(2);

		// POST /rewind with files_and_chat
		const rewindRes = await app.server.inject({
			method: "POST",
			url: `/sessions/${sessionId}/rewind`,
			headers: auth,
			payload: { turnSeq: 2, mode: "files_and_chat" },
		});
		expect(rewindRes.statusCode).toBe(200);
		const body = rewindRes.json();
		expect(body.applied).toBe(true);
		expect(body.restored).toEqual(["app.ts"]);
		expect(body.truncatedFromSeq).toBe(2);
		expect(readFileSync(file, "utf8")).toBe("const v = 1;\n");

		// Messages >= 2 were truncated
		const msgsRes = await app.server.inject({
			method: "GET",
			url: `/sessions/${sessionId}/messages`,
			headers: auth,
		});
		expect(msgsRes.json().messages.map((m: { seq: number }) => m.seq)).toEqual([0, 1]);

		// 404 for unknown session
		const missing = await app.server.inject({
			method: "GET",
			url: "/sessions/does-not-exist/checkpoints",
			headers: auth,
		});
		expect(missing.statusCode).toBe(404);

		// 400 for negative turnSeq
		const bad = await app.server.inject({
			method: "POST",
			url: `/sessions/${sessionId}/rewind`,
			headers: auth,
			payload: { turnSeq: -1 },
		});
		expect(bad.statusCode).toBe(400);
	});

	test("POST /rewind returns 409 when session is busy (running)", async () => {
		const { app, ws, auth, waitForStream, release } = await startTestApp();
		const created = await app.server.inject({
			method: "POST",
			url: "/sessions",
			headers: auth,
			payload: { title: "busy-test", cwd: ws },
		});
		expect(created.statusCode).toBe(201);
		const sessionId = created.json().id as string;

		const started = waitForStream();
		const sendRes = await app.server.inject({
			method: "POST",
			url: `/sessions/${sessionId}/messages`,
			headers: auth,
			payload: { text: "hello" },
		});
		expect(sendRes.statusCode).toBe(202);
		await started;

		const res = await app.server.inject({
			method: "POST",
			url: `/sessions/${sessionId}/rewind`,
			headers: auth,
			payload: { turnSeq: 0 },
		});
		expect(res.statusCode).toBe(409);

		release();
		await app.sessions.idle();
	});
});
