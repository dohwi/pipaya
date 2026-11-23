import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Api } from "../src/lib/api";
import type { ChatState as ChatStateType } from "../src/lib/chat.svelte";
import { setLang } from "../src/lib/i18n";

let ChatState: typeof ChatStateType;
let formatRunError: (error: string | undefined | null) => string;
let dir: string;
beforeAll(async () => {
	// The real rune module, compiled with Svelte (same approach as stream-retry.test.ts).
	dir = await mkdtemp(join(tmpdir(), "pipaya-wake-catchup-"));
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/chat.svelte.ts")], target: "bun",
		plugins: [{ name: "runes", setup(builder) {
			builder.onResolve({ filter: /\/src\/lib\/(api|i18n)\.ts$/ }, ({ path }) => ({ path, external: true }));
			builder.onLoad({ filter: /chat\.svelte\.ts$/ }, async ({ path }) => {
				const source = ts.transpileModule(await Bun.file(path).text(), {
					compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
				}).outputText;
				const linked = source
					.replace('from "./api"', `from ${JSON.stringify(resolve("src/lib/api.ts"))}`)
					.replace('from "./i18n"', `from ${JSON.stringify(resolve("src/lib/i18n.ts"))}`);
				return { contents: compileModule(linked, { filename: path, generate: "client" }).js.code, loader: "js" };
			});
		} }],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "chat.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	const mod = await import(file);
	ChatState = mod.ChatState;
	formatRunError = mod.formatRunError;
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const assistant = (text: string, stopReason = "pending") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now() });

/**
 * A chat whose server says what `status()` returns. `running`/`streamingMessage` are what a wake reads back, because the
 * events that would have carried them (`run_started`, `run_finished`, `message_update`) are live-only.
 */
const setup = (status: () => Record<string, unknown>) => {
	const api = {
		tailMessages: async () => [], questions: async () => [], serverExtensionEntries: async () => [],
		getSession: async () => ({ status: status(), context: { tokens: 10, contextWindow: 128000 }, usage: {} }),
	} as unknown as Api;
	const chat = new ChatState("session", api);
	return chat;
};
const base = { running: false, compacting: false, pendingToolCalls: [], pendingQuestions: 0, queuedMessages: [], streamingMessage: null };

describe("catching up after the window was in the background", () => {
	test("a run that started while away turns the working state on", async () => {
		let running = false;
		const chat = setup(() => ({ ...base, running }));
		await chat.load();
		expect(chat.running).toBe(false);

		// The window was away: run_started was live-only and never arrived.
		running = true;
		await chat.catchUp();
		expect(chat.running).toBe(true);
	});

	test("a run that ended while away stops the working state and settles the bubble", async () => {
		let running = true;
		const chat = setup(() => ({ ...base, running, streamingMessage: assistant("half an ans") }));
		await chat.load();
		expect(chat.running).toBe(true);

		running = false;
		await chat.catchUp();
		expect(chat.running).toBe(false);
		expect(chat.items.filter((i) => i.kind === "assistant" && i.streaming)).toHaveLength(0);
	});

	test("a reply that streamed while away takes the text the server has", async () => {
		let partial = "first words";
		const chat = setup(() => ({ ...base, running: true, streamingMessage: assistant(partial) }));
		await chat.load();
		const before = chat.items.find((i) => i.kind === "assistant");
		expect(JSON.stringify(before)).toContain("first words");

		// message_update is live-only: the bubble sat at the text it had when the window went away.
		partial = "first words and everything written while the window was in the background";
		await chat.catchUp();
		const items = chat.items.filter((i) => i.kind === "assistant");
		expect(items).toHaveLength(1); // the same bubble, not a second one
		expect(JSON.stringify(items[0])).toContain("in the background");
	});

	test("a reply that began while away is put in place once", async () => {
		let streaming: unknown = null;
		const chat = setup(() => ({ ...base, running: true, streamingMessage: streaming }));
		await chat.load();
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(0);

		streaming = assistant("written while away");
		await chat.catchUp();
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(1);
		// A second wake with nothing new must not add another.
		await chat.catchUp();
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(1);
	});

	test("nothing changes when the server agrees with what is on screen", async () => {
		const chat = setup(() => ({ ...base, running: true, streamingMessage: assistant("same") }));
		await chat.load();
		const items = chat.items;
		const blocks = JSON.stringify(chat.items);
		await chat.catchUp();
		expect(chat.items).toBe(items); // the array itself: no re-render of the transcript
		expect(JSON.stringify(chat.items)).toBe(blocks);
	});

	test("a run interrupted by a server restart pulls the persisted error reply on catchUp without duplicating on replay", async () => {
		let running = true;
		const storedAfter = [
			{ seq: 1, role: "toolResult", createdAt: 10, message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "Tool execution was interrupted because the server stopped unexpectedly." }], isError: true, timestamp: 10 } },
			{ seq: 2, role: "assistant", createdAt: 11, message: { role: "assistant", content: [], stopReason: "error", errorMessage: "The run was interrupted because the server stopped unexpectedly.", timestamp: 11 } },
		];
		const api = {
			tailMessages: async () => [
				{ seq: 0, role: "assistant", createdAt: 5, message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "sleep 10" } }], stopReason: "toolUse", timestamp: 5 } },
			],
			questions: async () => [],
			serverExtensionEntries: async () => [],
			getSession: async () => ({ status: { ...base, running, pendingToolCalls: running ? ["tc1"] : [] }, context: { tokens: 10, contextWindow: 128000 }, usage: {} }),
			messagesAfter: async (_id: string, after: number) => storedAfter.filter((m) => m.seq > after),
		} as unknown as Api;
		const chat = new ChatState("session", api);
		await chat.load();
		expect(chat.running).toBe(true);
		expect(chat.tools.tc1?.state).toBe("running");

		// Server rebooted and finalized the interrupted run.
		running = false;
		await chat.catchUp();
		expect(chat.running).toBe(false);
		expect(chat.tools.tc1?.state).toBe("error");
		const assistants = chat.items.filter((i) => i.kind === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[1]).toMatchObject({
			seq: 2,
			stopReason: "error",
			error: "The run was interrupted because the server stopped unexpectedly.",
		});

		// Late SSE replay of the same message_end must not create a duplicate item.
		chat.apply({ id: 5, sessionId: "session", type: "message_end", ts: 11, data: { seq: 2, message: storedAfter[1]!.message } });
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(2);
	});

	test("an unsettled streaming bubble settled by catchUp is replaced (not duplicated) when message_end arrives", async () => {
		let running = true;
		const chat = setup(() => ({ ...base, running, streamingMessage: running ? assistant("partial") : null }));
		await chat.load();
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(1);

		// catchUp runs just before the SSE replay of message_end arrives.
		running = false;
		await chat.catchUp();
		chat.apply({
			id: 9,
			sessionId: "session",
			type: "message_end",
			ts: Date.now(),
			data: {
				seq: 1,
				message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "The run was interrupted because the server shut down.", timestamp: Date.now() },
			},
		});
		const assistants = chat.items.filter((i) => i.kind === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]).toMatchObject({
			seq: 1,
			streaming: false,
			stopReason: "error",
			error: "The run was interrupted because the server shut down.",
		});
	});

	test("formatRunError localizes server shutdown / crash messages and preserves provider errors", () => {
		setLang("ko");
		expect(formatRunError("The run was interrupted because the server shut down.")).toBe("서버가 종료되어 작업이 중단되었습니다.");
		expect(formatRunError("The run was interrupted because the server stopped unexpectedly.")).toBe("서버가 예기치 않게 멈춰 작업이 중단되었습니다.");
		expect(formatRunError("429 Too Many Requests")).toBe("429 Too Many Requests");
		setLang("en");
		expect(formatRunError("The run was interrupted because the server shut down.")).toBe("The run was interrupted because the server shut down.");
		setLang("ko");
	});

	test("onStatus reports load and catchUp status changes once buffers are applied", async () => {
		let running = true;
		const seen: { kind: string; running: boolean }[] = [];
		const api = {
			tailMessages: async () => [],
			questions: async () => [],
			serverExtensionEntries: async () => [],
			getSession: async () => ({ status: { ...base, running, pendingToolCalls: [] }, context: { tokens: 10, contextWindow: 128000 }, usage: {} }),
		} as unknown as Api;
		const chat = new ChatState("session", api, (c, kind) => seen.push({ kind, running: c.running }));
		await chat.load();
		expect(seen).toEqual([{ kind: "load", running: true }]);

		running = false;
		await chat.catchUp();
		expect(seen).toEqual([
			{ kind: "load", running: true },
			{ kind: "catchUp", running: false },
		]);
	});

	test("message_end with stripped toolResult keeps live preview images from tool_execution_end", async () => {
		const api = {
			tailMessages: async () => [],
			questions: async () => [],
			serverExtensionEntries: async () => [],
			getSession: async () => ({ status: { ...base, running: true, pendingToolCalls: [] }, context: { tokens: 10, contextWindow: 128000 }, usage: {} }),
		} as unknown as Api;
		const chat = new ChatState("session", api);
		await chat.load();
		chat.apply({
			id: 1,
			sessionId: "session",
			type: "tool_execution_end",
			ts: 100,
			data: {
				toolCallId: "tc1",
				toolName: "generate_image",
				isError: false,
				durationMs: 500,
				result: { content: [{ type: "text", text: "Saved a.png" }, { type: "image", data: "IMGDATA", mimeType: "image/png" }], details: { paths: ["a.png"] } },
			},
		});
		expect(chat.tools.tc1?.images).toEqual([{ type: "image", data: "IMGDATA", mimeType: "image/png" }]);

		chat.apply({
			id: 2,
			sessionId: "session",
			type: "message_end",
			ts: 101,
			data: {
				seq: 1,
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "generate_image",
					content: [{ type: "text", text: "Saved a.png" }],
					details: { paths: ["a.png"] },
					isError: false,
					timestamp: 101,
				},
			},
		});
		expect(chat.tools.tc1?.images).toEqual([{ type: "image", data: "IMGDATA", mimeType: "image/png" }]);
	});

	test("catchUp does not clobber newer live deltas or resurrect a run that finished while getSession was in flight", async () => {
		let resolveSession!: (v: unknown) => void;
		let initial = true;
		const api = {
			tailMessages: async () => [],
			questions: async () => [],
			serverExtensionEntries: async () => [],
			getSession: () => {
				if (initial) {
					initial = false;
					return Promise.resolve({ status: { ...base, running: true, streamingMessage: assistant("hello") }, context: { tokens: 10, contextWindow: 128000 }, usage: {} });
				}
				return new Promise((resolve) => { resolveSession = resolve; });
			},
		} as unknown as Api;
		const chat = new ChatState("session", api);
		await chat.load();

		const pending = chat.catchUp();
		// Live SSE deltas arrive while getSession() is still slow on the network.
		chat.apply({ id: 0, sessionId: "session", type: "message_update", ts: 10, data: { event: { type: "text_delta", contentIndex: 0, delta: " live world" } } });
		// Now the stale getSession() snapshot resolves with older text.
		resolveSession({ status: { ...base, running: true, streamingMessage: assistant("hello stale") }, context: { tokens: 10, contextWindow: 128000 }, usage: {} });
		await pending;
		expect(JSON.stringify(chat.items)).toContain("hello live world");
		expect(JSON.stringify(chat.items)).not.toContain("stale");

		// Next catchUp starts while running; run_finished arrives before getSession() resolves with running: true.
		const pending2 = chat.catchUp();
		chat.apply({ id: 0, sessionId: "session", type: "run_finished", ts: 20, data: { status: "done" } });
		expect(chat.running).toBe(false);
		resolveSession({ status: { ...base, running: true, streamingMessage: assistant("stale partial") }, context: { tokens: 10, contextWindow: 128000 }, usage: {} });
		await pending2;
		expect(chat.running).toBe(false);
	});

	test("replayed message_start followed by already-loaded message_end removes the empty ghost bubble", async () => {
		const api = {
			tailMessages: async () => [
				{ seq: 5, role: "assistant", createdAt: 10, message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 10 } },
			],
			questions: async () => [],
			serverExtensionEntries: async () => [],
			getSession: async () => ({ status: { ...base, running: false }, context: { tokens: 10, contextWindow: 128000 }, usage: {} }),
		} as unknown as Api;
		const chat = new ChatState("session", api);
		await chat.load();
		expect(chat.items).toHaveLength(1);

		// Replay arrives for seq 5 which was already loaded by tailMessages.
		chat.apply({ id: 10, sessionId: "session", type: "message_start", ts: 10, data: { message: { role: "assistant", content: [] } } });
		chat.apply({ id: 11, sessionId: "session", type: "message_end", ts: 10, data: { seq: 5, message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 10 } } });
		expect(chat.items).toHaveLength(1);
		expect(chat.streaming).toBe(false);
	});
});
