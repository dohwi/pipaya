import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";

let app: App;
let dir: string;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const call = async (method: any, url: string, payload?: unknown, auth = true) => {
	const r = await app.server.inject({ method, url, headers: auth ? { authorization: "Bearer test-token" } : {}, ...(payload === undefined ? {} : { payload: payload as any }) });
	return { status: r.statusCode, body: r.headers["content-type"]?.toString().includes("application/json") ? r.json() : r.rawPayload, headers: r.headers };
};
const provider = (icon: string) => ({ name: "P", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", authRequired: false,
	models: [{ id: "m", contextWindow: 8192, maxTokens: 1024, reasoning: false, vision: false, icon }] });

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-icons-"));
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "workspace"), logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

describe("model icon images", () => {
	test("require authentication", async () => {
		expect((await call("POST", "/configuration/icons", { data: PNG }, false)).status).toBe(401);
		expect((await call("GET", "/configuration/icons", undefined, false)).status).toBe(401);
		expect((await call("GET", "/configuration/icons/abc", undefined, false)).status).toBe(401);
	});

	test("upload, list and serve an image safely", async () => {
		const up = await call("POST", "/configuration/icons", { data: PNG });
		expect(up.status).toBe(200);
		expect(up.body.icon).toMatch(/^img:[0-9a-f]{16}$/);
		expect((await call("POST", "/configuration/icons", { data: PNG })).body.icon).toBe(up.body.icon); // same bytes, same id
		expect((await call("GET", "/configuration/icons")).body.icons).toEqual([up.body.icon]);
		const got = await call("GET", `/configuration/icons/${up.body.icon.slice(4)}`);
		expect(got.status).toBe(200);
		expect(got.headers["content-type"]).toBe("image/png");
		expect(got.headers["x-content-type-options"]).toBe("nosniff");
		expect(Buffer.from(got.body).toString("base64")).toBe(PNG);
		expect((await call("GET", "/configuration/icons/0000000000000000")).status).toBe(404);
	});

	test("rejects what is not a safe image", async () => {
		const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
		expect((await call("POST", "/configuration/icons", { data: svg })).status).toBe(400);
		expect((await call("POST", "/configuration/icons", { data: "not base64!" })).status).toBe(400);
		const big = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(300 * 1024)]).toString("base64");
		expect((await call("POST", "/configuration/icons", { data: big })).status).toBe(400);
	});

	test("a model can use an uploaded image, but not one that does not exist", async () => {
		const { icon } = (await call("POST", "/configuration/icons", { data: PNG })).body;
		const saved = await call("PUT", "/configuration/providers/ic", provider(icon));
		expect(saved.status).toBe(200);
		expect(saved.body.models[0].icon).toBe(icon);
		expect((await call("PUT", "/configuration/providers/ic", provider("img:ffffffffffffffff"))).status).toBe(400);
		expect((await call("PUT", "/configuration/providers/ic", provider("claude"))).status).toBe(200); // built-in marks stay free text
		const models = (await call("GET", "/models")).body.models.filter((m: any) => m.provider === "ic");
		expect(models[0].icon).toBe("claude");
	});
});
