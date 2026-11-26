import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	aggregateTouchedFiles,
	effectiveContextTokens,
	formatTouchedFiles,
	pickCut,
	summaryBudgetChars,
	summaryMessage,
	summaryRequest,
} from "../src/compaction.ts";
import { DEFAULT_DELEGATE_POLICY, DelegatePolicy } from "../src/configuration.ts";
import { buildEnvContext, buildSystemPrompt } from "../src/context.ts";
import { openDb } from "../src/db.ts";
import { GoalManager, type GoalHost } from "../src/goals.ts";
import { buildMcpStdioEnv, formatMcpToolResult, MAX_MCP_IMAGE_RAW_BYTES, MAX_RESULT_CHARS, MAX_TOTAL_MCP_TOOLS, McpManager } from "../src/mcp.ts";
import Value from "typebox/value";
import { PeerService, type PeerHost } from "../src/peers.ts";
import { afterTurn, runawayReason, type RunGuardState } from "../src/run-guard.ts";
import { Scheduler, type SchedulerHost, type Timers } from "../src/scheduler.ts";
import { skillsPrompt } from "../src/skills.ts";
import { SessionStore } from "../src/store.ts";
import { retryDroppedMidStream } from "../src/stream-runner.ts";
import {
	capSubagentOutput,
	clearSubagentCache,
	loadSubagents,
	MAX_SUBAGENT_OUTPUT_CHARS,
	MAX_SUBAGENT_TURNS,
	removeSubagent,
	repeatedReadSignature,
	runDelegateWithinDeadline,
	saveSubagent,
	subagentTools,
} from "../src/subagents.ts";
import { completeWithUpstreamRetry, withUpstreamRetry } from "../src/upstream-retry.ts";

describe("1. MCP security & guardrails", () => {
	test("formatMcpToolResult appends [truncated] at most once across multiple text blocks", async () => {
		const big = "x".repeat(MAX_RESULT_CHARS - 10);
		const res = await formatMcpToolResult("srv", "tool", {
			content: [
				{ type: "text", text: big },
				{ type: "text", text: "y".repeat(500) },
				{ type: "text", text: "z".repeat(500) },
			],
		});
		const combined = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(combined.match(/\[truncated\]/g)).toHaveLength(1);
		expect(combined).not.toContain("z");
	});

	test("formatMcpToolResult guards >10MB images and unresizable images, and resizes valid ones", async () => {
		let resizerCalls = 0;
		const oversizedBase64 = "A".repeat(Math.ceil((MAX_MCP_IMAGE_RAW_BYTES + 1024) * 4 / 3));
		const tooBig = await formatMcpToolResult(
			"srv",
			"img",
			{ content: [{ type: "image", data: oversizedBase64, mimeType: "image/png" }] },
			undefined,
			async () => { resizerCalls++; return null; },
		);
		expect(resizerCalls).toBe(0);
		expect(tooBig.content[0]).toMatchObject({ type: "text" });
		expect((tooBig.content[0] as any).text).toContain("10 MB");

		const unresizable = await formatMcpToolResult(
			"srv",
			"img",
			{ content: [{ type: "image", data: Buffer.from("not-an-image").toString("base64"), mimeType: "image/png" }] },
			undefined,
			async () => null,
		);
		expect(unresizable.content[0]).toMatchObject({ type: "text" });
		expect((unresizable.content[0] as any).text).toContain("could not be decoded or resized");

		const resized = await formatMcpToolResult(
			"srv",
			"img",
			{ content: [{ type: "image", data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" }] },
			undefined,
			async () => ({ data: "cmVzaXplZA==", mimeType: "image/jpeg", width: 100, height: 100, originalWidth: 200, originalHeight: 200 }),
		);
		expect(resized.content).toEqual([{ type: "image", data: "cmVzaXplZA==", mimeType: "image/jpeg" }]);
	});

	test("McpManager enforces MAX_TOTAL_MCP_TOOLS = 128 in deterministic order, reports truncatedTools, and supports inheritEnv", () => {
		// inheritEnv: false (default) strips host tokens; inheritEnv: true keeps host env while STILL stripping PIPAYA_*
		const fakeEnv = { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_secret", PIPAYA_TOKEN: "tok", pipaya_secret: "tok2" };
		const filtered = buildMcpStdioEnv({ env: { CUSTOM: "1" } }, fakeEnv);
		expect(filtered.GITHUB_TOKEN).toBeUndefined();
		expect(filtered.PIPAYA_TOKEN).toBeUndefined();
		expect(filtered.CUSTOM).toBe("1");
		const inherited = buildMcpStdioEnv({ inheritEnv: true, env: { CUSTOM: "2" } }, fakeEnv);
		expect(inherited.GITHUB_TOKEN).toBe("ghp_secret");
		expect(inherited.PIPAYA_TOKEN).toBeUndefined();
		expect(inherited.pipaya_secret).toBeUndefined();
		expect(inherited.CUSTOM).toBe("2");

		const db = openDb(":memory:");
		try {
			const mgr = new McpManager(db);
			const makeTools = (prefix: string, count: number) =>
				Array.from({ length: count }, (_, i) => ({
					name: `mcp_${prefix}_t${i}`,
					tool: `t${i}`,
					description: `desc ${i}`,
					schema: { type: "object" },
				}));
			// Insert in reverse order (z before a): deterministic sorted/config order must still pick a first
			(mgr as any).conns.set("z_srv", { status: "ready", tools: makeTools("z_srv", 80), gen: 1 });
			(mgr as any).conns.set("a_srv", { status: "ready", tools: makeTools("a_srv", 80), gen: 2 });
			const defs = mgr.toolDefs();
			const names = Object.keys(defs);
			expect(names).toHaveLength(MAX_TOTAL_MCP_TOOLS);
			expect(MAX_TOTAL_MCP_TOOLS).toBe(128);
			expect(names[0]).toBe("mcp_a_srv_t0");
			expect(names.filter((n) => n.startsWith("mcp_a_srv_"))).toHaveLength(80);
			expect(names.filter((n) => n.startsWith("mcp_z_srv_"))).toHaveLength(48);

			// Save config rows so info() reports truncatedTools
			db.query("INSERT INTO settings (key, data) VALUES ('mcp_servers', $d)").run({
				d: JSON.stringify([
					{ name: "a_srv", enabled: true, transport: "http", url: "http://127.0.0.1:1" },
					{ name: "z_srv", enabled: true, transport: "http", url: "http://127.0.0.1:2" },
				]),
			});
			const info = mgr.info();
			expect(info.tools).toBe(128);
			expect(info.truncatedTools).toBe(32);
		} finally {
			db.close();
		}
	});

	test("deduplicates cross-server MCP tool name collisions without overwriting or skewing cap", () => {
		const db = openDb(":memory:");
		try {
			db.query("INSERT INTO settings (key, data) VALUES ('mcp_servers', $d)").run({
				d: JSON.stringify([
					{ name: "gh", enabled: true, transport: "http", url: "http://127.0.0.1:1" },
					{ name: "gh_a", enabled: true, transport: "http", url: "http://127.0.0.1:2" },
				]),
			});
			const mgr = new McpManager(db);
			// Both servers produce the same raw name `mcp_gh_a_b`
			(mgr as any).conns.set("gh", {
				status: "ready",
				tools: [{ name: "mcp_gh_a_b", tool: "a_b", description: "from gh", schema: { type: "object" } }],
				gen: 1,
			});
			(mgr as any).conns.set("gh_a", {
				status: "ready",
				tools: [{ name: "mcp_gh_a_b", tool: "b", description: "from gh_a", schema: { type: "object" } }],
				gen: 2,
			});
			const defs = mgr.toolDefs();
			expect(Object.keys(defs)).toEqual(["mcp_gh_a_b", "mcp_gh_a_b_2"]);
			expect(defs.mcp_gh_a_b?.description).toContain("[MCP: gh]");
			expect(defs.mcp_gh_a_b_2?.description).toContain("[MCP: gh_a]");
			const info = mgr.info();
			expect(info.tools).toBe(2);
			expect(info.servers[0]?.tools[0]?.name).toBe("mcp_gh_a_b");
			expect(info.servers[1]?.tools[0]?.name).toBe("mcp_gh_a_b_2");
		} finally {
			db.close();
		}
	});
});

describe("2. Compaction & context helpers", () => {
	const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 1 }) as any;
	const asst = (t: string, stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text: t }], timestamp: 2 }) as any;
	const result = (t: string) => ({ role: "toolResult", toolName: "read", content: [{ type: "text", text: t }], timestamp: 3 }) as any;

	test("pickCut with fallbackToAssistant cuts long single-prompt runs but keeps tiny histories uncut", () => {
		const tiny = [user("hi"), asst("hello")];
		expect(pickCut(tiny, 5000, false, true)).toBeNull();

		const longRun = [user("go"), asst("a".repeat(40_000)), result("r"), asst("b".repeat(40_000)), result("r")];
		expect(pickCut(longRun, 5000, false, false)).toBeNull();
		const cut = pickCut(longRun, 5000, false, true);
		expect(cut).toBe(3);

		const withErrorTail = [user("go"), asst("a".repeat(40_000), "error")];
		expect(pickCut(withErrorTail, 5000, false, true)).toBeNull();
	});

	test("summaryBudgetChars and summaryRequest scale dynamically with contextWindow", () => {
		expect(summaryBudgetChars()).toBe(400_000);
		expect(summaryBudgetChars(4_000)).toBe(24_000); // floor
		expect(summaryBudgetChars(32_000)).toBe(Math.floor(32_000 * 0.65 * 4));
		expect(summaryBudgetChars(1_000_000)).toBe(400_000); // ceiling

		const hugeMsg = user("x".repeat(2000));
		const many = Array.from({ length: 30 }, () => hugeMsg);
		const req = summaryRequest(null, many, undefined, undefined, 4_000);
		expect(req).toContain("[earlier part omitted]");
		expect(req.length).toBeLessThan(30_000);
	});

	test("aggregateTouchedFiles & formatTouchedFiles preserve deduplicated read and modified paths", () => {
		const msgs: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/b.ts" } },
					{ type: "toolCall", id: "c2", name: "read", arguments: { path: "src/a.ts" } },
					{ type: "toolCall", id: "c3", name: "edit", arguments: { path: "src/b.ts" } },
					{ type: "toolCall", id: "c4", name: "write", arguments: { path: "src/c.ts" } },
					{ type: "toolCall", id: "c5", name: "read", arguments: { path: "src/failed.ts" } },
				],
			} as any,
			{ role: "toolResult", toolName: "read", toolCallId: "c1", isError: false, details: { path: "src/b.ts" }, content: [] } as any,
			{ role: "toolResult", toolName: "read", toolCallId: "c5", isError: true, details: { path: "src/failed.ts" }, content: [] } as any,
		];
		expect(aggregateTouchedFiles(msgs)).toEqual({
			read: ["src/a.ts", "src/b.ts"],
			modified: ["src/b.ts", "src/c.ts"],
		});
		const formatted = formatTouchedFiles(msgs);
		expect(formatted).toContain("Modified: src/b.ts, src/c.ts");
		expect(formatted).toContain("Read: src/a.ts, src/b.ts");
		expect(formatted).not.toContain("failed.ts");

		const sm = summaryMessage("Summary text.", formatted);
		expect((sm.content as any)[0].text).toContain("Files touched before compaction:");
	});

	test("effectiveContextTokens falls back to estimateTokens when contextTokens returns null", () => {
		const msgs = [user("abcd".repeat(100))];
		expect(effectiveContextTokens(msgs, 400, 999)).toBe(200);
	});

	test("buildEnvContext returns static block and buildSystemPrompt includes it only when provided", () => {
		const env = buildEnvContext("/tmp/project", { platform: "linux", arch: "x64", shell: { kind: "bash", name: "bash", path: "/bin/bash" } });
		expect(env).toBe("Environment: home cwd=/tmp/project (active folder may change via workdir) | os=linux/x64 | shell=bash (/bin/bash)");
		expect(buildSystemPrompt("Base", [], [])).toBe("Base");
		expect(buildSystemPrompt("Base", [], [], env)).toBe(`Base\n\n${env}`);
	});
});

describe("3. Retry & stream runner: thinking_start -> empty-content error", () => {
	test("stream committing on thinking_start then failing with content: [] is retried by retryDroppedMidStream", async () => {
		const errMsg = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "503 Service Unavailable",
			timestamp: Date.now(),
		} as unknown as AssistantMessage;
		const okMsg = {
			role: "assistant",
			content: [{ type: "text", text: "recovered" }],
			stopReason: "stop",
			timestamp: Date.now(),
		} as unknown as AssistantMessage;

		let attempt = 0;
		const wrapped = withUpstreamRetry(
			(() => {
				attempt++;
				const s = createAssistantMessageEventStream();
				if (attempt === 1) {
					s.push({ type: "start", partial: errMsg });
					s.push({ type: "thinking_start", contentIndex: 0, partial: errMsg });
					s.push({ type: "error", reason: "error", error: errMsg });
					s.end(errMsg);
				} else {
					s.push({ type: "start", partial: okMsg });
					s.push({ type: "done", reason: "stop", message: okMsg });
					s.end(okMsg);
				}
				return s;
			}) as any,
			{ maxRetries: 2, baseDelayMs: 5, maxDelayMs: 20, sleep: async () => {} },
		);

		const messages: AgentMessage[] = [];
		const first = await (wrapped as any)({}, {}, {}).result();
		messages.push(first);
		// Committed on thinking_start, so withUpstreamRetry returned the empty error reply after 1 attempt.
		expect(attempt).toBe(1);
		expect(first.stopReason).toBe("error");
		expect(first.content).toEqual([]);

		// retryDroppedMidStream closes the gap by dropping the empty error reply and retrying cleanly with restart: true.
		const notices: { restart?: true }[] = [];
		const res = await retryDroppedMidStream({
			getLastMessage: () => messages[messages.length - 1],
			shouldStop: () => false,
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => { messages.pop(); },
			continueRun: async () => {
				const next = await (wrapped as any)({}, {}, {}).result();
				messages.push(next);
			},
			onRetry: (n) => notices.push(n),
			retryOpts: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 20 },
		});
		expect(res).toEqual({ attempts: 1, aborted: false, forceStopped: false, error: null });
		expect(notices[0]?.restart).toBe(true);
		expect(attempt).toBe(2);
		expect(messages).toHaveLength(1);
		expect((messages[0] as AssistantMessage).stopReason).toBe("stop");
	});

	test("stream throwing after thinking_start marks synthetic error as committed and retryDroppedMidStream retries with restart: true", async () => {
		const okMsg = {
			role: "assistant",
			content: [{ type: "text", text: "recovered-from-throw" }],
			stopReason: "stop",
			timestamp: Date.now(),
		} as unknown as AssistantMessage;

		let attempt = 0;
		const wrapped = withUpstreamRetry(
			(() => {
				attempt++;
				if (attempt === 1) {
					return (async function* () {
						yield { type: "start", partial: okMsg } as any;
						yield { type: "thinking_start", contentIndex: 0, partial: okMsg } as any;
						throw new Error("503 stream socket reset mid-thinking");
					})();
				}
				const s = createAssistantMessageEventStream();
				s.push({ type: "start", partial: okMsg });
				s.push({ type: "done", reason: "stop", message: okMsg });
				s.end(okMsg);
				return s;
			}) as any,
			{ maxRetries: 2, baseDelayMs: 5, maxDelayMs: 20, sleep: async () => {} },
		);

		const messages: AgentMessage[] = [];
		const first = await (wrapped as any)({}, {}, {}).result();
		messages.push(first);
		expect(attempt).toBe(1);
		expect(first.stopReason).toBe("error");
		expect(first.content).toEqual([]);

		const notices: { restart?: true }[] = [];
		const res = await retryDroppedMidStream({
			getLastMessage: () => messages[messages.length - 1],
			shouldStop: () => false,
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => { messages.pop(); },
			continueRun: async () => {
				messages.push(await (wrapped as any)({}, {}, {}).result());
			},
			onRetry: (n) => notices.push(n),
			retryOpts: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 20 },
		});
		expect(res).toEqual({ attempts: 1, aborted: false, forceStopped: false, error: null });
		expect(notices[0]?.restart).toBe(true);
		expect(attempt).toBe(2);
		expect((messages[0] as AssistantMessage).stopReason).toBe("stop");
	});

	test("completeWithUpstreamRetry retries thrown unknown error once, but never retries local programming errors", async () => {
		const ctx = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] } as unknown as Context;
		let calls = 0;
		const notices: number[] = [];
		const reply = await completeWithUpstreamRetry(
			async () => {
				if (++calls === 1) throw new Error("unexpected bespoke failure");
				return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 1 } as AssistantMessage;
			},
			ctx,
			{ maxRetries: 3, baseDelayMs: 5, maxDelayMs: 20, sleep: async () => {}, onUnknown: () => {} },
			undefined,
			(a) => notices.push(a),
		);
		expect(reply.stopReason).toBe("stop");
		expect(calls).toBe(2);
		expect(notices).toEqual([1]);

		for (const err of [new TypeError("bad type"), new RangeError("bad range"), new SyntaxError("bad json"), new ReferenceError("undef")]) {
			let progCalls = 0;
			await expect(
				completeWithUpstreamRetry(
					async () => { progCalls++; throw err; },
					ctx,
					{ maxRetries: 3, baseDelayMs: 5, maxDelayMs: 20, sleep: async () => {} },
				),
			).rejects.toThrow(err.message);
			expect(progCalls).toBe(1);
		}
	});
});

describe("4. Stronger doom-loop detection", () => {
	const limits = { maxTurns: 50, maxRepeated: 3 };
	const call = (name: string, args: unknown) => ({ type: "toolCall", name, arguments: args });
	const fresh: RunGuardState = { turns: 0, recentCalls: [] };

	test("detects 2-step alternating tool call cycle (A->B->A->B->A->B)", () => {
		let s = fresh;
		const seq = [call("read", { p: 1 }), call("grep", { q: 1 })];
		for (let i = 0; i < 5; i++) {
			s = afterTurn(s, [seq[i % 2]], limits);
			expect(runawayReason(s, limits)).toBeNull();
		}
		s = afterTurn(s, [seq[1]], limits);
		expect(runawayReason(s, limits)).toContain("2-step tool call cycle");
	});

	test("detects 3-step repeating tool call cycle (A->B->C x3)", () => {
		let s = fresh;
		const seq = [call("a", {}), call("b", {}), call("c", {})];
		for (let i = 0; i < 8; i++) {
			s = afterTurn(s, [seq[i % 3]], limits);
			expect(runawayReason(s, limits)).toBeNull();
		}
		s = afterTurn(s, [seq[2]], limits);
		expect(runawayReason(s, limits)).toContain("3-step tool call cycle");
	});

	test("stops after 5 consecutive identical failing tool errors and resets on non-error turn", () => {
		let s = fresh;
		for (let i = 0; i < 4; i++) {
			s = afterTurn(s, [call("bash", { i })], limits, "bash:ENOENT");
			expect(runawayReason(s, limits)).toBeNull();
		}
		// Non-error turn resets streak
		s = afterTurn(s, [call("bash", { i: 99 })], limits);
		expect(runawayReason(s, limits)).toBeNull();

		for (let i = 0; i < 4; i++) {
			s = afterTurn(s, [call("bash", { i })], limits, "bash:EACCES");
			expect(runawayReason(s, limits)).toBeNull();
		}
		s = afterTurn(s, [call("bash", { i: 5 })], limits, "bash:EACCES");
		expect(runawayReason(s, limits)).toContain("same tool error repeated 5 times");
	});
});

describe("5. Goals: origin preservation and consecutive limit abort guard", () => {
	test("store.activeRuns preserves origin 'goal'", () => {
		const db = openDb(":memory:");
		try {
			const store = new SessionStore(db);
			store.create({
				id: "s1", name: "a", cwd: "/tmp", title: "T", provider: "p", model: "m",
				thinkingLevel: "off", systemPrompt: "", tools: [], purpose: "", parentId: null, closed: false, createdAt: 1, updatedAt: 1,
			});
			store.markRunActive("s1", { origin: "goal", startedAt: 123 });
			expect(store.activeRuns()[0]?.origin).toBe("goal");
		} finally {
			db.close();
		}
	});

	test("GoalManager marks goal blocked after 3 consecutive turn-limit aborts and resets on normal turn", () => {
		const db = openDb(":memory:");
		try {
			const store = new SessionStore(db);
			store.create({
				id: "s1", name: "a", cwd: "/tmp", title: "T", provider: "p", model: "m",
				thinkingLevel: "off", systemPrompt: "", tools: [], purpose: "", parentId: null, closed: false, createdAt: 1, updatedAt: 1,
			});
			const host: GoalHost = {
				session: (id) => (id === "s1" ? { id, closed: false } : undefined),
				isRunning: () => false,
				tokens: () => 0,
				send: async () => ({}),
			};
			const goals = new GoalManager(db, host, {
				timers: { set: () => 1 as any, clear: () => {} },
			});
			goals.put("s1", { objective: "finish work" });

			// 1st and 2nd turn-limit aborts stay active
			for (let i = 0; i < 2; i++) {
				goals.onRunStarted("s1");
				goals.onRunFinished("s1", { status: "aborted", cause: "limit", error: "Stopped after 200 model calls in one run.", origin: "goal" });
				expect(goals.get("s1")!.status).toBe("active");
			}
			// A normal turn resets the counter
			goals.onRunStarted("s1");
			goals.onMessageEnd("s1", { role: "assistant", textLength: 10 });
			goals.onRunFinished("s1", { status: "ok", origin: "goal" });
			expect(goals.get("s1")!.status).toBe("active");

			// 3 consecutive turn-limit aborts mark blocked
			for (let i = 0; i < 2; i++) {
				goals.onRunStarted("s1");
				goals.onRunFinished("s1", { status: "aborted", cause: "limit", error: "Stopped after 200 model calls in one run.", origin: "goal" });
				expect(goals.get("s1")!.status).toBe("active");
			}
			goals.onRunStarted("s1");
			goals.onRunFinished("s1", { status: "aborted", cause: "limit", error: "Stopped after 200 model calls in one run.", origin: "goal" });
			expect(goals.get("s1")!.status).toBe("blocked");
			goals.stop();
		} finally {
			db.close();
		}
	});
});

describe("6. Subagent fixes", () => {
	test("FORBIDDEN excludes goal, workdir, generate_image; DelegatePolicy preserves stored maxTurns 31..50", () => {
		expect(subagentTools(["read", "bash", "goal", "workdir", "generate_image", "delegate", "peer", "schedule"])).toEqual(["read", "bash"]);
		expect((DelegatePolicy.properties.maxTurns as { maximum?: number }).maximum).toBe(50);
		expect(DEFAULT_DELEGATE_POLICY.maxTurns).toBe(MAX_SUBAGENT_TURNS);
		expect(Value.Check(DelegatePolicy, { ...DEFAULT_DELEGATE_POLICY, maxTurns: 50 })).toBe(true);
		expect(Value.Check(DelegatePolicy, { ...DEFAULT_DELEGATE_POLICY, maxTurns: 35 })).toBe(true);
		expect(Value.Check(DelegatePolicy, { ...DEFAULT_DELEGATE_POLICY, maxTurns: 51 })).toBe(false);
	});

	test("repeatedReadSignature detects repeated bash calls and multi-tool batches", () => {
		const readOnly = new Set(["read", "grep", "ls"]);
		const bashTurn = {
			message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
			toolResults: [{ isError: false, content: [{ type: "text", text: "a\nb" }] }],
		} as any;
		expect(repeatedReadSignature(bashTurn, readOnly)).toBeTruthy();

		const batchTurn = {
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", name: "grep", arguments: { pattern: "foo" } },
				],
			},
			toolResults: [
				{ isError: false, content: [{ type: "text", text: "file a" }] },
				{ isError: false, content: [{ type: "text", text: "match" }] },
			],
		} as any;
		expect(repeatedReadSignature(batchTurn, readOnly)).toBeTruthy();

		const writeTurn = {
			message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "write", arguments: { path: "a.ts" } }] },
			toolResults: [{ isError: false, content: [{ type: "text", text: "ok" }] }],
		} as any;
		expect(repeatedReadSignature(writeTurn, readOnly)).toBeUndefined();
	});

	test("loadSubagents caches by mtime/size and invalidates on save/remove", () => {
		const root = mkdtempSync(join(tmpdir(), "pipaya-subcache-"));
		const home = join(root, "home");
		const cwd = join(root, "cwd");
		mkdirSync(home, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		try {
			clearSubagentCache();
			saveSubagent("global", cwd, home, "alpha", { description: "v1", tools: ["read"], maxTurns: 5, prompt: "p1" }, true);
			const m1 = loadSubagents(cwd, home);
			expect(m1.get("alpha")?.description).toBe("v1");
			// Cached hit returns equivalent definition
			const m2 = loadSubagents(cwd, home);
			expect(m2.get("alpha")).toBe(m1.get("alpha"));
			// saveSubagent invalidates cache
			saveSubagent("global", cwd, home, "alpha", { description: "v2", tools: ["read"], maxTurns: 5, prompt: "p2" }, false);
			expect(loadSubagents(cwd, home).get("alpha")?.description).toBe("v2");
			// Direct disk edit also invalidates via size/mtime fingerprint
			writeFileSync(join(home, ".agents", "subagents", "alpha.md"), "---\ndescription: v3-disk\ntools: [read]\nmaxTurns: 5\n---\np3\n");
			expect(loadSubagents(cwd, home).get("alpha")?.description).toBe("v3-disk");
			// removeSubagent invalidates cache
			removeSubagent("global", cwd, home, "alpha");
			expect(loadSubagents(cwd, home).has("alpha")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("runDelegateWithinDeadline calls onDetach on grace timeout and capSubagentOutput caps long text", async () => {
		let detached = 0;
		const never = new Promise<void>(() => {});
		const outcome = await runDelegateWithinDeadline(() => never, () => {}, undefined, 10, 10, () => { detached++; });
		expect(outcome).toBe("deadline");
		expect(detached).toBe(1);

		expect(capSubagentOutput("short")).toBe("short");
		const huge = "x".repeat(MAX_SUBAGENT_OUTPUT_CHARS + 50);
		const capped = capSubagentOutput(huge);
		expect(capped).toContain("50 characters omitted");
		expect(capped.startsWith("x".repeat(100))).toBe(true);
	});
});

describe("7. Peer fixes", () => {
	test("prunes reported on question_resolved, supports null answers, and serializes concurrent creates", async () => {
		const db = openDb(":memory:");
		try {
			const store = new SessionStore(db);
			store.create({ id: "s1", name: "하나", cwd: "/tmp", title: "T", provider: "p", model: "m", thinkingLevel: "off", systemPrompt: "", tools: [], purpose: "", parentId: null, closed: false, createdAt: 1, updatedAt: 1 });
			store.create({ id: "s2", name: "둘", cwd: "/tmp", title: "T", provider: "p", model: "m", thinkingLevel: "off", systemPrompt: "", tools: [], purpose: "", parentId: null, closed: false, createdAt: 1, updatedAt: 1 });
			store.watch("s2", "s1");

			let onQ!: (id: string, q: any) => void;
			let onQRes!: (id: string, tcId: string) => void;
			const delivered: string[] = [];
			const receivedAnswers: any[] = [];
			let activeCreates = 0;
			let maxConcurrentCreates = 0;
			let seq = 0;

			const host: PeerHost = {
				store,
				groups: () => [],
				isRunning: () => false,
				deliver: async (_id, text) => { delivered.push(text); },
				rename: () => {},
				abort: () => false,
				onRunFinished: () => {},
				onQuestion: (fn) => { onQ = fn; },
				onQuestionResolved: (fn) => { onQRes = fn; },
				questions: () => [{ sessionId: "s2", toolCallId: "q1", question: "Pick?", allowFreeText: true, requestedAt: 1 }],
				answer: (_id, _tcId, a) => { receivedAnswers.push(a); return "ok"; },
				create: async () => {
					activeCreates++;
					maxConcurrentCreates = Math.max(maxConcurrentCreates, activeCreates);
					await Bun.sleep(15);
					activeCreates--;
					const id = `c${++seq}`;
					const rec = { id, name: `생성${seq}`, cwd: "/tmp", title: "T", provider: "p", model: "m", thinkingLevel: "off" as const, systemPrompt: "", tools: [], purpose: "", parentId: "s1", closed: false, createdAt: 1, updatedAt: 1 };
					store.create(rec);
					return rec;
				},
				update: () => {},
				remove: () => {},
				cancelQueued: () => false,
				queued: () => [],
				groupOps: { create: () => "", add: () => "", remove: () => "", dissolve: () => "" },
			};
			const peers = new PeerService(host);

			// Question reported -> resolved -> pruned -> can be reported again if same id recurs
			onQ("s2", { sessionId: "s2", toolCallId: "q1", question: "Pick?", allowFreeText: true, requestedAt: 1 });
			expect(delivered).toHaveLength(1);
			onQ("s2", { sessionId: "s2", toolCallId: "q1", question: "Pick?", allowFreeText: true, requestedAt: 1 });
			expect(delivered).toHaveLength(1); // deduped while unresolved
			onQRes("s2", "q1");
			onQ("s2", { sessionId: "s2", toolCallId: "q1", question: "Pick?", allowFreeText: true, requestedAt: 1 });
			expect(delivered).toHaveLength(2); // pruned on resolve!

			// null answer passthrough ("leave to agent")
			const ansMsg = peers.answer("s1", "둘", { answer: null });
			expect(ansMsg).toContain("Answered @둘");
			expect(receivedAnswers[0]).toEqual({ answer: null, answers: undefined });

			// Concurrent creates for the SAME selfId are serialized; DIFFERENT selfIds run concurrently without blocking each other
			await Promise.all([
				peers.create("s1", { message: "task 1" }),
				peers.create("s1", { message: "task 2" }),
			]);
			expect(maxConcurrentCreates).toBe(1);

			maxConcurrentCreates = 0;
			await Promise.all([
				peers.create("s1", { message: "task a" }),
				peers.create("s2", { message: "task b" }),
			]);
			expect(maxConcurrentCreates).toBe(2);
		} finally {
			db.close();
		}
	});
});

describe("8. Scheduler optional bounded busy-retry & mutex", () => {
	test("retries a busy one-time task up to maxBusyRetries and runs once idle", async () => {
		const db = openDb(":memory:");
		try {
			const store = new SessionStore(db);
			store.create({ id: "s1", name: "a", cwd: "/tmp", title: "T", provider: "p", model: "m", thinkingLevel: "off", systemPrompt: "", tools: [], purpose: "", parentId: null, closed: false, createdAt: 1, updatedAt: 1 });
			let now = 1_000_000;
			let busy = true;
			const sent: string[] = [];
			const timers: Timers = { set: () => 1, clear: () => {} };
			const host: SchedulerHost = {
				session: (id) => (id === "s1" ? { closed: false } : undefined),
				isRunning: () => busy,
				send: async (_id, input) => { sent.push(input.text); },
			};
			const scheduler = new Scheduler(db, host, { now: () => now, timers, retryBusyOnceMs: 10_000, maxBusyRetries: 2 });
			const t = scheduler.create({ sessionId: "s1", kind: "once", runAt: now + 5_000, prompt: "ping" });

			// Due while busy -> retry 1
			now += 5_000;
			await scheduler.tick();
			expect(sent).toEqual([]);
			expect(scheduler.get(t.id)).toMatchObject({ enabled: true, lastStatus: "skipped_busy", nextRunAt: now + 10_000 });

			// Still busy -> retry 2
			now += 10_000;
			await scheduler.tick();
			expect(sent).toEqual([]);
			expect(scheduler.get(t.id)).toMatchObject({ enabled: true, lastStatus: "skipped_busy", nextRunAt: now + 10_000 });

			// Becomes idle -> runs and finishes
			busy = false;
			now += 10_000;
			await scheduler.tick();
			expect(sent).toEqual(["ping"]);
			expect(scheduler.get(t.id)).toMatchObject({ enabled: false, lastStatus: "ok" });

			// Exhausting maxBusyRetries finishes the task
			busy = true;
			const t2 = scheduler.create({ sessionId: "s1", kind: "once", runAt: now + 5_000, prompt: "ping2" });
			now += 5_000;
			await scheduler.tick(); // retry 1
			now += 10_000;
			await scheduler.tick(); // retry 2
			now += 10_000;
			await scheduler.tick(); // exhausted -> finished
			expect(scheduler.get(t2.id)).toMatchObject({ enabled: false, lastStatus: "skipped_busy" });
		} finally {
			db.close();
		}
	});
});

describe("9. Skills XML escaping", () => {
	test("skillsPrompt XML-escapes name and description, leaving filesystem path unescaped", () => {
		const out = skillsPrompt([
			{
				name: "a&b<c>",
				description: "Do </available_skills> & <inject>",
				path: "/tmp/R&D/a&b/SKILL.md",
				baseDir: "/tmp/R&D/a&b",
				scope: "global",
			},
		]);
		expect(out).toContain("- a&amp;b&lt;c&gt;: Do &lt;/available_skills&gt; &amp; &lt;inject&gt; (/tmp/R&D/a&b/SKILL.md)");
		expect(out.match(/<\/available_skills>/g)).toHaveLength(1);
	});
});
