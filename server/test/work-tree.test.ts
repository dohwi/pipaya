import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { SessionStore } from "../src/store.ts";
import { cdTarget, nextActiveDir, touchedDir } from "../src/work-tree.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let dir: string;
let main: string;
let wt: string;
let other: string;
let plain: string;

/** A main checkout on `main`, a worktree of it on `feat/x`, another repository and a plain folder. */
beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-wt-")));
	main = join(dir, "app");
	wt = join(dir, "app-x");
	other = join(dir, "other");
	plain = join(dir, "notes");
	mkdirSync(join(main, ".git/worktrees/app-x"), { recursive: true });
	mkdirSync(join(main, "client/src"), { recursive: true });
	writeFileSync(join(main, ".git/HEAD"), "ref: refs/heads/main\n");
	mkdirSync(join(wt, "server/src"), { recursive: true });
	writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git/worktrees/app-x")}\n`);
	writeFileSync(join(main, ".git/worktrees/app-x/HEAD"), "ref: refs/heads/feat/x\n");
	writeFileSync(join(main, ".git/worktrees/app-x/commondir"), "../..\n");
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
	test("making a worktree counts as moving into it", () => {
		expect(cdTarget("git worktree add -b feat/x ../app-x origin/main", "/w/app", "/h")).toBe("/w/app-x");
		expect(cdTarget("git fetch -q && git worktree add -q -B fix/y --reason 'r' /w/app-y", "/w/app", "/h")).toBe("/w/app-y");
		expect(cdTarget("git -C /w/app worktree add ../app-z", "/tmp", "/h")).toBe("/w/app-z");
		// a cd after it wins, and a worktree made from inside another folder is resolved there
		expect(cdTarget("git worktree add ../app-x && cd ../app-x/server", "/w/app", "/h")).toBe("/w/app-x/server");
		expect(cdTarget("git worktree list && git worktree remove ../app-x", "/w/app", "/h")).toBeNull();
		expect(cdTarget("git worktree add $WT", "/w/app", "/h")).toBeNull();
	});
	test("a command without a readable cd says nothing", () => {
		expect(cdTarget("(cd ../app-x && bun install)", "/w/app", "/h")).toBeNull();
		expect(cdTarget("cd $WT", "/w/app", "/h")).toBeNull();
		expect(cdTarget("cd - && ls", "/w/app", "/h")).toBeNull();
		expect(cdTarget("echo cd ../x", "/w/app", "/h")).toBeNull();
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

describe("nextActiveDir", () => {
	test("moving into a worktree of the same repository names that worktree's top", () => {
		expect(nextActiveDir(main, null, join(wt, "server/src"))).toBe(wt);
		// a file written into a folder that does not exist yet still belongs to the worktree
		expect(nextActiveDir(main, null, join(wt, "new/deep"))).toBe(wt);
	});
	test("coming back to its own working tree clears it", () => {
		expect(nextActiveDir(main, wt, join(main, "client"))).toBeNull();
	});
	test("another repository, a plain folder, or nothing to go on leaves it as it was", () => {
		expect(nextActiveDir(main, wt, other)).toBe(wt);
		expect(nextActiveDir(main, wt, plain)).toBe(wt);
		expect(nextActiveDir(main, wt, null)).toBe(wt);
		expect(nextActiveDir(plain, null, wt)).toBeNull();
	});
	test("a worktree outside what is allowed is not followed", () => {
		expect(nextActiveDir(main, null, wt, () => false)).toBeNull();
	});
	test("a worktree removed since is let go", () => {
		expect(nextActiveDir(main, join(dir, "gone"), null)).toBeNull();
	});
	test("a session made in a worktree follows its agent back to the main checkout", () => {
		expect(nextActiveDir(wt, null, main)).toBe(main);
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

describe("a session's agent moving into a worktree", () => {
	const TOKEN = "work-tree-test-token-0123456789ab";
	let app: App;
	let upstream: EchoUpstream;
	let base = "";
	const api = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
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

	const lastToolText = async (id: string) => {
		const { json } = await api("GET", `/sessions/${id}/messages`);
		const results = (json.messages as { message: { role: string; content: { type: string; text?: string }[] } }[]).filter((m) => m.message.role === "toolResult");
		return results.at(-1)!.message.content.map((c) => c.text ?? "").join("\n");
	};

	test("the agent works in the worktree it moved into, is told so, and comes back to its own", async () => {
		const { json: s } = await api("POST", "/sessions", { cwd: main });
		expect(s.activeDir ?? null).toBeNull();
		await run(s.id, "!bash cd ../app-x && pwd");
		expect((await api("GET", `/sessions/${s.id}`)).json.activeDir).toBe(wt);
		expect(await lastToolText(s.id)).toContain(`now works in the git worktree ${wt} (branch feat/x)`);
		// the next call starts there: no cd needed, and relative paths resolve against it
		await run(s.id, "!bash pwd");
		expect(await lastToolText(s.id)).toStartWith(wt);
		await run(s.id, '!write {"path":"note.md","content":"hi"}');
		expect(await Bun.file(join(wt, "note.md")).text()).toBe("hi");
		// the file preview finds it from the session's relative path
		const res = await fetch(`${base}/sessions/${s.id}/files?path=note.md`, { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(await res.text()).toBe("hi");
		// a fork goes on where its history left off
		const { json: fork } = await api("POST", `/sessions/${s.id}/fork`, {});
		expect(fork.activeDir).toBe(wt);
		// a command that fails before it gets there moves nothing
		await run(s.id, "!bash cd ../nowhere && pwd");
		expect((await api("GET", `/sessions/${s.id}`)).json.activeDir).toBe(wt);
		await run(s.id, `!bash cd ${main} && pwd`);
		expect((await api("GET", `/sessions/${s.id}`)).json.activeDir).toBeNull();
		expect(await lastToolText(s.id)).toContain(`works in ${main} (branch main) again`);
		await run(s.id, "!bash pwd");
		expect(await lastToolText(s.id)).toStartWith(main);
	});

	test("a worktree removed under the session sends it home before its next call", async () => {
		const gone = join(dir, "app-gone");
		mkdirSync(gone);
		writeFileSync(join(gone, ".git"), `gitdir: ${join(main, ".git/worktrees/app-gone")}\n`);
		mkdirSync(join(main, ".git/worktrees/app-gone"), { recursive: true });
		writeFileSync(join(main, ".git/worktrees/app-gone/HEAD"), "ref: refs/heads/feat/gone\n");
		writeFileSync(join(main, ".git/worktrees/app-gone/commondir"), "../..\n");
		const { json: s } = await api("POST", "/sessions", { cwd: main });
		await run(s.id, "!bash cd ../app-gone");
		expect((await api("GET", `/sessions/${s.id}`)).json.activeDir).toBe(gone);
		rmSync(gone, { recursive: true, force: true });
		await run(s.id, "!bash pwd");
		expect((await api("GET", `/sessions/${s.id}`)).json.activeDir).toBeNull();
		expect(await lastToolText(s.id)).toStartWith(main);
	});
});
