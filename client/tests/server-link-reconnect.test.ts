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
});
