import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Api } from "../src/lib/api";
import type { ChatState as ChatStateType } from "../src/lib/chat.svelte";
import { applyRestoredMessages, mergeReturned } from "../src/lib/composer-text";
import type { PipayaEvent } from "../src/lib/types";

let ChatState: typeof ChatStateType;
let dir: string;
beforeAll(async () => {
	// Compile the real rune module with Svelte (as compaction.test.ts does).
	dir = await mkdtemp(join(tmpdir(), "pipaya-queue-stop-"));
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/chat.svelte.ts")], target: "bun",
		plugins: [{ name: "runes", setup(builder) {
			builder.onResolve({ filter: /\/src\/lib\/api\.ts$/ }, ({ path }) => ({ path, external: true }));
			builder.onLoad({ filter: /chat\.svelte\.ts$/ }, async ({ path }) => {
				const source = ts.transpileModule(await Bun.file(path).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
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

let seq = 0;
const event = (type: string, data: unknown = {}): PipayaEvent => ({ id: ++seq, sessionId: "s", type, data, ts: Date.now() });
const chat = () => new ChatState("s", {} as unknown as Api);
const img = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

describe("a stop hands queued messages back", () => {
	test("own messages dropped by a stop come back with their pictures; a peer's does not", () => {
		const c = chat();
		c.apply(event("run_started", { mode: "prompt" }));
		c.mine.push({ text: "mine", images: [img], files: [] });
		c.apply(event("message_queued", { mode: "follow_up", text: "mine" }));
		c.apply(event("message_queued", { mode: "steer", text: "from a peer" }));
		c.apply(event("message_dequeued", { mode: "steer", text: "from a peer", reason: "stopped" }));
		c.apply(event("message_dequeued", { mode: "follow_up", text: "mine", reason: "stopped" }));
		expect(c.restored).toEqual([]); // handed back together once the run has ended
		c.apply(event("run_finished", { status: "aborted", error: null, durationMs: 1, usage: {} }));
		expect(c.queued).toEqual([]);
		expect(c.restored.map((m) => [m.text, m.images.length])).toEqual([["mine", 1]]);
		expect(c.stopped).toBe(true);
		c.apply(event("run_started", { mode: "prompt" }));
		expect(c.stopped).toBe(false);
	});

	test("a cancel by hand does not hand it back twice (the input is refilled there)", () => {
		const c = chat();
		c.mine.push({ text: "x", images: [], files: [] });
		c.apply(event("message_queued", { mode: "follow_up", text: "x" }));
		c.apply(event("message_dequeued", { mode: "follow_up", text: "x" }));
		expect(c.restored).toEqual([]);
		expect(c.mine).toEqual([]);
	});

	test("a send still in flight is only marked: its caller keeps the text", () => {
		const c = chat();
		const own = { text: "late", images: [], files: [], pending: true };
		c.mine.push(own);
		c.apply(event("message_queued", { mode: "steer", text: "late" }));
		c.apply(event("message_dequeued", { mode: "steer", text: "late", reason: "stopped" }));
		expect(c.restored).toEqual([]);
		expect(own).toMatchObject({ returned: true });
	});

	test("a delivered message is forgotten, so a later stop cannot hand it back", () => {
		const c = chat();
		c.mine.push({ text: "go", images: [], files: [] });
		c.apply(event("message_queued", { mode: "steer", text: "go" }));
		c.apply(event("message_end", { seq: 5, message: { role: "user", content: [{ type: "text", text: "go" }, { type: "text", text: "<pipaya-hint>x</pipaya-hint>" }] } }));
		expect(c.mine).toEqual([]);
		expect(c.queued).toEqual([]);
	});

	test("a cancelled compaction gives back what waited for it instead of sending it", () => {
		const c = chat();
		c.apply(event("compaction_started", { reason: "manual" }));
		c.held.push({ text: "after compact", images: [], files: [] });
		c.apply(event("compaction_failed", { aborted: true }));
		expect(c.held).toEqual([]);
		expect(c.restored.map((m) => m.text)).toEqual(["after compact"]);
	});

	test("a failed (not cancelled) compaction keeps them for sending", () => {
		const c = chat();
		c.apply(event("compaction_started", { reason: "manual" }));
		c.held.push({ text: "after compact", images: [], files: [] });
		c.apply(event("compaction_failed", { aborted: false, errorMessage: "boom" }));
		expect(c.held.map((m) => m.text)).toEqual(["after compact"]);
		expect(c.restored).toEqual([]);
	});
});

test("several dropped by one stop come back at once, in the order they were written", () => {
	const c = chat();
	c.apply(event("run_started", { mode: "prompt" }));
	c.mine.push({ text: "first", images: [], files: [], at: 1 }, { text: "second", images: [], files: [], at: 2 });
	c.apply(event("message_queued", { mode: "follow_up", text: "first" }));
	c.apply(event("message_queued", { mode: "steer", text: "second" }));
	// The server drops steers before follow-ups.
	c.apply(event("message_dequeued", { mode: "steer", text: "second", reason: "stopped" }));
	c.apply(event("message_dequeued", { mode: "follow_up", text: "first", reason: "stopped" }));
	c.apply(event("run_finished", { status: "aborted", error: null, durationMs: 1, usage: {} }));
	expect(c.restored.map((m) => m.text)).toEqual(["first", "second"]);
});

test("a stop with no run going (a queued /compact after it) hands back at once", () => {
	const c = chat();
	c.mine.push({ text: "after", images: [], files: [] });
	c.apply(event("message_queued", { mode: "follow_up", text: "after", deferred: true }));
	c.apply(event("message_dequeued", { mode: "follow_up", text: "after", deferred: true, reason: "stopped" }));
	expect(c.restored.map((m) => m.text)).toEqual(["after"]);
});

describe("mergeReturned", () => {
	test("goes before what is typed now; empty input takes it as is", () => {
		expect(mergeReturned("", 0, { text: "back", images: 0 })).toBe("back");
		expect(mergeReturned("new", 0, { text: "back\n", images: 0 })).toBe("back\nnew");
	});
	test("renumbers its own #imageN after the pictures already attached", () => {
		expect(mergeReturned("see #image1", 1, { text: "look #image1 and #image2", images: 2 })).toBe("look #image2 and #image3\nsee #image1");
	});
});

describe("early abort prompt recall", () => {
	const file = { name: "notes.txt", data: "aGVsbG8=", size: 5, mimeType: "text/plain" };

	test("rolls back user + thinking-only assistant and restores text, attachments, and reply", () => {
		const c = chat();
		// Prior completed turn (seq 0, 1) must remain untouched.
		c.apply(event("message_end", { seq: 0, message: { role: "user", content: [{ type: "text", text: "old" }] } }));
		c.apply(event("message_end", { seq: 1, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] } }));

		c.addOptimisticUser("> prev\n\nnew prompt", [img], [{ path: "", name: file.name, size: file.size, mimeType: file.mimeType }]);
		c.activePrompt = {
			text: "> prev\n\nnew prompt",
			images: [img],
			files: [file],
			at: 10,
			reply: { text: "prev", who: "N1" },
			replyBody: "new prompt",
		};
		c.apply(event("run_started", { mode: "prompt", origin: "user" }));
		c.apply(event("message_end", { seq: 2, message: { role: "user", content: [{ type: "text", text: "> prev\n\nnew prompt" }] } }));
		c.apply(event("message_start", { message: { role: "assistant" } }));
		c.apply(event("message_update", { event: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } }));
		c.apply(event("message_end", { seq: 3, message: { role: "assistant", stopReason: "aborted", content: [{ type: "thinking", thinking: "hmm" }] } }));
		c.apply(event("run_finished", { status: "aborted", error: null, durationMs: 1, origin: "user", cause: "user", usage: {}, recalledPrompt: { text: "> prev\n\nnew prompt", fromSeq: 2 } }));

		expect(c.items.map((x) => (x.kind === "user" || x.kind === "assistant" ? [x.kind, x.seq] : [x.kind, null]))).toEqual([
			["user", 0],
			["assistant", 1],
		]);
		expect(c.restored).toHaveLength(1);
		expect(JSON.parse(JSON.stringify(c.restored[0]))).toMatchObject({
			text: "> prev\n\nnew prompt",
			images: [img],
			files: [file],
			reply: { text: "prev", who: "N1" },
			replyBody: "new prompt",
		});

		// Subsequent message reusing seq 2 is accepted (lastSeq was rolled back to 1).
		c.apply(event("message_end", { seq: 2, message: { role: "user", content: [{ type: "text", text: "resent" }] } }));
		expect(c.items).toHaveLength(3);
		expect(c.items[2]).toMatchObject({ kind: "user", seq: 2 });
	});

	test("handles abort before message_end (fromSeq: null) by dropping optimistic user bubble", () => {
		const c = chat();
		c.addOptimisticUser("early", [], []);
		c.activePrompt = { text: "early", images: [], files: [], at: 1 };
		c.apply(event("run_started", { mode: "prompt", origin: "user" }));
		c.apply(event("run_finished", { status: "aborted", error: null, durationMs: 1, origin: "user", cause: "user", usage: {}, recalledPrompt: { text: "early", fromSeq: null } }));

		expect(c.items).toEqual([]);
		expect(c.restored.map((m) => m.text)).toEqual(["early"]);
	});

	test("marks pending activePrompt as returned instead of double-restoring", () => {
		const c = chat();
		const own = { text: "in-flight", images: [], files: [], at: 1, pending: true };
		c.activePrompt = own;
		c.apply(event("run_started", { mode: "prompt", origin: "user" }));
		c.apply(event("run_finished", { status: "aborted", error: null, durationMs: 1, origin: "user", cause: "user", usage: {}, recalledPrompt: { text: "in-flight", fromSeq: 0 } }));

		expect(own.returned).toBe(true);
		expect(c.restored).toEqual([]);
	});

	test("orders recalled prompt before simultaneously dropped steer/follow_up messages", () => {
		const c = chat();
		c.activePrompt = { text: "initial", images: [], files: [], at: 10 };
		c.apply(event("run_started", { mode: "prompt", origin: "user" }));
		c.apply(event("message_end", { seq: 0, message: { role: "user", content: [{ type: "text", text: "initial" }] } }));
		c.mine.push({ text: "steer-msg", images: [], files: [], at: 20 }, { text: "follow-msg", images: [], files: [], at: 30 });
		c.apply(event("message_queued", { mode: "steer", text: "steer-msg" }));
		c.apply(event("message_queued", { mode: "follow_up", text: "follow-msg" }));
		c.apply(event("message_dequeued", { mode: "steer", text: "steer-msg", reason: "stopped" }));
		c.apply(event("message_dequeued", { mode: "follow_up", text: "follow-msg", reason: "stopped" }));
		c.apply(event("run_finished", { status: "aborted", error: null, durationMs: 1, origin: "user", cause: "user", usage: {}, recalledPrompt: { text: "initial", fromSeq: 0 } }));

		expect(c.items).toEqual([]);
		expect(c.restored.map((m) => m.text)).toEqual(["initial", "steer-msg", "follow-msg"]);
	});

	test("other clients roll back transcript without polluting composer; reloaded tab that clicked abort still recovers text", () => {
		const observer = chat();
		observer.apply(event("run_started", { mode: "prompt", origin: "user" }));
		observer.apply(event("message_end", { seq: 0, message: { role: "user", content: [{ type: "text", text: "other device" }] } }));
		observer.apply(event("run_finished", { status: "aborted", error: null, durationMs: 1, origin: "user", cause: "user", usage: {}, recalledPrompt: { text: "other device", fromSeq: 0 } }));
		expect(observer.items).toEqual([]);
		expect(observer.restored).toEqual([]);

		const reloaded = chat();
		reloaded.apply(event("run_started", { mode: "prompt", origin: "user" }));
		reloaded.apply(event("message_end", { seq: 0, message: { role: "user", content: [{ type: "text", text: "after reload" }] } }));
		reloaded.abortRequested = true;
		reloaded.apply(event("run_finished", { status: "aborted", error: null, durationMs: 1, origin: "user", cause: "user", usage: {}, recalledPrompt: { text: "after reload", fromSeq: 0 } }));
		expect(reloaded.items).toEqual([]);
		expect(reloaded.restored.map((m) => m.text)).toEqual(["after reload"]);
	});
});

describe("applyRestoredMessages", () => {
	test("restores text and reply badge cleanly when composer is empty", () => {
		const res = applyRestoredMessages("", 0, null, [
			{ text: "> Alice: hi\n\nmy answer", images: 0, reply: { text: "hi", who: "Alice" }, replyBody: "my answer" },
		]);
		expect(res).toEqual({ text: "my answer", reply: { text: "hi", who: "Alice" } });
	});

	test("preserves existing draft text and existing reply without overwriting", () => {
		const existingReply = { text: "other", who: "Bob" };
		const res = applyRestoredMessages("drafting #image1", 1, existingReply, [
			{ text: "> Alice: hi\n\nrecalled #image1", images: 1, reply: { text: "hi", who: "Alice" }, replyBody: "recalled #image1" },
		]);
		expect(res.reply).toEqual(existingReply);
		expect(res.text).toBe("> Alice: hi\n\nrecalled #image2\ndrafting #image1");
	});
});
