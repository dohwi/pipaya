import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { detectShells, Scrollback, shellArgs, shellEnv } from "../src/terminals.ts";

const TOKEN = "terminal-test-token-0123456789abcdef";
let dir: string;
let app: App;
let base: string;

beforeAll(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-term-")));
	const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: TOKEN, workspaceRoot: dir, defaultApproval: "ask", approvalTimeoutMs: 0, logLevel: "silent" };
	app = await buildApp(cfg, { home: dir, builtinSkills: false, extensionDirs: [] });
	await app.server.listen({ host: "127.0.0.1", port: 0 });
	const addr = app.server.server.address() as { port: number };
	base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
	await app.close();
	rmSync(dir, { recursive: true, force: true });
});

const api = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(base + path, {
		method,
		headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

/** A plain POSIX shell from the server's own list (keeps the user's rc files out of the test). */
const sh = async () => {
	const shells = (await api("GET", "/terminals/info")).json.shells as { name: string; path: string }[];
	return (shells.find((s) => s.name === "sh") ?? shells.find((s) => s.name === "bash") ?? shells[0])!.path;
};

const until = async (check: () => boolean, ms = 5000) => {
	for (let t = 0; t < ms; t += 20) {
		if (check()) return;
		await Bun.sleep(20);
	}
	throw new Error("timed out");
};

function attach(id: string) {
	const ws = new WebSocket(`${base.replace("http", "ws")}/terminals/${id}/ws?token=${TOKEN}`);
	ws.binaryType = "arraybuffer";
	const state = { text: "", frames: [] as any[], closed: false };
	ws.onmessage = (m) => {
		if (typeof m.data === "string") state.frames.push(JSON.parse(m.data));
		else state.text += new TextDecoder().decode(m.data as ArrayBuffer);
	};
	ws.onclose = () => (state.closed = true);
	const open = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
	return { ws, state, open };
}

describe("helpers", () => {
	test("shells: PowerShell first on Windows, $SHELL first elsewhere", () => {
		const which = (c: string) => ({ pwsh: "C:\\pwsh.exe", powershell: "C:\\powershell.exe", cmd: "C:\\cmd.exe", bash: "/bin/bash", sh: "/bin/sh" })[c] ?? null;
		expect(detectShells("win32", {}, which).map((s) => s.name)).toEqual(["PowerShell", "Windows PowerShell", "Command Prompt"]);
		expect(detectShells("win32", {}, (c) => (c === "pwsh" ? null : which(c)))[0]!.path).toBe("C:\\powershell.exe");
		expect(detectShells("linux", { SHELL: "/bin/sh" }, which).map((s) => s.path)).toEqual(["/bin/sh", "/bin/bash"]);
	});
	test("PowerShell starts in UTF-8; POSIX shells as login shells", () => {
		expect(shellArgs("C:\\Windows\\powershell.exe", false)).toContain("-");
		expect(shellArgs("pwsh", true).join(" ")).toContain("UTF8Encoding");
		expect(shellArgs("/bin/bash", true)).toEqual(["-l"]);
	});
	test("the server token never reaches a shell", () => {
		const env = shellEnv({ PIPAYA_TOKEN: "x", PATH: "/bin", PIPAYA_PORT: "1" });
		expect(env.PIPAYA_TOKEN).toBeUndefined();
		expect(env.PATH).toBe("/bin");
		expect(env.TERM).toBe("xterm-256color");
	});
	test("scrollback keeps only the tail", () => {
		const s = new Scrollback(10);
		s.push(new TextEncoder().encode("hello "));
		s.push(new TextEncoder().encode("world, again"));
		expect(new TextDecoder().decode(s.bytes())).toBe("rld, again");
	});
});

describe.skipIf(process.platform === "win32")("terminals API", () => {
	test("info names the platform and a shell", async () => {
		const r = await api("GET", "/terminals/info");
		expect(r.status).toBe(200);
		expect(r.json.platform).toBe(process.platform);
		expect(r.json.pty).toBe(true);
		expect(r.json.shell?.path).toBeTruthy();
	});

	test("open, type, resize, re-attach, close", async () => {
		const made = await api("POST", "/terminals", { shell: await sh(), cols: 90, rows: 20 });
		expect(made.status).toBe(201);
		const id = made.json.id as string;
		expect(id.startsWith("term_")).toBe(true);
		expect(made.json.cwd).toBe(dir);
		expect((await api("GET", "/terminals")).json.terminals.map((t: { id: string }) => t.id)).toContain(id);

		const a = attach(id);
		await a.open;
		await until(() => a.state.frames.some((f) => f.type === "hello"));
		a.ws.send(JSON.stringify({ type: "input", data: "echo pi$((1+2))ya\r" }));
		await until(() => a.state.text.includes("pi3ya"));
		a.ws.send(JSON.stringify({ type: "resize", cols: 123, rows: 30 }));
		await Bun.sleep(50);
		a.ws.send(JSON.stringify({ type: "input", data: "stty size\r" }));
		await until(() => a.state.text.includes("30 123"));
		a.ws.close();

		// A second viewer sees what was already on screen.
		const b = attach(id);
		await b.open;
		await until(() => b.state.text.includes("pi3ya"));

		const renamed = await api("PATCH", `/terminals/${id}`, { title: "빌드" });
		expect(renamed.json.title).toBe("빌드");

		expect((await api("DELETE", `/terminals/${id}`)).status).toBe(200);
		await until(() => b.state.closed);
		expect(b.state.frames.some((f) => f.type === "exit")).toBe(true);
		for (let i = 0; i < 100 && (await api("GET", "/terminals")).json.terminals.some((t: { id: string }) => t.id === id); i++) await Bun.sleep(20);
		expect((await api("GET", "/terminals")).json.terminals.some((t: { id: string }) => t.id === id)).toBe(false);
		expect((await api("DELETE", `/terminals/${id}`)).status).toBe(404);
	});

	test("the socket needs the token", async () => {
		const made = await api("POST", "/terminals", { shell: await sh() });
		const res = await fetch(`${base}/terminals/${made.json.id}/ws`);
		expect(res.status).toBe(401);
		await api("DELETE", `/terminals/${made.json.id}`);
	});

	test("a missing directory or unknown shell is refused", async () => {
		expect((await api("POST", "/terminals", { cwd: join(dir, "nope") })).status).toBe(400);
		expect((await api("POST", "/terminals", { shell: "/usr/bin/evil" })).status).toBe(400);
	});

	test("a terminal can share a group with a session, and leaves it when it exits", async () => {
		const s = await api("POST", "/sessions", {});
		// Sessions need a model; without one configured the server refuses, so only check when it worked.
		const t = await api("POST", "/terminals", { shell: await sh() });
		const t2 = await api("POST", "/terminals", { shell: await sh() });
		const other = s.status === 201 ? s.json.id : t2.json.id;
		const g = await api("POST", "/groups", { layout: { type: "split", dir: "row", ratio: 0.5, a: { type: "pane", sessionId: other }, b: { type: "pane", sessionId: t.json.id } } });
		expect(g.status).toBe(201);
		await api("DELETE", `/terminals/${t.json.id}`);
		for (let i = 0; i < 100; i++) {
			const list = (await api("GET", "/groups")).json.groups as { id: string }[];
			if (!list.some((x) => x.id === g.json.id)) break;
			await Bun.sleep(30);
		}
		expect(((await api("GET", "/groups")).json.groups as { id: string }[]).some((x) => x.id === g.json.id)).toBe(false);
		await api("DELETE", `/terminals/${t2.json.id}`);
	});
});
