import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { aggregateReadFiles, discoverInstructions, type ContextSnapshot } from "../src/context.ts";
import { openDb } from "../src/db.ts";
import { SessionStore, type SessionRecord } from "../src/store.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pipaya-context-"));
	const home = join(root, "home");
	const cwd = join(root, "project", "nested");
	mkdirSync(join(home, ".agents"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, home, cwd, global: join(home, ".agents", "AGENTS.md"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const record = (id: string, cwd: string): SessionRecord => ({
	id, name: "", cwd, title: "Old session", provider: "echo", model: ECHO_MODEL.id,
	thinkingLevel: "medium", systemPrompt: "Base prompt", tools: ["read"],
	purpose: "", parentId: null, closed: false, archived: false, createdAt: 1, updatedAt: 1,
});

function readResult(path: string, from: number, to: number, timestamp: number, isError = false): Extract<AgentMessage, { role: "toolResult" }> {
	return { role: "toolResult", toolName: "read", toolCallId: `call-${timestamp}`,
		content: [{ type: "text", text: "read output" }], details: { path, from, to }, isError, timestamp };
}

describe("instruction discovery", () => {
	test("global first, root-to-cwd ancestors next; contents/bytes exact and no child discovery", () => {
		const f = fixture();
		try {
			writeFileSync(f.global, "Global\n");
			writeFileSync(join(f.root, "AGENTS.md"), "Outer\n");
			writeFileSync(join(f.root, "project", "AGENTS.md"), "Project\n");
			writeFileSync(join(f.cwd, "AGENTS.md"), "로컬\n");
			mkdirSync(join(f.cwd, "child"));
			writeFileSync(join(f.cwd, "child", "AGENTS.md"), "must not load");
			const result = discoverInstructions(f.cwd, { home: f.home });
			const local = result.instructions.filter((i) => i.path.startsWith(realpathSync(f.root)));
			expect(local.map((i) => [i.scope, i.content])).toEqual([
				["global", "Global\n"], ["ancestor", "Outer\n"], ["ancestor", "Project\n"], ["cwd", "로컬\n"],
			]);
			expect(local.at(-1)?.bytes).toBe(Buffer.byteLength("로컬\n"));
			expect(result.warnings).toEqual([]);
		} finally { f.cleanup(); }
	});

	test("deduplicates canonical paths, preserves first scope and skips empty/whitespace files", () => {
		const f = fixture();
		try {
			writeFileSync(f.global, "Shared");
			symlinkSync(f.global, join(f.cwd, "AGENTS.md"));
			writeFileSync(join(f.root, "AGENTS.md"), "");
			writeFileSync(join(f.root, "project", "AGENTS.md"), " \n\t ");
			const result = discoverInstructions(f.cwd, { home: f.home });
			expect(result.instructions.filter((i) => i.path.startsWith(f.root))).toEqual([
				{ path: realpathSync(f.global), scope: "global", content: "Shared", bytes: 6 },
			]);
			expect(result.warnings).toEqual([]);
		} finally { f.cleanup(); }
	});

	test("warns for non-regular files and filesystem errors, ignores missing files", () => {
		const f = fixture();
		try {
			mkdirSync(f.global);
			const broken = join(f.root, "AGENTS.md");
			symlinkSync(broken, broken); // ELOOP: reliable error even when tests run as root.
			const fifo = join(f.cwd, "AGENTS.md");
			execFileSync("mkfifo", [fifo], { timeout: 1000 });
			const result = discoverInstructions(f.cwd, { home: f.home });
			expect(result.instructions.filter((i) => i.path.startsWith(f.root))).toEqual([]);
			expect(result.warnings.map((w) => w.path)).toEqual([f.global, broken, fifo]);
			expect(result.warnings[0]?.message).toContain("not a regular file");
			expect(result.warnings[1]?.message).toContain("Unable to load");
			expect(result.warnings[2]?.message).toContain("not a regular file");
		} finally { f.cleanup(); }
	});

	test("skips oversized files with explicit per-file/total warnings, accepts exact limits", () => {
		const f = fixture();
		try {
			writeFileSync(f.global, "123456");
			writeFileSync(join(f.root, "AGENTS.md"), "1234567");
			writeFileSync(join(f.root, "project", "AGENTS.md"), "12345");
			writeFileSync(join(f.cwd, "AGENTS.md"), "1234");
			const result = discoverInstructions(f.cwd, { home: f.home, maxFileBytes: 6, maxTotalBytes: 10 });
			expect(result.instructions.filter((i) => i.path.startsWith(f.root)).map((i) => i.content)).toEqual(["123456", "1234"]);
			expect(result.warnings.find((w) => w.path === join(f.root, "AGENTS.md"))?.message).toContain("per-file limit (6 bytes)");
			expect(result.warnings.find((w) => w.path === join(f.root, "project", "AGENTS.md"))?.message).toContain("total limit (10 bytes)");
		} finally { f.cleanup(); }
	});
});

describe("stored context and read traces", () => {
	test("first snapshot wins, survives database reopen, forks independently, cascades on delete", () => {
		const f = fixture();
		const path = join(f.root, "test.db");
		let db = openDb(path);
		try {
			let store = new SessionStore(db);
			store.create(record("parent", f.cwd));
			expect(store.context("parent")).toBeUndefined();
			const snapshot: ContextSnapshot = { cwd: f.cwd, capturedAt: 100, systemPrompt: "base", effectiveSystemPrompt: "base plus original", instructions: [], warnings: [], tools: ["read"] };
			expect(store.captureContext("parent", snapshot)).toEqual(snapshot);
			expect(store.captureContext("parent", { ...snapshot, effectiveSystemPrompt: "changed" })).toEqual(snapshot);
			store.appendMessage("parent", 0, readResult("a.txt", 1, 3, 50));
			db.close();
			db = openDb(path);
			store = new SessionStore(db);
			expect(store.context("parent")).toEqual(snapshot);
			store.create({ ...record("fork", f.cwd), parentId: "parent" });
			expect(store.copyMessages("parent", "fork", 0)).toBe(1);
			expect(store.context("fork")).toEqual(snapshot);
			store.delete("parent");
			expect(store.context("parent")).toBeUndefined();
			expect(store.context("fork")).toEqual(snapshot);
			expect(store.messages("fork")).toHaveLength(1);
			store.delete("fork");
			expect(db.query("SELECT COUNT(*) AS n FROM session_contexts").get()).toEqual({ n: 0 });
		} finally { db.close(); f.cleanup(); }
	});

	test("aggregates persisted successful read results only, normalizes paths and merges ranges", () => {
		const f = fixture();
		const db = openDb(join(f.root, "test.db"));
		try {
			const store = new SessionStore(db);
			store.create(record("trace", f.cwd));
			const messages: AgentMessage[] = [
				readResult("./a.txt", 5, 10, 20), readResult(join(f.cwd, "a.txt"), 1, 5, 10),
				readResult("nested/../a.txt", 20, 25, 30), readResult("a.txt", 11, 19, 25, true),
				{ ...readResult("bash-only.txt", 1, 100, 100), toolName: "bash" },
				{ role: "user", content: "read a.txt lines 11-19", timestamp: 90 },
				{ ...readResult("ignored.txt", 1, 2, 80), details: {} },
				readResult("b.txt", 5, 2, 40), // successful empty/out-of-bounds read: no valid range
			];
			messages.forEach((m, seq) => store.appendMessage("trace", seq, m));
			expect(aggregateReadFiles(f.cwd, store.messages("trace"))).toEqual([
				{ path: join(f.cwd, "a.txt"), reads: 3, lastReadAt: 30, ranges: [{ from: 1, to: 10 }, { from: 20, to: 25 }] },
				{ path: join(f.cwd, "b.txt"), reads: 1, lastReadAt: 40, ranges: [] },
			]);
		} finally { db.close(); f.cleanup(); }
	});
});

describe("context API and application", () => {
	test("authenticated exact contract; preview has no effects; actual injection is stable across reload/restart/fork", async () => {
		const f = fixture();
		const upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: f.root, dbPath: join(f.root, "app.db"),
			token: "context-test", workspaceRoot: f.cwd, logLevel: "silent" };
		let app: App = await buildApp(cfg, { strictResponses: true });
		const api = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, authorized = true) => {
			const res = await app.server.inject({ method, url, payload, headers: authorized ? { authorization: `Bearer ${cfg.token}` } : {} });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const run = async (id: string, text: string) => {
			expect((await api("POST", `/sessions/${id}/messages`, { text })).status).toBe(202);
			await app.sessions.idle();
		};
		try {
			expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
			expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
			writeFileSync(join(f.cwd, "AGENTS.md"), "Preview version");
			const id = (await api("POST", "/sessions", { cwd: f.cwd, tools: ["read"], systemPrompt: "Base" })).json.id as string;
			expect((await api("GET", `/sessions/${id}/context`, undefined, false)).status).toBe(401);
			expect((await api("GET", `/sessions/${id}/context?token=${cfg.token}`, undefined, false)).status).toBe(401);
			expect((await api("GET", "/sessions/missing/context")).status).toBe(404);
			const preview = (await api("GET", `/sessions/${id}/context`)).json;
			expect(Object.keys(preview).sort()).toEqual(["cwd", "state", "capturedAt", "systemPrompt", "effectiveSystemPrompt", "instructions", "warnings", "tools", "toolSpecs", "systemPrompts", "skills", "skillsPrompt", "readFiles"].sort());
			expect(preview).toMatchObject({ cwd: f.cwd, state: "preview", capturedAt: null, systemPrompt: "Base", tools: ["read"], readFiles: [] });
			expect(preview.instructions.at(-1)).toEqual({ path: join(f.cwd, "AGENTS.md"), scope: "cwd", content: "Preview version", bytes: 15 });
			// Every tool the agent gets is listed as the model sees it, with why it is there.
			const specs = preview.toolSpecs as { name: string; description: string; parameters: any; source: string; enabled: boolean; bytes: number }[];
			const bySource = (src: string) => specs.filter((t) => t.source === src).map((t) => t.name);
			expect(bySource("session")).toEqual(["read"]);
			expect(bySource("always")).toEqual(["peer_send", "peer_read"]);
			expect(specs.every((t) => t.enabled && t.description && t.bytes > t.description.length)).toBe(true);
			expect(specs.find((t) => t.name === "read")!.parameters).toMatchObject({ type: "object" });
			// The system's own wording is listed too, each entry with when it applies and its text.
			const prompts = preview.systemPrompts as { id: string; kind: string; when: string; text: string; active: boolean; bytes: number }[];
			expect(prompts.map((p) => p.id)).toEqual(expect.arrayContaining(["sdk-claude-code", "runtime-peer-message", "runtime-compaction-summary", "helper-compaction", "helper-describe", "helper-group-name"]));
			expect(prompts.every((p) => p.when && p.text && p.bytes === Buffer.byteLength(p.text))).toBe(true);
			expect(prompts.find((p) => p.id === "helper-compaction")!.text).toContain("You compress the earlier part");
			expect(prompts.find((p) => p.id === "runtime-peer-message")!.text).toContain("peer_send");
			// The echo model speaks openai-completions, so the Anthropic / Codex wording is listed but not active.
			expect(prompts.find((p) => p.id === "sdk-claude-code")!.active).toBe(false);
			expect(prompts.find((p) => p.id === "sdk-codex-default")!.active).toBe(false);
			// Before any session exists: the same preview for a new chat in that folder.
			expect((await api("GET", `/context?cwd=${encodeURIComponent(f.cwd)}`, undefined, false)).status).toBe(401);
			const fresh = (await api("GET", `/context?cwd=${encodeURIComponent(f.cwd)}`)).json;
			expect(fresh).toMatchObject({ cwd: f.cwd, state: "preview", capturedAt: null, readFiles: [] });
			expect(fresh.instructions.at(-1)).toEqual(preview.instructions.at(-1));
			expect(fresh.effectiveSystemPrompt).toContain("Preview version");
			for (const mode of ["steer", "follow_up"]) {
				expect((await api("POST", `/sessions/${id}/messages`, { text: "invalid", mode })).status).toBe(409);
			}
			expect((await api("POST", `/sessions/${id}/retry`, {})).status).toBe(409);
			const db = openDb(cfg.dbPath);
			try { expect(new SessionStore(db).context(id)).toBeUndefined(); } finally { db.close(); }
			expect(upstream.requests).toHaveLength(0);
			expect((await api("PATCH", `/sessions/${id}`, { systemPrompt: "Updated base" })).status).toBe(200);

			writeFileSync(join(f.cwd, "AGENTS.md"), "Applied version");
			writeFileSync(join(f.cwd, "sample.txt"), "one\ntwo\nthree\nfour\n");
			await run(id, '!read {"path":"sample.txt","offset":2,"limit":2}');
			const applied = (await api("GET", `/sessions/${id}/context`)).json;
			expect(applied.state).toBe("applied");
			expect(applied.systemPrompt).toBe("Updated base");
			expect(applied.capturedAt).toBeGreaterThan(0);
			expect(applied.effectiveSystemPrompt).toContain("Applied version");
			expect(applied.effectiveSystemPrompt).not.toContain("Preview version");
			expect(upstream.requests[0]?.body.messages.find((m: any) => m.role === "system" || m.role === "developer")?.content).toBe(applied.effectiveSystemPrompt);
			expect(applied.readFiles).toMatchObject([{ path: join(f.cwd, "sample.txt"), reads: 1, ranges: [{ from: 2, to: 3 }] }]);
			await run(id, '!read {"path":"missing.txt"}');
			expect((await api("GET", `/sessions/${id}/context`)).json.readFiles).toEqual(applied.readFiles);
			// AGENTS.md follows the disk like skills: an edit shows at once and reaches the model on the next run.
			writeFileSync(join(f.cwd, "AGENTS.md"), "Edited version");
			const edited = (await api("GET", `/sessions/${id}/context`)).json;
			expect(edited).toMatchObject({ state: "applied", capturedAt: applied.capturedAt, systemPrompt: "Updated base" });
			expect(edited.instructions.at(-1)).toMatchObject({ path: join(f.cwd, "AGENTS.md"), content: "Edited version" });
			expect(edited.effectiveSystemPrompt).toContain("Edited version");
			await run(id, "after edit");
			expect(upstream.requests.at(-1)?.body.messages[0].content).toBe(edited.effectiveSystemPrompt);
			writeFileSync(join(f.cwd, "AGENTS.md"), "Applied version");
			await run(id, "after revert");
			expect(upstream.requests.at(-1)?.body.messages[0].content).toBe(applied.effectiveSystemPrompt);
			expect((await api("GET", `/sessions/${id}/context`)).json).toEqual(applied);

			// Idle-agent eviction/reload without changing persistence.
			const manager = app.sessions as unknown as { live: Map<string, { lastActive: number }>; evictIdle(): void };
			manager.live.get(id)!.lastActive = 0;
			manager.evictIdle();
			expect(manager.live.has(id)).toBe(false);
			await run(id, "after eviction");
			expect((await api("GET", `/sessions/${id}/context`)).json).toEqual(applied);
			expect(upstream.requests.at(-1)?.body.messages[0].content).toBe(applied.effectiveSystemPrompt);
			await app.close();
			app = await buildApp(cfg, { strictResponses: true });
			expect((await api("GET", `/sessions/${id}/context`)).json).toEqual(applied);
			await run(id, "after restart");
			expect(upstream.requests.at(-1)?.body.messages[0].content).toBe(applied.effectiveSystemPrompt);

			const fork = (await api("POST", `/sessions/${id}/fork`, { atSeq: 0 })).json.id as string;
			expect((await api("GET", `/sessions/${fork}/context`)).json).toEqual({ ...applied, readFiles: [] });
			expect((await api("PATCH", `/sessions/${fork}`, { systemPrompt: "different" })).status).toBe(409);
			await run(fork, "fork run");
			expect(upstream.requests.at(-1)?.body.messages[0].content).toBe(applied.effectiveSystemPrompt);
			expect((await api("DELETE", `/sessions/${id}`)).status).toBe(204);
			expect((await api("GET", `/sessions/${id}/context`)).status).toBe(404);
			expect((await api("GET", `/sessions/${fork}/context`)).json.effectiveSystemPrompt).toBe(applied.effectiveSystemPrompt);

			// An existing transcript without v6 snapshot remains preview until a real run.
			const legacyDb = openDb(cfg.dbPath);
			try {
				const store = new SessionStore(legacyDb);
				store.create(record("legacy", f.cwd));
				store.appendMessage("legacy", 0, { role: "user", content: "old request", timestamp: 1 });
			} finally { legacyDb.close(); }
			expect((await api("GET", "/sessions/legacy/context")).json.state).toBe("preview");
			writeFileSync(join(f.cwd, "AGENTS.md"), "Legacy next run");
			await run("legacy", "capture now");
			const legacy = (await api("GET", "/sessions/legacy/context")).json;
			expect(legacy.state).toBe("applied");
			expect(legacy.effectiveSystemPrompt).toContain("Legacy next run");
		} finally { await app.close(); upstream.stop(); f.cleanup(); }
	});
});
