import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Api } from "../src/lib/api";
import type { ChatState as ChatStateType } from "../src/lib/chat.svelte";
import type { PipayaEvent } from "../src/lib/types";

let ChatState: typeof ChatStateType;
let dir: string;
beforeAll(async () => {
	// Compile the real rune module with Svelte, rather than substituting fake $state globals.
	dir = await mkdtemp(join(tmpdir(), "pipaya-stream-retry-"));
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/chat.svelte.ts")], target: "bun",
		plugins: [{ name: "runes", setup(builder) {
			builder.onResolve({ filter: /\/src\/lib\/api\.ts$/ }, ({ path }) => ({ path, external: true }));
			builder.onLoad({ filter: /chat\.svelte\.ts$/ }, async ({ path }) => {
				const source = ts.transpileModule(await Bun.file(path).text(), {
					compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
				}).outputText;
				return { contents: compileModule(source.replace('from "./api"', `from ${JSON.stringify(resolve("src/lib/api.ts"))}`), { filename: path, generate: "client" }).js.code, loader: "js" };
			});
		} }],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "chat.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	ChatState = (await import(file)).ChatState;
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const setup = () => {
	const api = {
		messages: async () => [], tailMessages: async () => [], approvals: async () => [], questions: async () => [],
		getSession: async () => ({ status: { running: false, pendingToolCalls: [], streamingMessage: null, compacting: false }, context: { tokens: 10, contextWindow: 128000 }, usage: {} }),
	} as unknown as Api;
	return new ChatState("session", api);
};
const event = (type: string, data: unknown = {}): PipayaEvent => ({ id: 1, sessionId: "session", type, data, ts: Date.now() });
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now() });

/** What the client shows for a reply that streamed a bit and then died: the partial text, marked stopped. */
const streamThenFail = (chat: InstanceType<typeof ChatStateType>, text: string, seq: number) => {
	chat.apply(event("run_started", { mode: "prompt" }));
	chat.apply(event("message_start", { message: assistant("") }));
	chat.apply(event("message_update", { event: { type: "text_delta", contentIndex: 0, delta: text } }));
	chat.apply(event("message_end", { seq, message: assistant(text, "error") }));
};

describe("a reply cut off mid-stream", () => {
	test("is dropped from the transcript when the retried answer starts", () => {
		const chat = setup();
		streamThenFail(chat, "half an ans", 3);
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(1);
		expect(chat.retrying).toBeNull();

		chat.apply(event("run_retrying", { attempt: 1, maxRetries: 3, delayMs: 2000, restart: true }));
		expect(chat.retrying).toMatchObject({ attempt: 1, maxRetries: 3, delayMs: 2000, reason: "" });
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(0);

		// The retried answer replaces it under the same seq, so a reload shows it once.
		chat.apply(event("message_start", { message: assistant("") }));
		chat.apply(event("message_update", { event: { type: "text_delta", contentIndex: 0, delta: "the whole answer" } }));
		chat.apply(event("message_end", { seq: 3, message: assistant("the whole answer") }));
		const items = chat.items.filter((i) => i.kind === "assistant");
		expect(items).toHaveLength(1);
		expect(JSON.stringify(items[0])).not.toContain("half an ans");
		expect(JSON.stringify(items[0])).toContain("the whole answer");
	});

	test("a retry before anything streamed leaves the previous answer alone", () => {
		const chat = setup();
		chat.apply(event("message_end", { seq: 1, message: assistant("earlier answer") }));
		chat.apply(event("run_started", { mode: "prompt" }));
		chat.apply(event("run_retrying", { attempt: 1, maxRetries: 6, delayMs: 2000 }));
		expect(chat.retrying).toMatchObject({ attempt: 1, maxRetries: 6, delayMs: 2000, reason: "" });
		expect(JSON.stringify(chat.items)).toContain("earlier answer");
	});
});
