import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

const TOKEN = "restrict-test-token-0123456789abc";
let dir: string;
let ws: string;
let outside: string;
let app: App;
let upstream: ReturnType<typeof startEchoUpstream>;

const call = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};

async function boot(restrict: boolean) {
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, `db-${restrict}.sqlite`), token: TOKEN, workspaceRoot: ws, restrictWorkspace: restrict, defaultApproval: "ask", approvalTimeoutMs: 0, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
	await call("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
	await call("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
}

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-restrict-")));
	ws = join(dir, "ws");
	outside = join(dir, "elsewhere");
	mkdirSync(ws, { recursive: true });
	mkdirSync(outside);
	symlinkSync(outside, join(ws, "link-out"));
	upstream = startEchoUpstream();
});
afterAll(() => {
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("PIPAYA_RESTRICT_WORKSPACE", () => {
	test("off (default): any existing directory is allowed", async () => {
		await boot(false);
		expect((await call("POST", "/sessions", { cwd: outside })).status).toBe(201);
		expect((await call("PUT", "/configuration/workdir", { path: outside })).status).toBe(200);
		expect((await call("GET", `/fs/dirs?path=${encodeURIComponent(outside)}`)).status).toBe(200);
		await app.close();
	});

	test("on: sessions, the default folder and the picker stay inside the workspace", async () => {
		await boot(true);
		expect((await call("POST", "/sessions", { cwd: ws })).status).toBe(201);
		expect((await call("POST", "/sessions", { cwd: "project-a" })).status).toBe(201); // created under the workspace
		expect((await call("POST", "/sessions", { cwd: outside })).status).toBe(400);
		expect((await call("POST", "/sessions", { cwd: "../elsewhere" })).status).toBe(400);
		expect((await call("POST", "/sessions", { cwd: join(ws, "link-out") })).status).toBe(400); // a symlink out does not count as inside

		expect((await call("PUT", "/configuration/workdir", { path: outside })).status).toBe(400);
		expect((await call("PUT", "/configuration/workdir", { path: join(ws, "project-a") })).status).toBe(200);

		expect((await call("GET", `/fs/dirs?path=${encodeURIComponent(outside)}`)).status).toBe(400);
		expect((await call("POST", "/fs/dirs", { parent: outside, name: "x" })).status).toBe(400);
		const top = await call("GET", `/fs/dirs?path=${encodeURIComponent(ws)}`);
		expect(top.status).toBe(200);
		expect(top.json.parent).toBeNull(); // no way up out of the workspace
		await app.close();
	});
});

describe("@ mentions outside the working directory", () => {
	const files = (cwd: string, q: string) => call("GET", `/fs/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`);

	test("off: absolute and ../ paths list one folder at a time", async () => {
		await boot(false);
		mkdirSync(join(outside, "docs"), { recursive: true });
		await Bun.write(join(outside, "notes.md"), "x");
		const abs = await files(ws, `${outside}/`);
		expect(abs.status).toBe(200);
		expect(abs.json.entries).toEqual([
			{ path: `${outside}/docs/`, dir: true },
			{ path: `${outside}/notes.md`, dir: false },
		]);
		expect((await files(ws, `${outside}/no`)).json.entries.map((e: any) => e.path)).toEqual([`${outside}/notes.md`]);
		expect((await files(ws, "../elsewhere/do")).json.entries).toEqual([{ path: "../elsewhere/docs/", dir: true }]);
		expect((await files(ws, "/definitely/not/here/")).json.entries).toEqual([]);
		expect((await files(ws, "~/")).status).toBe(200);
		await app.close();
	});

	test("on: paths leading out of the workspace are refused", async () => {
		await boot(true);
		expect((await files(ws, `${outside}/`)).status).toBe(400);
		expect((await files(ws, "../elsewhere/")).status).toBe(400);
		expect((await files(ws, "~/")).status).toBe(400);
		await app.close();
	});
});

describe("@ mention search inside the working directory", () => {
	const files = (cwd: string, q: string) => call("GET", `/fs/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`);

	test("finds nested files, skips build folders, and concurrent lookups share one scan", async () => {
		await boot(false);
		const root = join(ws, "mention-tree");
		mkdirSync(join(root, "src", "components"), { recursive: true });
		mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
		await Bun.write(join(root, "src", "components", "Button.svelte"), "x");
		await Bun.write(join(root, "node_modules", "pkg", "Button.js"), "x");
		await Bun.write(join(root, "README.md"), "x");

		const [a, b, c] = await Promise.all([files(root, "button"), files(root, "butt"), files(root, "readme")]);
		expect(a.status).toBe(200);
		expect(a.json.entries).toEqual([{ path: "src/components/Button.svelte", dir: false }]); // node_modules is not indexed
		expect(b.json.entries).toEqual(a.json.entries);
		expect(c.json.entries).toEqual([{ path: "README.md", dir: false }]);
		expect((await files(root, "comp")).json.entries[0]).toEqual({ path: "src/components/", dir: true });
		await app.close();
	});
});
