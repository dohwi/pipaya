import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Api } from "../src/lib/api";
import type { ChatState as ChatStateType } from "../src/lib/chat.svelte";

let ChatState: typeof ChatStateType;
let dir: string;
beforeAll(async () => {
	// The real rune module, compiled with Svelte (same approach as stream-retry.test.ts).
	dir = await mkdtemp(join(tmpdir(), "pipaya-wake-catchup-"));
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
});
