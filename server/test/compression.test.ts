import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { buildApp, CORS_MAX_AGE_S, type App } from "../src/app.ts";
import { compress, pickEncoding } from "../src/compression.ts";
import type { Config } from "../src/config.ts";

describe("pickEncoding", () => {
	test("prefers brotli, falls back to gzip, honours q=0", () => {
		expect(pickEncoding("gzip, deflate, br")).toBe("br");
		expect(pickEncoding("gzip, deflate")).toBe("gzip");
		expect(pickEncoding("br;q=0, gzip;q=0.5")).toBe("gzip");
		expect(pickEncoding("identity")).toBeNull();
		expect(pickEncoding(undefined)).toBeNull();
		expect(pickEncoding(["gzip", "br"])).toBe("br");
	});
});

describe("compress", () => {
	test("works without the SharedArrayBuffer global (the compiled macOS sidecar has none)", async () => {
		const g = globalThis as { SharedArrayBuffer?: unknown };
		const saved = g.SharedArrayBuffer;
		delete g.SharedArrayBuffer;
		try {
			const body = JSON.stringify({ list: "x".repeat(4096) });
			expect(gunzipSync(await compress("gzip", body)).toString()).toBe(body);
			expect(brotliDecompressSync(await compress("br", body)).toString()).toBe(body);
		} finally {
			g.SharedArrayBuffer = saved;
		}
	});
});

describe("response compression and preflight caching", () => {
	const TOKEN = "compression-test-token-0123456789";
	let app: App;
	let dir: string;
	const auth = { authorization: `Bearer ${TOKEN}` };

	beforeAll(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-compress-")));
		const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: TOKEN, workspaceRoot: dir, logLevel: "silent" };
		app = await buildApp(cfg, { strictResponses: true, home: dir, builtinSkills: false, extensionDirs: [] });
	});
	afterAll(async () => {
		await app.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("a large JSON list is compressed for a client that asks, and decodes to the same body", async () => {
		const plain = await app.server.inject({ method: "GET", url: "/models", headers: auth });
		expect(plain.statusCode).toBe(200);
		expect(plain.headers["content-encoding"]).toBeUndefined();
		expect(plain.rawPayload.length).toBeGreaterThan(1024);

		const br = await app.server.inject({ method: "GET", url: "/models", headers: { ...auth, "accept-encoding": "gzip, br" } });
		expect(br.headers["content-encoding"]).toBe("br");
		expect(String(br.headers.vary)).toContain("Accept-Encoding");
		expect(br.rawPayload.length).toBeLessThan(plain.rawPayload.length);
		expect(JSON.parse(brotliDecompressSync(br.rawPayload).toString())).toEqual(plain.json());

		const gz = await app.server.inject({ method: "GET", url: "/models", headers: { ...auth, "accept-encoding": "gzip" } });
		expect(gz.headers["content-encoding"]).toBe("gzip");
		expect(JSON.parse(gunzipSync(gz.rawPayload).toString())).toEqual(plain.json());
	});

	test("small bodies and errors stay as they are", async () => {
		const health = await app.server.inject({ method: "GET", url: "/health", headers: { "accept-encoding": "gzip, br" } });
		expect(health.headers["content-encoding"]).toBeUndefined();
		expect(health.json().ok).toBe(true);
		const refused = await app.server.inject({ method: "GET", url: "/models", headers: { "accept-encoding": "gzip, br" } });
		expect(refused.statusCode).toBe(401);
		expect(refused.headers["content-encoding"]).toBeUndefined();
	});

	test("a preflight answer may be reused instead of asked again for every request", async () => {
		const r = await app.server.inject({
			method: "OPTIONS",
			url: "/models",
			headers: { origin: "http://tauri.localhost", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
		});
		expect(r.statusCode).toBe(204);
		expect(r.headers["access-control-max-age"]).toBe(String(CORS_MAX_AGE_S));
	});
});
