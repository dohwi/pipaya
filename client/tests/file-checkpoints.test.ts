import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type * as ChatModule from "../src/lib/chat.svelte";
import type { Api } from "../src/lib/api";

let ChatState: typeof ChatModule.ChatState;
let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pipaya-chat-ckpt-"));
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/chat.svelte.ts")],
		target: "bun",
		plugins: [
			{
				name: "runes",
				setup(builder) {
					builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
						const source = ts.transpileModule(await Bun.file(path).text(), {
							compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
						}).outputText;
						return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
					});
				},
			},
		],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "chat.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	({ ChatState } = await import(file));
});

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe("ChatState file checkpoints & rewind", () => {
	test("loadCheckpoints indexes turns by turnSeq and session_rewound truncates transcript", async () => {
		let checkpointCalls = 0;
		const turnsByCall = [
			[
				{ turnSeq: 0, fileCount: 1, createdAt: 1000, files: [{ relPath: "a.ts", action: "restore" as const, skippedReason: null }] },
				{ turnSeq: 2, fileCount: 1, createdAt: 2000, files: [{ relPath: "b.ts", action: "delete" as const, skippedReason: null }] },
			],
			[
				{ turnSeq: 0, fileCount: 1, createdAt: 1000, files: [{ relPath: "a.ts", action: "restore" as const, skippedReason: null }] },
			],
		];

		const fakeApi = {
			sessionCheckpoints: async () => ({ turns: turnsByCall[Math.min(checkpointCalls++, turnsByCall.length - 1)]! }),
		} as unknown as Api;

		const chat = new ChatState("sess-1", fakeApi);
		chat.items = [
			{ kind: "user", key: "u0", seq: 0, text: "first", images: [], ts: 1000 },
			{ kind: "assistant", key: "a1", seq: 1, blocks: [{ type: "text", text: "ok1" }], ts: 1001 },
			{ kind: "user", key: "u2", seq: 2, text: "second", images: [], ts: 2000 },
			{ kind: "assistant", key: "a3", seq: 3, blocks: [{ type: "text", text: "ok2" }], ts: 2001 },
		];
		chat.lastSeq = 3;

		await chat.loadCheckpoints();
		expect(Object.keys(chat.checkpoints).map(Number).sort()).toEqual([0, 2]);
		expect(chat.checkpoints[2]?.files[0]?.relPath).toBe("b.ts");

		// Apply session_rewound event with truncatedFromSeq = 2
		chat.apply({
			id: 1,
			sessionId: "sess-1",
			type: "session_rewound",
			ts: 3000,
			data: { turnSeq: 2, mode: "files_and_chat", restored: [], deleted: ["b.ts"], truncatedFromSeq: 2 },
		});

		// Transcript trimmed to seq < 2
		expect(chat.items.map((i) => (i.kind === "user" || i.kind === "assistant" ? i.seq : null))).toEqual([0, 1]);
		expect(chat.lastSeq).toBe(1);

		// Wait a microtask for loadCheckpoints triggered by session_rewound
		await new Promise((r) => setTimeout(r, 10));
		expect(Object.keys(chat.checkpoints).map(Number)).toEqual([0]);
	});
});
