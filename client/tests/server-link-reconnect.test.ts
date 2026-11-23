import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { ServerLink as ServerLinkType } from "../src/lib/server-link.svelte";

let ServerLink: typeof ServerLinkType;
let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pipaya-link-reconnect-"));
	const srcPath = resolve("src/lib/server-link.svelte.ts");
	const build = await Bun.build({
		entrypoints: [srcPath],
		target: "bun",
		plugins: [
			{
				name: "runes",
				setup(builder) {
					builder.onLoad({ filter: /server-link\.svelte\.ts$/ }, async ({ path }) => {
						const raw = await Bun.file(path).text();
						const rewritten = raw.replace(/from "(\.\/[^"]+)"/g, (_, rel) => `from ${JSON.stringify(resolve("src/lib", rel))}`);
						const source = ts.transpileModule(rewritten, {
							compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
						}).outputText;
						return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
					});
				},
			},
		],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "server-link.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	ServerLink = (await import(file)).ServerLink;
});

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe("ServerLink stream drop and automatic reconnect", () => {
	test("reopening after a dropped stream (foreground server reboot) catches up failed/running activity and notifies warm ready", async () => {
		let activityState = {
			sessions: [{ sessionId: "s1", running: true, pendingQuestions: 0 }],
			unread: [] as { sessionId: string; kind: "done" | "failed" }[],
		};
		let latestId = 10;
		const streams: { onOpen?: () => void; onError?: () => void }[] = [];
		const readyCalls: boolean[] = [];

		const link = new ServerLink(
			{ id: "srv1", name: "Dev", baseUrl: "http://127.0.0.1:9999", token: "tok" },
			{
				event: () => {},
				ready: (_l, warm) => { readyCalls.push(warm); },
			},
		);

		const fakeApi: any = {
			scoped: () => fakeApi,
			health: async () => ({ ok: true, version: "0.10.4", protocol: 1, minClientProtocol: 1 }),
			listSessions: async () => ({ sessions: [{ id: "s1", title: "Task", cwd: "/w", closed: false, provider: "p", model: "m", thinkingLevel: "medium", tools: [], parentId: null, createdAt: 1, updatedAt: 1 }], nextBefore: null, nextBeforeId: null }),
			workspace: async () => ({ root: "/w", home: "/h", workdirs: [] }),
			groups: async () => [],
			terminals: async () => [],
			terminalSupport: async () => null,
			activity: async () => activityState,
			models: async () => [],
			providers: async () => [],
			tools: async () => ({ tools: [], defaults: [] }),
			latestEventId: async () => latestId,
			configuration: async () => null,
			compactionSettings: async () => null,
			systemModelSettings: async () => null,
			repos: async () => ({ repos: {} }),
			subscribe: (handlers: { onOpen?: () => void; onError?: () => void }) => {
				streams.push(handlers);
				queueMicrotask(() => handlers.onOpen?.());
				return () => {};
			},
		};
		(link as any).api = fakeApi;

		await link.sync();
		expect(link.data.running).toEqual({ s1: true });
		expect(link.data.failed).toEqual({});
		expect(readyCalls).toEqual([false]);

		// Simulate unexpected server reboot while window stayed in foreground (no wake event, plain stream drop + retry).
		activityState = {
			sessions: [],
			unread: [{ sessionId: "s1", kind: "failed" }],
		};
		latestId = 12;
		(link as any).retryDelay = 10;
		streams[0]!.onError?.();

		await Bun.sleep(40);
		expect(streams.length).toBeGreaterThanOrEqual(2);
		expect(link.data.running).toEqual({});
		expect(link.data.failed).toEqual({ s1: true });
		expect(readyCalls).toEqual([false, true]);
		link.stop();
	});

	test("sync captures latestEventId before reading activity so events during slow catalog load are replayed", async () => {
		const order: string[] = [];
		let subscribedAfter = -1;
		const link = new ServerLink(
			{ id: "srv2", name: "Dev", baseUrl: "http://127.0.0.1:9999", token: "tok" },
			{ event: () => {}, ready: () => {} },
		);
		const fakeApi: any = {
			scoped: () => fakeApi,
			health: async () => ({ ok: true, version: "0.10.4", protocol: 1, minClientProtocol: 1 }),
			listSessions: async () => ({ sessions: [], nextBefore: null, nextBeforeId: null }),
			workspace: async () => ({ root: "/w", home: "/h", workdirs: [] }),
			groups: async () => [],
			terminals: async () => [],
			terminalSupport: async () => null,
			latestEventId: async () => {
				order.push("latestEventId");
				return 42;
			},
			activity: async () => {
				order.push("activity");
				return { sessions: [], unread: [] };
			},
			models: async () => [],
			providers: async () => [],
			tools: async () => ({ tools: [], defaults: [] }),
			configuration: async () => null,
			compactionSettings: async () => null,
			systemModelSettings: async () => null,
			repos: async () => ({ repos: {} }),
			subscribe: (_handlers: unknown, after: number) => {
				subscribedAfter = after;
				return () => {};
			},
		};
		(link as any).api = fakeApi;

		await link.sync();
		expect(order).toEqual(["latestEventId", "activity"]);
		expect(subscribedAfter).toBe(42);
		link.stop();
	});

	test("refreshActivity updates running state from server snapshot", async () => {
		let running = true;
		const link = new ServerLink(
			{ id: "srv3", name: "Dev", baseUrl: "http://127.0.0.1:9999", token: "tok" },
			{ event: () => {}, ready: () => {} },
		);
		const fakeApi: any = {
			scoped: () => fakeApi,
			activity: async () => ({
				sessions: running ? [{ sessionId: "s1", running: true, pendingQuestions: 0 }] : [],
				unread: [],
			}),
		};
		(link as any).api = fakeApi;
		link.data.running = {};
		await link.refreshActivity();
		expect(link.data.running).toEqual({ s1: true });
		running = false;
		await link.refreshActivity();
		expect(link.data.running).toEqual({});
		link.stop();
	});

	test("falls back to full sync and preserves backoff when reopen opens and immediately drops (replay cutoff)", async () => {
		let latestId = 10;
		const subscribedAfters: number[] = [];
		const readyCalls: boolean[] = [];

		const link = new ServerLink(
			{ id: "srv4", name: "Dev", baseUrl: "http://127.0.0.1:9999", token: "tok" },
			{
				event: () => {},
				ready: (_l, warm) => { readyCalls.push(warm); },
			},
		);
		const fakeApi: any = {
			scoped: () => fakeApi,
			health: async () => ({ ok: true, version: "0.10.4", protocol: 1, minClientProtocol: 1 }),
			listSessions: async () => ({ sessions: [], nextBefore: null, nextBeforeId: null }),
			workspace: async () => ({ root: "/w", home: "/h", workdirs: [] }),
			groups: async () => [],
			terminals: async () => [],
			terminalSupport: async () => null,
			activity: async () => ({ sessions: [], unread: [] }),
			models: async () => [],
			providers: async () => [],
			tools: async () => ({ tools: [], defaults: [] }),
			latestEventId: async () => latestId,
			configuration: async () => null,
			compactionSettings: async () => null,
			systemModelSettings: async () => null,
			repos: async () => ({ repos: {} }),
			subscribe: (handlers: { onOpen?: () => void; onError?: () => void }, after: number) => {
				subscribedAfters.push(after);
				if (after === 10 && subscribedAfters.length === 1) {
					queueMicrotask(() => handlers.onOpen?.());
					// Initial stream later drops (simulate a replay loop on after=10).
					setTimeout(() => handlers.onError?.(), 15);
				} else if (after === 10) {
					// Reopen opens (200 OK) and drops right away before stabilizing (like an oversized replay cutoff).
					queueMicrotask(() => {
						handlers.onOpen?.();
						queueMicrotask(() => handlers.onError?.());
					});
				} else {
					// After falling back to sync() with the new cursor, the stream stays open.
					queueMicrotask(() => handlers.onOpen?.());
				}
				return () => {};
			},
		};
		(link as any).api = fakeApi;

		await link.sync();
		(link as any).retryDelay = 10;
		latestId = 50;

		// Wait long enough for: initial drop (15ms) -> reopen quick-drop (+10ms) -> backoff (+20ms) -> fallback sync(+microtasks).
		await Bun.sleep(100);
		expect(subscribedAfters).toEqual([10, 10, 50]);
		expect(link.online).toBe(true);
		expect(readyCalls).toEqual([false, true, false]);
		link.stop();
	});

	test("falls back to full sync after consecutive reopen errors without opening, preserving backoff", async () => {
		let latestId = 10;
		const subscribedAfters: number[] = [];
		const streams: { onOpen?: () => void; onError?: () => void }[] = [];

		const link = new ServerLink(
			{ id: "srv5", name: "Dev", baseUrl: "http://127.0.0.1:9999", token: "tok" },
			{ event: () => {}, ready: () => {} },
		);
		const fakeApi: any = {
			scoped: () => fakeApi,
			health: async () => ({ ok: true, version: "0.10.4", protocol: 1, minClientProtocol: 1 }),
			listSessions: async () => ({ sessions: [], nextBefore: null, nextBeforeId: null }),
			workspace: async () => ({ root: "/w", home: "/h", workdirs: [] }),
			groups: async () => [],
			terminals: async () => [],
			terminalSupport: async () => null,
			activity: async () => ({ sessions: [], unread: [] }),
			models: async () => [],
			providers: async () => [],
			tools: async () => ({ tools: [], defaults: [] }),
			latestEventId: async () => latestId,
			configuration: async () => null,
			compactionSettings: async () => null,
			systemModelSettings: async () => null,
			repos: async () => ({ repos: {} }),
			subscribe: (handlers: { onOpen?: () => void; onError?: () => void }, after: number) => {
				subscribedAfters.push(after);
				streams.push(handlers);
				if (after === 10 && subscribedAfters.length === 1) {
					queueMicrotask(() => handlers.onOpen?.());
				} else if (after === 10) {
					queueMicrotask(() => handlers.onError?.());
				} else {
					queueMicrotask(() => handlers.onOpen?.());
				}
				return () => {};
			},
		};
		(link as any).api = fakeApi;

		await link.sync();
		(link as any).retryDelay = 10;
		latestId = 25;
		streams[0]!.onError?.();

		// 1st drop (+10ms) -> reopen fail (+20ms) -> reopen fail (+40ms) -> fallback sync (after=25).
		await Bun.sleep(130);
		expect(subscribedAfters).toEqual([10, 10, 10, 25]);
		expect(link.online).toBe(true);
		link.stop();
	});

	test("does not reset retryDelay to 1000 on reopen onOpen before the stream stabilizes", async () => {
		const link = new ServerLink(
			{ id: "srv6", name: "Dev", baseUrl: "http://127.0.0.1:9999", token: "tok" },
			{ event: () => {}, ready: () => {} },
		);
		let first = true;
		const fakeApi: any = {
			scoped: () => fakeApi,
			health: async () => ({ ok: true, version: "0.10.4", protocol: 1, minClientProtocol: 1 }),
			listSessions: async () => ({ sessions: [], nextBefore: null, nextBeforeId: null }),
			workspace: async () => ({ root: "/w", home: "/h", workdirs: [] }),
			groups: async () => [],
			terminals: async () => [],
			terminalSupport: async () => null,
			activity: async () => ({ sessions: [], unread: [] }),
			models: async () => [],
			providers: async () => [],
			tools: async () => ({ tools: [], defaults: [] }),
			latestEventId: async () => 10,
			configuration: async () => null,
			compactionSettings: async () => null,
			systemModelSettings: async () => null,
			repos: async () => ({ repos: {} }),
			subscribe: (handlers: { onOpen?: () => void; onError?: () => void }) => {
				if (first) {
					first = false;
					queueMicrotask(() => handlers.onOpen?.());
				} else {
					// Reopen opens then drops immediately: retryDelay must stay backed off, not snap back to 1000.
					handlers.onOpen?.();
					handlers.onError?.();
				}
				return () => {};
			},
		};
		(link as any).api = fakeApi;

		await link.sync();
		(link as any).retryDelay = 2000;
		(link as any).reopen(false);
		expect((link as any).retryDelay).toBe(4000);
		link.stop();
	});

	test("probe detects a silently dead online link and kicks off resync once", async () => {
		let healthOk = true;
		let healthCalls = 0;
		let syncLists = 0;
		const link = new ServerLink(
			{ id: "srv7", name: "Dev", baseUrl: "http://127.0.0.1:9999", token: "tok" },
			{ event: () => {}, ready: () => {} },
		);
		const fakeApi: any = {
			scoped: () => fakeApi,
			health: async () => {
				healthCalls++;
				if (!healthOk) throw new Error("network down");
				return { ok: true, version: "0.10.4", protocol: 1, minClientProtocol: 1 };
			},
			listSessions: async () => {
				syncLists++;
				return { sessions: [], nextBefore: null, nextBeforeId: null };
			},
			workspace: async () => ({ root: "/w", home: "/h", workdirs: [] }),
			groups: async () => [],
			terminals: async () => [],
			terminalSupport: async () => null,
			activity: async () => ({ sessions: [], unread: [] }),
			models: async () => [],
			providers: async () => [],
			tools: async () => ({ tools: [], defaults: [] }),
			latestEventId: async () => 1,
			configuration: async () => null,
			compactionSettings: async () => null,
			systemModelSettings: async () => null,
			repos: async () => ({ repos: {} }),
			subscribe: (handlers: { onOpen?: () => void }) => {
				queueMicrotask(() => handlers.onOpen?.());
				return () => {};
			},
		};
		(link as any).api = fakeApi;

		await link.sync();
		expect(link.online).toBe(true);
		expect(syncLists).toBe(1);

		// Concurrent probes while dead coalesce to one probe health check, flip offline, and kick off one resync.
		healthOk = false;
		const before = healthCalls;
		await Promise.all([link.probe(), link.probe()]);
		expect(healthCalls).toBe(before + 2); // 1 from probe + 1 from the triggered sync()
		expect(link.net).toBe("offline");

		// Probing while already offline is a no-op.
		const afterOffline = healthCalls;
		await link.probe();
		expect(healthCalls).toBe(afterOffline);
		link.stop();
	});

	test("sync aborts pending snapshot requests when server requires a newer app", async () => {
		let scopedSignal: AbortSignal | undefined;
		const link = new ServerLink(
			{ id: "srv8", name: "Dev", baseUrl: "http://127.0.0.1:9999", token: "tok" },
			{ event: () => {}, ready: () => {} },
		);
		const fakeApi: any = {
			scoped: (s: AbortSignal) => {
				scopedSignal = s;
				return fakeApi;
			},
			health: async () => ({ ok: true, version: "9.0.0", protocol: 99, minClientProtocol: 99 }),
			listSessions: () => new Promise(() => {}),
			workspace: () => new Promise(() => {}),
			groups: () => new Promise(() => {}),
			terminals: () => new Promise(() => {}),
			terminalSupport: () => new Promise(() => {}),
			activity: () => new Promise(() => {}),
			models: () => new Promise(() => {}),
			providers: () => new Promise(() => {}),
			tools: () => new Promise(() => {}),
			latestEventId: () => new Promise(() => {}),
			configuration: () => new Promise(() => {}),
			subscribe: () => () => {},
		};
		(link as any).api = fakeApi;

		await link.sync();
		expect(link.net).toBe("incompatible");
		expect(scopedSignal?.aborted).toBe(true);
		link.stop();
	});
});
