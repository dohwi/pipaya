import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import { attachTouchedFiles } from "../src/compaction.ts";
import {
	createContextPruneState,
	DEFAULT_PRUNE_BATCH_MIN_BYTES,
	DEFAULT_PRUNE_IDLE_MS,
	pruneOldToolResults,
	resetContextPruneState,
} from "../src/context-pruning.ts";
import { GOAL_NOTE } from "../src/session-helpers.ts";
import { DelegateLimits, MAX_SUBAGENT_OUTPUT_CHARS, loadSubagents, runDelegateWithinDeadline } from "../src/subagents.ts";
import { buildTools } from "../src/tools.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

interface ScriptedReply {
	text?: string;
	toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
	usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
	delayMs?: number;
}

/** Local OpenAI-compatible SSE upstream driven by a per-request handler for deterministic multi-turn harness evals. */
function startScriptedUpstream(handler: (req: any, index: number) => ScriptedReply | Promise<ScriptedReply>) {
	const requests: any[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const body = (await req.json()) as any;
			const idx = requests.length;
			requests.push(body);
			const reply = await handler(body, idx);
			if (reply.delayMs) {
				await new Promise((r) => setTimeout(r, reply.delayMs));
			}
			const usage = {
				prompt_tokens: reply.usage?.prompt_tokens ?? 100,
				completion_tokens: reply.usage?.completion_tokens ?? 20,
				total_tokens: (reply.usage?.prompt_tokens ?? 100) + (reply.usage?.completion_tokens ?? 20),
				...(reply.usage?.cached_tokens !== undefined
					? { prompt_tokens_details: { cached_tokens: reply.usage.cached_tokens } }
					: {}),
			};
			if (!body.stream) {
				return Response.json({
					id: `chatcmpl-${idx}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: body.model,
					choices: [{ index: 0, message: { role: "assistant", content: reply.text ?? "Summary text." }, finish_reason: "stop" }],
					usage,
				});
			}
			const frames: string[] = [];
			const push = (delta: Record<string, unknown>, finish_reason: string | null = null, withUsage = false) => {
				frames.push(
					`data: ${JSON.stringify({
						id: `chatcmpl-${idx}`,
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: body.model,
						choices: [{ index: 0, delta, finish_reason }],
						...(withUsage ? { usage } : {}),
					})}\n\n`,
				);
			};
			if (reply.toolCalls?.length) {
				reply.toolCalls.forEach((tc, i) => {
					push({
						role: i === 0 ? "assistant" : undefined,
						tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } }],
					});
				});
				push({}, "tool_calls", true);
			} else {
				push({ role: "assistant", content: reply.text ?? "Done." });
				push({}, "stop", true);
			}
			frames.push("data: [DONE]\n\n");
			return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		requests,
		stop: () => server.stop(true),
	};
}

function makeToolResult(id: string, text: string, details?: Record<string, unknown>, timestamp = Date.now()): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp,
	} as AgentMessage;
}

function makeAssistantTurn(id: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }],
		api: "openai-completions",
		provider: "echo",
		model: ECHO_MODEL.id,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as AgentMessage;
}

describe("rare batched cache-safe tool-result pruning", () => {
	test("preserves recent turns, keeps prefix byte-identical between batch passes, preserves spill paths, and resets on compaction", () => {
		const state = createContextPruneState();
		const buildTranscript = (turnCount: number, payloadSize: number, withSpill = false): AgentMessage[] => {
			const msgs: AgentMessage[] = [{ role: "user", content: "start", timestamp: 1 }];
			for (let i = 1; i <= turnCount; i++) {
				const id = `call-${i}`;
				msgs.push(makeAssistantTurn(id));
				const spillPath = `/data/tmp/spill/s1/bash-${i}.txt`;
				const body = withSpill && i === 1
					? `${"x".repeat(payloadSize)}\n[output truncated: 500 lines, 100 KB (102400 bytes); full output saved to ${spillPath} — use read/grep to inspect]`
					: "a".repeat(payloadSize);
				msgs.push(makeToolResult(id, body, withSpill && i === 1 ? { spillPath } : undefined, i * 1000));
			}
			return msgs;
		};

		// 1) Fewer than keepRecentTurns (6): nothing prunable
		const small = buildTranscript(6, 5_000);
		const r0 = pruneOldToolResults(small, { contextWindow: 100_000, state, now: 1_000 });
		expect(r0.triggered).toBe(false);
		expect(r0.prunedIds).toEqual([]);
		expect(r0.messages).toBe(small);

		// 2) 8 turns (2 old turns of 5,000 bytes = 10,000 bytes < 80,000 threshold): does NOT trigger (cache prefix untouched)
		const belowBatch = buildTranscript(8, 5_000, true);
		const r1 = pruneOldToolResults(belowBatch, { contextWindow: 100_000, state, now: 2_000 });
		expect(r1.triggered).toBe(false);
		expect(state.clearedToolCallIds.size).toBe(0);
		expect(r1.messages).toBe(belowBatch);

		// 3) 8 turns with 45,000 bytes each (2 old turns = 90,000 bytes >= 80,000): triggers batch pass!
		const aboveBatch = buildTranscript(8, 45_000, true);
		const r2 = pruneOldToolResults(aboveBatch, { contextWindow: 100_000, state, now: 3_000 });
		expect(r2.triggered).toBe(true);
		expect(r2.prunedIds).toEqual(["call-1@1000", "call-2@2000"]);
		expect(r2.clearedBytes).toBeGreaterThan(DEFAULT_PRUNE_BATCH_MIN_BYTES);
		const cleared1 = (r2.messages[2] as any).content[0].text as string;
		const cleared2 = (r2.messages[4] as any).content[0].text as string;
		// Spill path preserved on call-1
		expect(cleared1).toContain("earlier tool result cleared");
		expect(cleared1).toContain("full output saved to /data/tmp/spill/s1/bash-1.txt");
		expect(cleared2).toContain("earlier tool result cleared (45000 chars); re-read/re-run if needed");
		// Recent turns (call-3 .. call-8) are untouched
		expect(((r2.messages[6] as any).content[0].text as string).length).toBe(45_000);

		// 4) Next turn adds 1 more old turn (call-3 = 45,000 < 80,000): does NOT trigger new pass,
		//    only previously recorded call-1 & call-2 are replaced so prefix stays byte-identical!
		const nextTurn = buildTranscript(9, 45_000, true);
		const r3 = pruneOldToolResults(nextTurn, { contextWindow: 100_000, state, now: 4_000 });
		expect(r3.triggered).toBe(false);
		expect(r3.prunedIds).toEqual([]);
		expect((r3.messages[2] as any).content[0].text).toBe(cleared1);
		expect((r3.messages[4] as any).content[0].text).toBe(cleared2);
		// call-3 is NOT cleared yet because threshold wasn't crossed
		expect(((r3.messages[6] as any).content[0].text as string).length).toBe(45_000);

		// 5) Idle >= 5 minutes with >= 24 KiB newly prunable triggers pass
		const r4 = pruneOldToolResults(nextTurn, { contextWindow: 100_000, state, now: 4_000 + DEFAULT_PRUNE_IDLE_MS });
		expect(r4.triggered).toBe(true);
		expect(r4.prunedIds).toEqual(["call-3@3000"]);
		expect((r4.messages[6] as any).content[0].text).toContain("earlier tool result cleared");

		// 6) Reset on compaction clears recorded IDs
		resetContextPruneState(state);
		expect(state.clearedToolCallIds.size).toBe(0);
		expect(state.lastModelCallAt).toBe(0);
	});

	test("duplicate toolCallId (call_0 across 8 turns) never clears the latest protected toolResult; cold-start triggers 24 KiB idle pass", () => {
		const state = createContextPruneState();
		const msgs: AgentMessage[] = [{ role: "user", content: "start", timestamp: 1 }];
		for (let i = 1; i <= 8; i++) {
			msgs.push(makeAssistantTurn("call_0"));
			// Every turn reuses the exact same provider toolCallId "call_0" (and even identical timestamp 0 on turns 1 & 8!)
			const ts = i === 1 || i === 8 ? 0 : i * 1000;
			msgs.push(makeToolResult("call_0", `turn-${i}-` + "z".repeat(15_000), undefined, ts));
		}
		// Cold-start (lastModelCallAt === 0) with 2 old turns = 30,000 bytes >= 24 KiB triggers immediately!
		const res = pruneOldToolResults(msgs, { contextWindow: 100_000, state, now: 50_000 });
		expect(res.triggered).toBe(true);
		expect(res.prunedIds).toHaveLength(2);
		// Old turns 1 & 2 ARE cleared
		expect((res.messages[2] as any).content[0].text).toContain("earlier tool result cleared");
		expect((res.messages[4] as any).content[0].text).toContain("earlier tool result cleared");
		// Latest turn 8 (even with identical toolCallId "call_0" AND identical timestamp 0!) is NEVER cleared
		const latestText = (res.messages[16] as any).content[0].text as string;
		expect(latestText.startsWith("turn-8-")).toBe(true);
		expect(latestText.length).toBeGreaterThan(15_000);
	});

	test("attachTouchedFiles merges prior summaries, strips duplicated blocks, and caps at 50 per category; delegate omits peer hint when peer is disabled", () => {
		const msgs: AgentMessage[] = [];
		for (let i = 0; i < 55; i++) {
			msgs.push(makeToolResult(`r-${i}`, "ok", { path: `file-${String(i).padStart(2, "0")}.ts` }, i + 1));
		}
		const prev = "Earlier summary.\n\nFiles touched before compaction:\n- Modified: old-mod.ts\n- Read: aaa-old-read.ts";
		const llmEchoed = "New summary.\n\nFiles touched before compaction:\n- Modified: old-mod.ts\n- Read: aaa-old-read.ts";
		const merged = attachTouchedFiles(llmEchoed, msgs, prev);
		// Header appears exactly once (echoed duplicate stripped)
		expect(merged.split("Files touched before compaction:").length).toBe(2);
		expect(merged).toContain("- Modified: old-mod.ts");
		expect(merged).toContain("aaa-old-read.ts");
		expect(merged).toContain("(and 6 more)");

		const delNoPeer = buildTools(["delegate"], tmpdir(), [], {
			delegateModels: () => ({ policy: "any", models: [] }),
			peerEnabled: () => false,
		})[0]!;
		expect((delNoPeer.parameters as any).properties.model.description).not.toContain('peer(action="list_models")');
	});
});

describe("end-to-end harness evaluation suite", () => {
	let root: string;
	let ws: string;
	let home: string;
	let echoUpstream: ReturnType<typeof startEchoUpstream>;
	let app: App;

	const api = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) => {
		const res = await app.server.inject({
			method,
			url,
			payload,
			headers: { authorization: "Bearer eval-token" },
		});
		return { status: res.statusCode, json: res.body ? res.json() : undefined };
	};

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pipaya-harness-eval-"));
		ws = join(root, "ws");
		home = join(root, "home");
		mkdirSync(ws, { recursive: true });
		mkdirSync(join(home, ".agents", "subagents"), { recursive: true });
		echoUpstream = startEchoUpstream();
		app = await buildApp(
			{ host: "0.0.0.0", port: 0, dataDir: root, dbPath: join(root, "eval.db"), token: "eval-token", workspaceRoot: ws, logLevel: "silent" },
			{ strictResponses: true, extensionDirs: [], home, delegateTimeoutMs: 400 },
		);
		expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(echoUpstream.baseUrl))).status).toBe(200);
		expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
	});

	afterAll(async () => {
		await app.close();
		echoUpstream.stop();
		rmSync(root, { recursive: true, force: true });
	});

	test("goal cache-prefix stability: entire message prefix stays byte-identical across multi-turn goal runs", async () => {
		let turn = 0;
		const goalUpstream = startScriptedUpstream(() => {
			turn++;
			if (turn === 1) return { toolCalls: [{ id: "gt-1", name: "ls", args: { path: "." } }] };
			if (turn === 2) return { toolCalls: [{ id: "gt-2", name: "ls", args: { path: "." } }] };
			return { text: "Goal turn finished." };
		});
		try {
			expect((await api("PUT", "/configuration/providers/goal-cache", echoProviderBody(goalUpstream.baseUrl, "GoalCache"))).status).toBe(200);
			const id = (await api("POST", "/sessions", { cwd: ws, provider: "goal-cache", model: ECHO_MODEL.id, systemPrompt: "Stable base" })).json.id as string;
			expect((await api("PUT", `/sessions/${id}/goal`, { objective: "Finish eval" })).status).toBe(200);

			expect((await api("POST", `/sessions/${id}/messages`, { text: "multi-turn goal work" })).status).toBe(202);
			await app.sessions.idle();

			expect(goalUpstream.requests.length).toBeGreaterThanOrEqual(3);
			const [req0, req1, req2] = goalUpstream.requests;
			const sys0 = req0.messages[0].content as string;
			const sys1 = req1.messages[0].content as string;
			const sys2 = req2.messages[0].content as string;
			// System prompt is byte-identical and includes updated static Environment context, NOT live goal counters
			expect(sys0).toBe(sys1);
			expect(sys1).toBe(sys2);
			expect(sys0).toContain(`Environment: home cwd=${ws} (active folder may change via workdir)`);
			expect(sys0).not.toContain("Finish eval");
			expect(sys0).not.toContain("Active goal");

			// ENTIRE message prefix is byte-identical across tool turns (goal note anchored on opening user message, never moving!)
			expect(JSON.stringify(req1.messages.slice(0, req0.messages.length))).toBe(JSON.stringify(req0.messages));
			expect(JSON.stringify(req2.messages.slice(0, req1.messages.length))).toBe(JSON.stringify(req1.messages));

			// Opening user message carries the ephemeral goal status note; toolResult messages do NOT
			const openUser = req1.messages.find((m: any) => m.role === "user");
			const openUserText = typeof openUser.content === "string" ? openUser.content : openUser.content.map((c: any) => c.text ?? "").join("");
			expect(openUserText).toContain("Finish eval");
			const toolMsgs = req2.messages.filter((m: any) => m.role === "tool");
			expect(toolMsgs.length).toBeGreaterThanOrEqual(2);
			for (const tm of toolMsgs) {
				expect(JSON.stringify(tm.content)).not.toContain("Finish eval");
			}

			// Stored transcript does NOT have the ephemeral goal note baked into it
			const stored = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
			const firstUser = stored.find((m) => m.message?.role === "user");
			expect(JSON.stringify(firstUser)).not.toContain("Active goal");
			expect((await api("DELETE", `/sessions/${id}`)).status).toBe(204);
		} finally {
			goalUpstream.stop();
		}
	});

	test("same-turn workdir move via getCwd and readTracker staleness survival across turns", async () => {
		const repo = join(ws, "repo-same-turn");
		const wt = join(ws, "repo-same-turn-wt");
		mkdirSync(repo, { recursive: true });
		execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "eval@example.com"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Eval"], { cwd: repo, stdio: "ignore" });
		writeFileSync(join(repo, "marker.txt"), "from-main\n");
		execFileSync("git", ["add", "marker.txt"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["worktree", "add", "-b", "wt-branch", wt], { cwd: repo, stdio: "ignore" });
		writeFileSync(join(wt, "marker.txt"), "from-worktree\n");

		let step = 0;
		const scripted = startScriptedUpstream(() => {
			step++;
			if (step === 1) {
				// Single assistant turn: move workdir, then read marker.txt in the SAME turn!
				// Note: pi-agent-core runs tools in parallel unless sequential, so we use two turns or
				// test workdir move + read in turn 1 -> turn 2 without rebuilding tools AND direct same-turn sequential
				return { toolCalls: [{ id: "tc-move", name: "workdir", args: { action: "move", path: wt } }] };
			}
			if (step === 2) {
				return { toolCalls: [{ id: "tc-read", name: "read", args: { path: "marker.txt" } }] };
			}
			if (step === 3) {
				return { text: "Read complete." };
			}
			if (step === 4) {
				return { toolCalls: [{ id: "tc-edit", name: "edit", args: { path: "marker.txt", oldText: "from-worktree", newText: "updated" } }] };
			}
			return { text: "Edit attempted." };
		});

		try {
			expect((await api("PUT", "/configuration/providers/wt-eval", echoProviderBody(scripted.baseUrl, "WT"))).status).toBe(200);
			const id = (await api("POST", "/sessions", { cwd: repo, provider: "wt-eval", model: ECHO_MODEL.id })).json.id as string;
			expect((await api("POST", `/sessions/${id}/messages`, { text: "move and read" })).status).toBe(202);
			await app.sessions.idle();

			// Verify read saw the worktree file, not main!
			const msgs1 = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
			const readRes = msgs1.find((m) => m.message?.role === "toolResult" && m.message?.toolName === "read");
			expect(readRes?.message?.content?.[0]?.text).toContain("from-worktree");

			// Modify marker.txt externally on disk (changing mtime + size), then try editing in a new turn:
			// readTracker persisted across turns and catches the external modification!
			await new Promise((r) => setTimeout(r, 20));
			writeFileSync(join(wt, "marker.txt"), "from-worktree-modified-externally\n");
			expect((await api("POST", `/sessions/${id}/messages`, { text: "now edit" })).status).toBe(202);
			await app.sessions.idle();

			const msgs2 = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
			const editRes = msgs2.find((m) => m.message?.role === "toolResult" && m.message?.toolName === "edit");
			expect(editRes?.message?.isError).toBe(true);
			expect(editRes?.message?.content?.[0]?.text).toMatch(/modified since|changed since|stale|re-read/i);
		} finally {
			scripted.stop();
		}
	});

	test("production spillDir writes oversized bash output and cleans up on session delete", async () => {
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		const cmd = `node -e 'process.stdout.write("A".repeat(80000) + "\\n")'`;
		expect((await api("POST", `/sessions/${id}/messages`, { text: `!bash ${cmd}` })).status).toBe(202);
		await app.sessions.idle();

		const spillSessionDir = join(root, "tmp", "spill", id);
		expect(existsSync(spillSessionDir)).toBe(true);
		const files = readdirSync(spillSessionDir);
		expect(files.length).toBeGreaterThanOrEqual(1);

		// Deleting the session removes its spill directory
		expect((await api("DELETE", `/sessions/${id}`)).status).toBe(204);
		expect(existsSync(spillSessionDir)).toBe(false);
	});

	test("single-prompt manual /compact succeeds with touched files, preserves system prompt, and syncSkills works post-compaction", async () => {
		const compactDir = join(ws, "compact-eval");
		mkdirSync(compactDir, { recursive: true });
		writeFileSync(join(compactDir, "AGENTS.md"), "Before-compact instructions");
		writeFileSync(join(compactDir, "big.txt"), `${"line-of-text-for-compaction ".repeat(4000)}\n`);

		let turn = 0;
		const scripted = startScriptedUpstream((req) => {
			if (String(req.messages?.[0]?.content ?? "").includes("You compress the earlier part")) {
				return { text: "Compacted summary of work." };
			}
			turn++;
			if (turn === 1) return { toolCalls: [{ id: "c1", name: "read", args: { path: "big.txt" } }] };
			if (turn === 2) return { toolCalls: [{ id: "c2", name: "write", args: { path: "out.txt", content: "written" } }] };
			if (turn === 3) return { toolCalls: [{ id: "c3", name: "read", args: { path: "big.txt" } }] };
			if (turn === 4) return { toolCalls: [{ id: "c4", name: "read", args: { path: "big.txt" } }] };
			return { text: "All done." };
		});

		try {
			expect((await api("PUT", "/configuration/providers/compact-eval", {
				name: "Compact",
				baseUrl: scripted.baseUrl,
				api: "openai-completions",
				authRequired: false,
				models: [{ ...ECHO_MODEL, contextWindow: 128_000 }],
			})).status).toBe(200);
			const id = (await api("POST", "/sessions", { cwd: compactDir, provider: "compact-eval", model: ECHO_MODEL.id })).json.id as string;

			// Tiny session still 409s
			expect((await api("POST", `/sessions/${id}/compact`, {})).status).toBe(409);

			// Single-prompt long run (> 20k tokens of tool output, no second user message)
			expect((await api("POST", `/sessions/${id}/messages`, { text: "do a lot of reads in one prompt" })).status).toBe(202);
			await app.sessions.idle();

			// Manual /compact now succeeds via assistant-boundary fallback!
			const compacted = await api("POST", `/sessions/${id}/compact`, {});
			expect(compacted.status).toBe(200);

			// Update AGENTS.md after compaction and send another message: syncSkills must update the system prompt!
			writeFileSync(join(compactDir, "AGENTS.md"), "After-compact instructions");
			const reqBefore = scripted.requests.length;
			expect((await api("POST", `/sessions/${id}/messages`, { text: "continue after compact" })).status).toBe(202);
			await app.sessions.idle();

			const postReqs = scripted.requests.slice(reqBefore);
			const isSummaryReq = (r: any) => String(r.messages?.[0]?.content ?? "").includes("You compress the earlier part");
			const postReq = postReqs.find((r) => !isSummaryReq(r))!;
			expect(postReq).toBeDefined();
			const sysContent = postReq.messages[0].content as string;
			expect(sysContent).toContain("After-compact instructions");
			expect(sysContent).not.toContain("Before-compact instructions");

			// Compacted summary message deterministically preserves touched files
			const summaryMsg = postReq.messages.find((m: any) => m.role === "user" && JSON.stringify(m.content).includes("Compacted summary of work."));
			expect(summaryMsg).toBeDefined();
			const summaryText = JSON.stringify(summaryMsg.content);
			expect(summaryText).toContain("Files touched before compaction:");
			expect(summaryText).toContain("out.txt");
			expect(summaryText).toContain("big.txt");
		} finally {
			scripted.stop();
		}
	});

	test("BUDGET_WRAPUP_STEER (origin=goal, mode=steer) omits GOAL_NOTE while normal goal prompt includes it", async () => {
		const scripted = startScriptedUpstream(async (_req, idx) => {
			if (idx === 0) return { toolCalls: [{ id: "g1", name: "bash", args: { command: "sleep 0.15 && echo hi" } }] };
			return { text: "Wrapped up." };
		});
		try {
			expect((await api("PUT", "/configuration/providers/goal-steer", echoProviderBody(scripted.baseUrl, "GoalSteer"))).status).toBe(200);
			const id = (await api("POST", "/sessions", { cwd: ws, provider: "goal-steer", model: ECHO_MODEL.id })).json.id as string;

			// Normal goal prompt includes GOAL_NOTE in stored message
			await app.sessions.send(id, { text: "start goal work", mode: "prompt", origin: "goal" });
			// While running, steer with origin=goal (like BUDGET_WRAPUP_STEER)
			await app.sessions.send(id, { text: "wrap up now", mode: "steer", origin: "goal" });
			await app.sessions.idle();

			const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
			const userTexts = msgs
				.filter((m) => m.message?.role === "user")
				.map((m) => (Array.isArray(m.message.content) ? m.message.content.map((c: any) => c.text ?? "").join("\n") : String(m.message.content)));
			const promptMsg = userTexts.find((t) => t.includes("start goal work"))!;
			const steerMsg = userTexts.find((t) => t.includes("wrap up now"))!;
			expect(promptMsg).toContain(GOAL_NOTE);
			expect(steerMsg).not.toContain(GOAL_NOTE);
		} finally {
			scripted.stop();
		}
	});

	test("live RunGuardState catches 2-step cycles and repeated identical tool errors", async () => {
		// 1) 2-step cycle: ls(a) -> ls(b) -> ls(a) -> ls(b) -> ls(a) -> ls(b)
		let cycleTurn = 0;
		const cycleUpstream = startScriptedUpstream(() => {
			cycleTurn++;
			const path = cycleTurn % 2 === 1 ? "." : "./";
			return { toolCalls: [{ id: `cy-${cycleTurn}`, name: "ls", args: { path } }] };
		});
		// 2) 5 DIFFERENT bash commands exiting 1 must NOT falsely trip repeated-error guard
		let diffErrTurn = 0;
		const diffErrUpstream = startScriptedUpstream(() => {
			diffErrTurn++;
			if (diffErrTurn <= 5) {
				return { toolCalls: [{ id: `de-${diffErrTurn}`, name: "bash", args: { command: `test -f nonexistent-file-${diffErrTurn}` } }] };
			}
			return { text: "Completed 5 different checks." };
		});
		// 3) Repeated identical failing bash command (5 consecutive turns) MUST abort
		let errTurn = 0;
		const errUpstream = startScriptedUpstream(() => {
			errTurn++;
			return { toolCalls: [{ id: `er-${errTurn}`, name: "bash", args: { command: "test -f same-missing-file" } }] };
		});
		try {
			expect((await api("PUT", "/configuration/providers/cycle-eval", echoProviderBody(cycleUpstream.baseUrl, "Cycle"))).status).toBe(200);
			expect((await api("PUT", "/configuration/providers/diff-err-eval", echoProviderBody(diffErrUpstream.baseUrl, "DiffErr"))).status).toBe(200);
			expect((await api("PUT", "/configuration/providers/err-eval", echoProviderBody(errUpstream.baseUrl, "Err"))).status).toBe(200);

			const id1 = (await api("POST", "/sessions", { cwd: ws, provider: "cycle-eval", model: ECHO_MODEL.id })).json.id as string;
			const limits1: string[] = [];
			const unsub1 = app.bus.subscribe((e) => {
				if (e.sessionId === id1 && e.type === "run_limit") limits1.push((e.data as any).reason);
			});
			expect((await api("POST", `/sessions/${id1}/messages`, { text: "loop cycle" })).status).toBe(202);
			await app.sessions.idle();
			unsub1();
			expect(limits1.length).toBe(1);
			expect(limits1[0]).toMatch(/cycle|loop/i);
			expect(cycleTurn).toBeLessThanOrEqual(8);

			const idDiff = (await api("POST", "/sessions", { cwd: ws, provider: "diff-err-eval", model: ECHO_MODEL.id })).json.id as string;
			const limitsDiff: string[] = [];
			const unsubDiff = app.bus.subscribe((e) => {
				if (e.sessionId === idDiff && e.type === "run_limit") limitsDiff.push((e.data as any).reason);
			});
			expect((await api("POST", `/sessions/${idDiff}/messages`, { text: "different checks" })).status).toBe(202);
			await app.sessions.idle();
			unsubDiff();
			expect(limitsDiff).toEqual([]);
			expect(diffErrTurn).toBe(6);

			const id2 = (await api("POST", "/sessions", { cwd: ws, provider: "err-eval", model: ECHO_MODEL.id })).json.id as string;
			const limits2: string[] = [];
			const unsub2 = app.bus.subscribe((e) => {
				if (e.sessionId === id2 && e.type === "run_limit") limits2.push((e.data as any).reason);
			});
			expect((await api("POST", `/sessions/${id2}/messages`, { text: "loop error" })).status).toBe(202);
			await app.sessions.idle();
			unsub2();
			expect(limits2.length).toBe(1);
			expect(limits2[0]).toMatch(/error|repeated/i);
			expect(errTurn).toBeLessThanOrEqual(6);
		} finally {
			cycleUpstream.stop();
			diffErrUpstream.stop();
			errUpstream.stop();
		}
	});

	test("delegate FORBIDDEN stripping, capSubagentOutput, OpenRouter splitSpec, and detach slot release", async () => {
		// 1) FORBIDDEN tools stripped from subagent role
		writeFileSync(
			join(home, ".agents", "subagents", "eval-role.md"),
			`---\ndescription: eval\ntools: [read, glob, delegate, peer, ask_user, schedule, goal, workdir, generate_image]\n---\nBe concise.\n`,
		);
		const defs = loadSubagents(ws, home);
		expect(defs.get("eval-role")!.tools).toEqual(["read", "glob"]);

		// 2) Anti-pileup invariant (#342): detached hung subagent keeps its slot until the inner run settles
		const limits = new DelegateLimits();
		const release = limits.acquire("s-slot", { calls: 10, running: 1 });
		let finishHung!: () => void;
		const hungPromise = new Promise<void>((r) => { finishHung = r; });
		const outcome = await runDelegateWithinDeadline(
			async () => {
				try { await hungPromise; } finally { release(); }
			},
			() => {},
			undefined,
			20,
			20,
		);
		expect(outcome).toBe("deadline");
		// While hung work has not settled, acquiring a 2nd slot MUST fail (anti-pileup)
		expect(() => limits.acquire("s-slot", { calls: 10, running: 1 })).toThrow(/at most 1 subagent/i);
		// Once the hung work settles, the slot is released and a new acquire succeeds
		finishHung();
		await new Promise((r) => setTimeout(r, 10));
		const release2 = limits.acquire("s-slot", { calls: 10, running: 1 });
		release2();

		// 3) capSubagentOutput caps > 32,000 char subagent answer + OpenRouter org/model resolves via splitSpec
		const huge = "Z".repeat(MAX_SUBAGENT_OUTPUT_CHARS + 500);
		let subCall = 0;
		const subUpstream = startScriptedUpstream(() => {
			subCall++;
			if (subCall === 1) {
				return {
					toolCalls: [{
						id: "del-1",
						name: "delegate",
						args: { role: "eval-role", task: "return huge text", model: "anthropic/claude-test" },
					}],
				};
			}
			if (subCall === 2) return { text: huge };
			return { text: "Parent finished." };
		});
		try {
			expect((await api("PUT", "/configuration/providers/or-eval", {
				name: "OR Eval",
				baseUrl: subUpstream.baseUrl,
				api: "openai-completions",
				authRequired: false,
				models: [{ ...ECHO_MODEL, id: "anthropic/claude-test" }],
			})).status).toBe(200);
			expect((await api("PUT", "/configuration/delegate", { roles: "any", policy: "any", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 })).status).toBe(200);

			const id = (await api("POST", "/sessions", { cwd: ws, provider: "or-eval", model: "anthropic/claude-test" })).json.id as string;
			expect((await api("POST", `/sessions/${id}/messages`, { text: "run delegate" })).status).toBe(202);
			await app.sessions.idle();

			const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
			const delRes = msgs.find((m) => m.message?.role === "toolResult" && m.message?.toolName === "delegate");
			expect(delRes?.message?.isError).toBe(false);
			const delText = delRes?.message?.content?.[0]?.text as string;
			expect(delText).toContain("[subagent output truncated: 500 characters omitted]");
			expect(delText.length).toBeLessThan(huge.length);
		} finally {
			subUpstream.stop();
		}
	});

	test("cache telemetry in GET /sessions/:id/context, describeTools real descriptions, and peer answer null schema", async () => {
		const cacheUpstream = startScriptedUpstream((_req, idx) => ({
			text: `Reply ${idx}`,
			usage: idx === 0
				? { prompt_tokens: 1000, completion_tokens: 20, cached_tokens: 0 }
				: { prompt_tokens: 1000, completion_tokens: 20, cached_tokens: 800 },
		}));
		try {
			expect((await api("PUT", "/configuration/providers/cache-eval", echoProviderBody(cacheUpstream.baseUrl, "Cache"))).status).toBe(200);
			const id = (await api("POST", "/sessions", { cwd: ws, provider: "cache-eval", model: ECHO_MODEL.id })).json.id as string;

			// Before any turns: no cache field on context; toolSpecs carries real AgentTool.description + peer null schema
			const pre = (await api("GET", `/sessions/${id}/context`)).json;
			expect(pre.cache).toBeUndefined();
			const peerSpec = (pre.toolSpecs as any[]).find((t) => t.name === "peer");
			expect(peerSpec.description).toContain("list_models:");
			expect(peerSpec.parameters.properties.answers.maxItems).toBe(8);
			expect(peerSpec.parameters.properties.answer.anyOf).toEqual(
				expect.arrayContaining([expect.objectContaining({ type: "null" }), expect.objectContaining({ type: "string" })]),
			);

			// Two turns: second turn hits prompt cache (800 cached / 1000 prompt -> 800 cacheRead + 200 input)
			expect((await api("POST", `/sessions/${id}/messages`, { text: "turn 1" })).status).toBe(202);
			await app.sessions.idle();
			expect((await api("POST", `/sessions/${id}/messages`, { text: "turn 2" })).status).toBe(202);
			await app.sessions.idle();

			const post = (await api("GET", `/sessions/${id}/context`)).json;
			expect(post.cache).toBeDefined();
			expect(post.cache.turns).toBe(2);
			expect(post.cache.cacheRead).toBe(800);
			expect(post.cache.input).toBe(1200);
			expect(post.cache.hitRate).toBeCloseTo(800 / 2000, 5);
		} finally {
			cacheUpstream.stop();
		}
	});
});
