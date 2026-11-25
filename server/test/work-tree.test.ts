import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { worktreesOf } from "../src/git-info.ts";
import { SessionStore } from "../src/store.ts";
import { cdTarget, movedNote, resolveMove, stayHint, touchedDir, workTargets } from "../src/work-tree.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let dir: string;
let main: string;
let wt: string;
let other: string;
let plain: string;

/** A worktree of `main` at `path` on `branch`, laid out the way git writes it (`.git` file, gitdir, commondir, HEAD). */
function addWorktree(path: string, branch: string): void {
	const meta = join(main, ".git/worktrees", path.split("/").pop()!);
	mkdirSync(meta, { recursive: true });
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, ".git"), `gitdir: ${meta}\n`);
	writeFileSync(join(meta, "HEAD"), `ref: refs/heads/${branch}\n`);
	writeFileSync(join(meta, "commondir"), "../..\n");
	writeFileSync(join(meta, "gitdir"), `${join(path, ".git")}\n`);
}

/** A main checkout on `main`, a worktree of it on `feat/x`, another repository and a plain folder. */
beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-wt-")));
	main = join(dir, "app");
	wt = join(dir, "app-x");
	other = join(dir, "other");
	plain = join(dir, "notes");
	mkdirSync(join(main, ".git"), { recursive: true });
	mkdirSync(join(main, "client/src"), { recursive: true });
	writeFileSync(join(main, ".git/HEAD"), "ref: refs/heads/main\n");
	addWorktree(wt, "feat/x");
	mkdirSync(join(wt, "server/src"), { recursive: true });
	mkdirSync(join(other, ".git"), { recursive: true });
	writeFileSync(join(other, ".git/HEAD"), "ref: refs/heads/main\n");
	mkdirSync(plain);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("cdTarget", () => {
	test("follows each cd in order, relative to the one before", () => {
		expect(cdTarget("cd ../app-x && bun test", "/w/app", "/h")).toBe("/w/app-x");
		expect(cdTarget("cd /w/app-x; cd server && ls", "/w/app", "/h")).toBe("/w/app-x/server");
		expect(cdTarget("git status\ncd '../app-x'", "/w/app", "/h")).toBe("/w/app-x");
		expect(cdTarget("cd ~/w/app-x", "/w/app", "/h")).toBe("/h/w/app-x");
	});
	test("a command without a readable cd says nothing; making a worktree is not moving into it", () => {
		expect(cdTarget("git worktree add -b feat/x ../app-x origin/main", "/w/app", "/h")).toBeNull();
		expect(cdTarget("(cd ../app-x && bun install)", "/w/app", "/h")).toBeNull();
		expect(cdTarget("cd $WT", "/w/app", "/h")).toBeNull();
		expect(cdTarget("cd - && ls", "/w/app", "/h")).toBeNull();
		expect(cdTarget("echo cd ../x", "/w/app", "/h")).toBeNull();
		expect(cdTarget('echo "foo; cd ../app-x"', "/w/app", "/h")).toBeNull();
		expect(cdTarget("echo 'foo | cd ../app-x'", "/w/app", "/h")).toBeNull();
	});
	test("handles quoted directory names containing semicolons, pipes, or spaces", () => {
		expect(cdTarget('cd "my;dir" && ls', "/w/app", "/h")).toBe("/w/app/my;dir");
		expect(cdTarget("cd 'my dir' && pwd", "/w/app", "/h")).toBe("/w/app/my dir");
		expect(cdTarget('cd "a|b" && echo ok', "/w/app", "/h")).toBe("/w/app/a|b");
	});
});

describe("touchedDir", () => {
	test("bash by its cd, edit and write by the file's folder, other tools not at all", () => {
		expect(touchedDir("bash", { command: "cd ../app-x && ls" }, "/w/app", "/h")).toBe("/w/app-x");
		expect(touchedDir("edit", { path: "../app-x/server/a.ts" }, "/w/app", "/h")).toBe("/w/app-x/server");
		expect(touchedDir("write", { path: "/w/app-x/b.md" }, "/w/app", "/h")).toBe("/w/app-x");
		expect(touchedDir("read", { path: "../app-x/a.ts" }, "/w/app", "/h")).toBeNull();
		expect(touchedDir("bash", {}, "/w/app", "/h")).toBeNull();
	});
});

describe("working trees", () => {
	test("worktreesOf lists the main checkout first, then each worktree still on disk", () => {
		mkdirSync(join(main, ".git/worktrees/pruned"), { recursive: true });
		writeFileSync(join(main, ".git/worktrees/pruned/gitdir"), `${join(dir, "pruned/.git")}\n`);
		expect(worktreesOf(main)).toEqual([{ path: main, branch: "main" }, { path: wt, branch: "feat/x" }]);
	});
	test("workTargets puts the session's own working tree first, from either side", () => {
		expect(workTargets(main)).toEqual([{ path: main, branch: "main", home: true }, { path: wt, branch: "feat/x", home: false }]);
		expect(workTargets(join(wt, "server")).map((t) => [t.path, t.home])).toEqual([[wt, true], [main, false]]);
		expect(workTargets(main, (d) => d === main)).toHaveLength(1);
		expect(workTargets(plain)).toEqual([]);
	});
	test("resolveMove names the other working tree's top, null for its own, and refuses anything else", () => {
		expect(resolveMove(main, join(wt, "server/src"))).toBe(wt);
		expect(resolveMove(main, join(main, "client"))).toBeNull();
		expect(resolveMove(wt, main)).toBe(main);
		expect(() => resolveMove(main, other)).toThrow(/not a working tree of this session's repository.*app-x \(feat\/x\)/);
		expect(() => resolveMove(main, plain)).toThrow(/not a working tree/);
		expect(() => resolveMove(main, join(dir, "nowhere"))).toThrow(/is not a folder/);
		expect(() => resolveMove(plain, main)).toThrow(/not in a git repository/);
		expect(() => resolveMove(main, wt, () => false)).toThrow(/outside the workspace/);
	});
	test("stayHint speaks only of another working tree of the same repository", () => {
		expect(stayHint(main, main, join(wt, "server"))).toContain(`call workdir (action move, path ${wt})`);
		expect(stayHint(main, wt, join(wt, "server"))).toBeNull(); // already there
		expect(stayHint(main, main, join(main, "client"))).toBeNull();
		expect(stayHint(main, main, other)).toBeNull();
		expect(stayHint(main, main, null)).toBeNull();
	});
	test("movedNote says who moved it and how to get back", () => {
		expect(movedNote(main, main, wt, "agent")).toContain(`moved from ${main} to ${wt} (branch feat/x)`);
		expect(movedNote(main, main, wt, "user")).toStartWith("[pipaya] The user moved this session");
		expect(movedNote(main, wt, null, "agent")).not.toContain("workdir back");
		expect(movedNote(main, join(dir, "gone"), null, "gone")).toContain("no longer exists");
	});
});

describe("SessionStore.setActiveDir", () => {
	test("is stored and read back without touching the list order", () => {
		const store = new SessionStore(openDb(":memory:"));
		store.create({ id: "s1", title: "t", name: "", purpose: "", cwd: main, provider: "p", model: "m", thinkingLevel: "off", systemPrompt: "", tools: [], parentId: null, closed: false, createdAt: 1, updatedAt: 1 });
		expect(store.get("s1")?.activeDir).toBeNull();
		const r = store.setActiveDir("s1", wt);
		expect(r?.activeDir).toBe(wt);
		expect(r?.updatedAt).toBe(1);
		expect(store.setActiveDir("s1", null)?.activeDir).toBeNull();
	});
});

describe("moving a session between working trees", () => {
	const TOKEN = "work-tree-test-token-0123456789ab";
	let app: App;
	let upstream: EchoUpstream;
	let base = "";
	const api = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const run = async (id: string, text: string) => {
		await api("POST", `/sessions/${id}/messages`, { text });
		for (let i = 0; i < 200; i++) {
			if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
			await Bun.sleep(25);
		}
		throw new Error("session never went idle");
	};
	const messages = async (id: string) => (await api("GET", `/sessions/${id}/messages`)).json.messages as { message: { role: string; content: { type: string; text?: string }[] } }[];
	const texts = (m: { message: { content: { type: string; text?: string }[] } }) => m.message.content.map((c) => c.text ?? "").join("\n");
	const lastToolText = async (id: string) => texts((await messages(id)).filter((m) => m.message.role === "toolResult").at(-1)!);
	const activeDir = async (id: string) => (await api("GET", `/sessions/${id}`)).json.activeDir ?? null;

	beforeAll(async () => {
		upstream = startEchoUpstream();
		app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "api.db"), token: TOKEN, workspaceRoot: dir, logLevel: "silent" }, { strictResponses: true, extensionDirs: [] });
		await app.server.listen({ host: "127.0.0.1", port: 0 });
		base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
		expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
		expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
	});
	afterAll(async () => {
		await app.close();
		upstream.stop();
	});

	test("working in another worktree without moving only earns a hint, once per run", async () => {
		const { json: s } = await api("POST", "/sessions", { cwd: main });
		await run(s.id, "!bash cd ../app-x && pwd");
		expect(await activeDir(s.id)).toBeNull();
		expect(await lastToolText(s.id)).toContain(`call workdir (action move, path ${wt})`);
	});

	test("the agent moves with workdir: its tools start there, and back brings it home", async () => {
		const { json: s } = await api("POST", "/sessions", { cwd: main });
		await run(s.id, '!workdir {"action":"show"}');
		expect(await lastToolText(s.id)).toContain(`- ${wt} (feat/x)`);
		await run(s.id, '!workdir {"action":"move","path":"../app-x"}');
		expect(await activeDir(s.id)).toBe(wt);
		expect(await lastToolText(s.id)).toContain(`moved from ${main} to ${wt} (branch feat/x)`);
		await run(s.id, "!bash pwd");
		expect(await lastToolText(s.id)).toStartWith(wt);
		await run(s.id, '!write {"path":"note.md","content":"hi"}');
		expect(await Bun.file(join(wt, "note.md")).text()).toBe("hi");
		const res = await fetch(`${base}/sessions/${s.id}/files?path=note.md`, { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(await res.text()).toBe("hi");
		const { json: fork } = await api("POST", `/sessions/${s.id}/fork`, {});
		expect(fork.activeDir).toBe(wt);
		await run(s.id, `!workdir {"action":"move","path":"${other}"}`);
		expect(await lastToolText(s.id)).toContain("not a working tree of this session's repository");
		expect(await activeDir(s.id)).toBe(wt);
		await run(s.id, '!workdir {"action":"back"}');
		expect(await activeDir(s.id)).toBeNull();
		await run(s.id, "!bash pwd");
		expect(await lastToolText(s.id)).toStartWith(main);
	});

	test("the user moves a session with PATCH workDir, and its agent hears of it with the next message", async () => {
		const { json: s } = await api("POST", "/sessions", { cwd: main });
		expect((await api("GET", `/sessions/${s.id}/workdirs`)).json.workdirs).toEqual([
			{ path: main, branch: "main", home: true, current: true },
			{ path: wt, branch: "feat/x", home: false, current: false },
		]);
		expect((await api("PATCH", `/sessions/${s.id}`, { workDir: other })).status).toBe(400);
		const moved = await api("PATCH", `/sessions/${s.id}`, { workDir: wt });
		expect(moved.status).toBe(200);
		expect(moved.json.activeDir).toBe(wt);
		await run(s.id, "hello"); // (the echo model would read the note into a !bash command)
		const all = await messages(s.id);
		expect(texts(all.find((m) => m.message.role === "user")!)).toContain("The user moved this session");
		await run(s.id, "!bash pwd");
		expect(texts((await messages(s.id)).filter((m) => m.message.role === "user").at(-1)!)).not.toContain("moved"); // told once
		expect(await lastToolText(s.id)).toStartWith(wt);
		expect((await api("PATCH", `/sessions/${s.id}`, { workDir: null })).json.activeDir ?? null).toBeNull();
		// other fields still go through the same PATCH
		expect((await api("PATCH", `/sessions/${s.id}`, { title: "renamed", workDir: wt })).json).toMatchObject({ title: "renamed", activeDir: wt });
	});

	test("a worktree removed under the session sends it home, and the agent is told", async () => {
		const gone = join(dir, "app-gone");
		addWorktree(gone, "feat/gone");
		const { json: s } = await api("POST", "/sessions", { cwd: main });
		await run(s.id, `!workdir {"action":"move","path":"${gone}"}`);
		expect(await activeDir(s.id)).toBe(gone);
		await run(s.id, `!bash rm -rf ${gone}`);
		expect(await activeDir(s.id)).toBeNull();
		expect(await lastToolText(s.id)).toContain(`${gone} no longer exists`);
		await run(s.id, "!bash pwd");
		expect(await lastToolText(s.id)).toStartWith(main);
	});
});
