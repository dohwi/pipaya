import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { PeerService, type PeerHost } from "../src/peers.ts";
import { SessionStore } from "../src/store.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

function makeStore() {
	const db = openDb(":memory:");
	const store = new SessionStore(db);
	const seed = (id: string, name: string, closed = false) =>
		store.create({
			id,
			name,
			cwd: "/tmp",
			title: name,
			provider: "p",
			model: "m",
			thinkingLevel: "off",
			systemPrompt: "",
			tools: [],
			purpose: "",
			parentId: null,
			closed,
			createdAt: 1,
			updatedAt: 1,
		});
	return { db, store, seed };
}

function makeHost(store: SessionStore, overrides: Partial<PeerHost> = {}) {
	let finishCb: ((id: string, res: { status?: string; error?: string | null }) => void) | undefined;
	let questionCb: ((id: string, q: any) => void) | undefined;
	const delivered: { id: string; text: string; mode: string; busyMode?: string }[] = [];
	const running = new Set<string>();
	const aborted: string[] = [];

	const host: PeerHost = {
		store,
		groups: () => [],
		isRunning: (id) => running.has(id),
		deliver: async (id, text, mode, busyMode) => {
			delivered.push({ id, text, mode, busyMode });
			return { accepted: running.has(id) ? (busyMode ?? "follow_up") : "prompt" };
		},
		rename: () => {},
		abort: (id) => {
			aborted.push(id);
			if (!running.has(id)) return false;
			running.delete(id);
			return true;
		},
		onRunFinished: (fn) => { finishCb = fn; },
		onQuestion: (fn) => { questionCb = fn; },
		questions: () => [],
		answer: () => "not_found",
		create: async () => { throw new Error("not implemented"); },
		update: (id, patch) => {
			store.update(id, patch);
			if (patch.closed) peers.onClosed(id);
		},
		remove: () => {},
		cancelQueued: () => false,
		queued: () => [],
		groupOps: { create: () => "", add: () => "", remove: () => "", dissolve: () => "" },
		...overrides,
	};
	const peers = new PeerService(host);
	return {
		host,
		peers,
		delivered,
		running,
		aborted,
		emitFinished: (id: string, res: { status?: string; error?: string | null } = { status: "ok" }) => finishCb?.(id, res),
		emitQuestion: (id: string, q: any) => questionCb?.(id, q),
	};
}

describe("PeerService unit regressions (bugs 1, 2, 3)", () => {
	test("bug 1: direct peer(send) reply suppresses duplicate normal-completion report, but still reports errors/questions/re-watch", async () => {
		const { db, store, seed } = makeStore();
		try {
			seed("a", "A1");
			seed("b", "B1");
			const { peers, delivered, emitFinished, emitQuestion } = makeHost(store);

			// A watches B; B replies directly to A; B finishes ok -> no duplicate "finished its run" report.
			await peers.send("a", "B1", "do work", { notify: true });
			delivered.length = 0;
			await peers.send("b", "A1", "here is the answer");
			expect(delivered).toHaveLength(1);
			expect(delivered[0]!.id).toBe("a");
			expect(delivered[0]!.text).toContain("here is the answer");

			emitFinished("b", { status: "ok" });
			expect(delivered).toHaveLength(1); // no second wake-up!

			// A watches B; B sends a progress update to A, then does more tool work (noteWork) -> A STILL gets finish report!
			await peers.send("a", "B1", "do work 1b", { notify: true });
			delivered.length = 0;
			await peers.send("b", "A1", "starting work, will report back");
			peers.noteWork("b");
			emitFinished("b", { status: "ok" });
			expect(delivered).toHaveLength(2);
			expect(delivered[1]!.text).toContain("finished its run");

			// A watches B; B sends progress to A, then hits an error -> A still gets error report.
			await peers.send("a", "B1", "do work 2", { notify: true });
			delivered.length = 0;
			await peers.send("b", "A1", "halfway done");
			emitFinished("b", { status: "error", error: "boom" });
			expect(delivered).toHaveLength(2);
			expect(delivered[1]!.text).toContain("ended its run (error: boom)");

			// A watches B; B sends progress to A, then asks a question -> A still hears the question.
			await peers.send("a", "B1", "do work 3", { notify: true });
			delivered.length = 0;
			await peers.send("b", "A1", "starting");
			emitQuestion("b", { sessionId: "b", toolCallId: "q1", question: "proceed?", allowFreeText: true, requestedAt: 1 });
			expect(delivered).toHaveLength(2);
			expect(delivered[1]!.text).toContain("waiting for an answer");

			// A watches B; B replies to A; then A re-watches B before B finishes -> A gets finish report.
			emitFinished("b", { status: "ok" });
			await peers.send("a", "B1", "task 4", { notify: true });
			await peers.send("b", "A1", "partial");
			await peers.send("a", "B1", "keep going", { notify: true });
			delivered.length = 0;
			emitFinished("b", { status: "ok" });
			expect(delivered).toHaveLength(1);
			expect(delivered[0]!.text).toContain("finished its run");
		} finally {
			db.close();
		}
	});

	test("bug 1 + bug 3: watcher finishes before worker ends after direct reply still promotes to user and avoids double wake", async () => {
		const { db, store, seed } = makeStore();
		try {
			seed("a", "A1");
			seed("b", "B1");
			const { peers, delivered, emitFinished } = makeHost(store);

			// User run on A sends to B with notify: true.
			await peers.send("a", "B1", "work", { notify: true });
			expect(peers.settleRun("a", "user", "ok")).toBe("user");
			peers.resetRun("a");

			// B replies directly to A; A processes the reply and finishes BEFORE B's run ends.
			await peers.send("b", "A1", "all done");
			delivered.length = 0;
			expect(peers.settleRun("a", "peer", "ok")).toBe("user");

			// Now B finishes ok -> should NOT wake A again.
			emitFinished("b", { status: "ok" });
			expect(delivered).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	test("bug 2: close refuses working session; closed target suppresses ghost report; abort unwatches caller only", async () => {
		const { db, store, seed } = makeStore();
		try {
			seed("a", "A1");
			seed("b", "B1");
			seed("c", "C1");
			const { peers, delivered, running, emitFinished } = makeHost(store);

			// Working session cannot be closed via peer(action=close).
			running.add("b");
			expect(() => peers.manage("a", "B1", "close")).toThrow(/still working/);

			// Both A and C watch B; A calls peer(action=abort) -> A is unwatched, C still gets aborted report.
			store.watch("b", "a");
			store.watch("b", "c");
			expect(peers.abort("a", "B1")).toBe("Stopped @B1.");
			emitFinished("b", { status: "aborted" });
			expect(delivered.map((d) => d.id)).toEqual(["c"]);
			expect(delivered[0]!.text).toContain("ended its run (aborted)");

			// Aborting an idle session does NOT drop the caller's watch.
			store.watch("b", "a");
			expect(peers.abort("a", "B1")).toBe("@B1 was not working.");
			expect(store.watchers("b")).toEqual(["a"]);

			// Now B is idle -> close succeeds; closing B also clears A's stale chain so a later unrelated peer run stays "peer".
			await peers.send("a", "B1", "work", { notify: true });
			delivered.length = 0;
			expect(peers.settleRun("a", "user", "ok")).toBe("user");
			peers.resetRun("a");
			expect(peers.manage("a", "B1", "close")).toContain("Closed @B1");
			expect(store.get("b")?.closed).toBe(true);
			expect(peers.settleRun("a", "peer", "ok")).toBe("peer");
			// Even if a watch row were somehow present on a closed session, finished() suppresses it.
			store.watch("b", "c");
			emitFinished("b", { status: "aborted" });
			expect(delivered).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	test("bug 3: multi-worker chain stays peer until the last watched worker finishes", async () => {
		const { db, store, seed } = makeStore();
		try {
			seed("a", "A1");
			seed("b", "B1");
			seed("c", "C1");
			const { peers, emitFinished } = makeHost(store);

			// User run on A spawns/messages both B and C with notify: true.
			await peers.send("a", "B1", "task B", { notify: true });
			await peers.send("a", "C1", "task C", { notify: true });
			expect(peers.settleRun("a", "user", "ok")).toBe("user");
			peers.resetRun("a");

			// B finishes first -> A runs on B's report without sending new peer messages.
			// C is still watched, so A must NOT promote to "user" yet.
			emitFinished("b", { status: "ok" });
			expect(store.watching("a")).toEqual(["c"]);
			expect(peers.settleRun("a", "peer", "ok")).toBe("peer");
			peers.resetRun("a");

			// Even if user sends a quick check-in to A that doesn't call peer(send), chain stays alive while C is watched.
			expect(peers.settleRun("a", "user", "ok")).toBe("user");
			peers.resetRun("a");

			// C finishes last -> A runs on C's report and writes the final summary -> promotes to "user"!
			emitFinished("c", { status: "ok" });
			expect(store.watching("a")).toEqual([]);
			expect(peers.settleRun("a", "peer", "ok")).toBe("user");
			peers.resetRun("a");

			// Chain is now consumed: a later unrelated peer message stays "peer".
			expect(peers.settleRun("a", "peer", "ok")).toBe("peer");
		} finally {
			db.close();
		}
	});
});

describe("SessionManager integration regressions (bugs 2, 4, 5)", () => {
	let app: Awaited<ReturnType<typeof buildApp>>, base = "", dir = "", upstream: ReturnType<typeof startEchoUpstream>;
	const api = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, {
			method,
			headers: { authorization: "Bearer t", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const mk = async () => (await api("POST", "/sessions", {})).json.id as string;
	const idle = async (id: string) => {
		for (let i = 0; i < 200; i++) {
			if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
			await Bun.sleep(20);
		}
	};
	const said = async (id: string) => JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json);

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-peer-races-"));
		// A tiny server extension whose `input` hook supports test markers to deterministically trigger mid-await races.
		const extDir = join(dir, "ext", "race-hook");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`export default (pi: any) => {
				pi.on("input", async (ev: any) => {
					if (typeof ev.text === "string" && ev.text.includes("__SLOW_INPUT__")) {
						await new Promise((r) => setTimeout(r, 120));
					}
					if (typeof ev.text === "string" && ev.text.includes("__CLOSE_MID_INPUT__")) {
						await new Promise((r) => setTimeout(r, 40));
						pi.sessions.update(ev.sessionId, { closed: true });
					}
				});
			};`,
		);
		upstream = startEchoUpstream();
		app = await buildApp(
			{ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "t.db"), token: "t", workspaceRoot: join(dir, "ws"), logLevel: "silent" },
			{ strictResponses: true, extensionDirs: [join(dir, "ext")] },
		);
		await app.server.listen({ host: "0.0.0.0", port: 0 });
		base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	});

	afterAll(async () => {
		await app?.close();
		upstream?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("bug 2 (integration): closing a running watched session via SessionManager.update produces no ghost report", async () => {
		const a = await mk();
		const b = await mk();
		const bName = (await api("GET", `/sessions/${b}`)).json.name as string;
		await app.sessions.peers.send(a, bName, "!bash sleep 0.5", { notify: true });
		expect(app.sessions.isRunning(b)).toBe(true);
		app.sessions.update(b, { closed: true });
		await idle(b);
		await Bun.sleep(60);
		await idle(a);
		expect((await api("GET", `/sessions/${a}/messages`)).json.messages).toHaveLength(0);
	});

	test("bug 4a: concurrent auto peer deliveries to an idle session both succeed (prompt + follow_up) without 409 loss", async () => {
		const a = await mk();
		const [r1, r2] = await Promise.all([
			app.sessions.send(a, { text: "__SLOW_INPUT__ report-from-B", mode: "auto", origin: "peer" }),
			app.sessions.send(a, { text: "__SLOW_INPUT__ report-from-C", mode: "auto", origin: "peer" }),
		]);
		expect([r1.accepted, r2.accepted].sort()).toEqual(["follow_up", "prompt"]);
		await idle(a);
		const body = await said(a);
		expect(body).toContain("report-from-B");
		expect(body).toContain("report-from-C");
	});

	test("bug 4b: auto peer delivery starting while busy transitions cleanly to prompt when target goes idle mid-await", async () => {
		const a = await mk();
		// Hold A busy for 80ms; auto delivery waits 120ms in preprocess so A is busy at start and idle at commit.
		await app.sessions.send(a, { text: "!bash sleep 0.08", mode: "prompt", origin: "user" });
		expect(app.sessions.isRunning(a)).toBe(true);
		const res = await app.sessions.send(a, { text: "__SLOW_INPUT__ late-peer-report", mode: "auto", origin: "peer" });
		expect(res.accepted).toBe("prompt");
		await idle(a);
		expect(await said(a)).toContain("late-peer-report");
	});

	test("bug 4c: auto peer delivery while target is mid-abort waits for settled and delivers as prompt without 409", async () => {
		const a = await mk();
		await app.sessions.send(a, { text: "!bash sleep 0.5", mode: "prompt", origin: "user" });
		expect(app.sessions.isRunning(a)).toBe(true);
		expect(app.sessions.abort(a)).toBe(true);
		const res = await app.sessions.send(a, { text: "report-after-abort", mode: "auto", origin: "peer" });
		expect(res.accepted).toBe("prompt");
		await idle(a);
		expect(await said(a)).toContain("report-after-abort");
	});

	test("bug 5a: drainDeferred promotes origin to user when a user message is queued behind /compact after a peer message", async () => {
		const a = await mk();
		// Seed a turn so /compact has history (even if compact fails with not enough history, drainDeferred still runs the batch).
		await app.sessions.send(a, { text: "seed message", mode: "prompt", origin: "user" });
		await idle(a);

		// Start a slow bash command so the session stays running while we queue /compact, peer, and user messages.
		const origins: string[] = [];
		const off = app.bus.subscribe((e) => {
			if (e.type === "run_finished" && e.sessionId === a) {
				origins.push(String((e.data as { origin?: string }).origin));
			}
		});
		try {
			await app.sessions.send(a, { text: "!bash sleep 0.25", mode: "prompt", origin: "user" });
			await app.sessions.send(a, { text: "/compact", mode: "follow_up", command: { name: "compact" }, origin: "user" });
			await app.sessions.send(a, { text: "peer msg after compact", mode: "follow_up", origin: "peer" });
			await app.sessions.send(a, { text: "user msg after peer", mode: "follow_up", origin: "user" });
			await idle(a);
			// Wait for deferred drain + second run to settle.
			for (let i = 0; i < 100 && origins.length < 2; i++) await Bun.sleep(25);
			await idle(a);
			expect(origins).toEqual(["user", "user"]);
		} finally {
			off();
		}
	});

	test("bug 5b: closing a session while sendInner is suspended in await rejects with 409 and does not start a run", async () => {
		const a = await mk();
		await expect(
			app.sessions.send(a, { text: "__CLOSE_MID_INPUT__ should not run", mode: "prompt", origin: "user" }),
		).rejects.toThrow(/session is closed/);
		expect(app.sessions.isRunning(a)).toBe(false);
		expect((await api("GET", `/sessions/${a}`)).json.closed).toBe(true);
		expect((await api("GET", `/sessions/${a}/messages`)).json.messages).toHaveLength(0);
	});
});
