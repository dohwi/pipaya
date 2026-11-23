import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Api } from "../src/lib/api";
import type { ChatState as ChatStateType } from "../src/lib/chat.svelte";
import type { PipayaEvent, UserItem } from "../src/lib/types";

describe("skill hints on user messages", () => {
	let ChatState: typeof ChatStateType;
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "pipaya-skill-hints-"));
		const build = await Bun.build({
			entrypoints: [resolve("src/lib/chat.svelte.ts")],
			target: "bun",
			plugins: [
				{
					name: "runes",
					setup(builder) {
						builder.onResolve({ filter: /\/src\/lib\/api\.ts$/ }, ({ path }) => ({ path, external: true }));
						builder.onLoad({ filter: /chat\.svelte\.ts$/ }, async ({ path }) => {
							const source = ts.transpileModule(await Bun.file(path).text(), {
								compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
							}).outputText;
							return {
								contents: compileModule(source.replace('from "./api"', `from ${JSON.stringify(resolve("src/lib/api.ts"))}`), {
									filename: path,
									generate: "client",
								}).js.code,
								loader: "js",
							};
						});
					},
				},
			],
		});
		if (!build.success) throw new Error(build.logs.join("\n"));
		const file = join(dir, "chat.mjs");
		await writeFile(file, await build.outputs[0]!.text());
		ChatState = (await import(file)).ChatState;
	});

	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	const api = {
		messages: async () => [],
		tailMessages: async () => [],
		approvals: async () => [],
		questions: async () => [],
		getSession: async () => ({
			status: { running: false, pendingToolCalls: [], streamingMessage: null, compacting: false },
			context: { tokens: 1000, contextWindow: 128000 },
			compaction: { supported: true, autoEnabled: true },
			usage: {},
		}),
	};

	const msg = (seq: number, content: unknown): PipayaEvent => ({
		id: seq,
		sessionId: "s",
		type: "message_end",
		data: { seq, message: { role: "user", content, timestamp: 1 } },
		ts: 1,
	});
	const users = (chat: InstanceType<typeof ChatStateType>) => chat.items.filter((x): x is UserItem => x.kind === "user");

	test("extracts invoked skills from <pipaya-hint> blocks, ignores non-skill hints, and hides all hint text", () => {
		const chat = new ChatState("s", api as unknown as Api);
		chat.apply(
			msg(0, [
				{ type: "text", text: "/skill:review로 봐 줘 /skill:my-skill" },
				{ type: "text", text: '<pipaya-hint>The user mentioned other sessions (agents) on this server:\n- @peer</pipaya-hint>' },
				{ type: "text", text: '<pipaya-hint>The user explicitly invoked the skill "review" (written as /skill:review). Follow it.</pipaya-hint>' },
				{ type: "text", text: '<pipaya-hint>The user explicitly invoked the skill "my-skill" (written as /skill:my-skill). Follow it.</pipaya-hint>' },
				{ type: "text", text: '<pipaya-hint>The user explicitly invoked the skill "review" (written as /skill:review). Follow it.</pipaya-hint>' },
			]),
		);
		chat.apply(msg(1, [{ type: "text", text: "plain message" }]));
		const [withSkills, plain] = users(chat);
		expect(withSkills!.text).toBe("/skill:review로 봐 줘 /skill:my-skill");
		expect([...(withSkills!.skills ?? [])]).toEqual(["review", "my-skill"]);
		expect(plain!.text).toBe("plain message");
		expect(plain!.skills).toBeUndefined();
	});

	test("attaches confirmed skills onto an optimistic user message when the server echoes it", () => {
		const chat = new ChatState("s", api as unknown as Api);
		chat.addOptimisticUser("/skill:review로 봐 줘", []);
		expect(users(chat)[0]!.skills).toBeUndefined();
		chat.apply(
			msg(0, [
				{ type: "text", text: "/skill:review로 봐 줘" },
				{ type: "text", text: '<pipaya-hint>The user explicitly invoked the skill "review" (written as /skill:review). Follow it.</pipaya-hint>' },
			]),
		);
		const confirmed = users(chat)[0]!;
		expect(confirmed.seq).toBe(0);
		expect(confirmed.text).toBe("/skill:review로 봐 줘");
		expect([...(confirmed.skills ?? [])]).toEqual(["review"]);
	});
});
