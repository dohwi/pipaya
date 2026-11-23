import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { parseExtensionRouteRequest } from "../src/extensions/route-path.ts";
import { compareVersions } from "../src/shared/version.ts";

describe("parseExtensionRouteRequest", () => {
	test("accepts clean extension paths with query strings and falls back safely on malformed host", () => {
		const ok = parseExtensionRouteRequest("/x/demo/public/a/b?foo=1", "example.com:8787");
		expect(ok?.pathname).toBe("/x/demo/public/a/b");
		expect(ok?.url.href).toBe("http://example.com:8787/x/demo/public/a/b?foo=1");

		const badHost = parseExtensionRouteRequest("/x/demo/public/a/b", "evil.com:bad/path");
		expect(badHost?.pathname).toBe("/x/demo/public/a/b");
		expect(badHost?.url.host).toBe("localhost");
	});

	test("rejects dot segments, percent-encoded traversal, backslashes, and malformed escapes", () => {
		expect(parseExtensionRouteRequest("")).toBeNull();
		expect(parseExtensionRouteRequest("x/demo/admin")).toBeNull();
		expect(parseExtensionRouteRequest("/x/demo/public/../admin")).toBeNull();
		expect(parseExtensionRouteRequest("/x/demo/./admin")).toBeNull();
		expect(parseExtensionRouteRequest("/x/demo/public/%2e%2e/admin")).toBeNull();
		expect(parseExtensionRouteRequest("/x/demo/public/..%2fadmin")).toBeNull();
		expect(parseExtensionRouteRequest("/x/demo/public/..%5cadmin")).toBeNull();
		expect(parseExtensionRouteRequest("/x/demo/public\\admin")).toBeNull();
		expect(parseExtensionRouteRequest("/x/demo/%E0%A4%A")).toBeNull();
	});
});

describe("shared compareVersions", () => {
	test("compares valid triples and returns null on missing or invalid inputs", () => {
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
		expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
		expect(compareVersions("", "1.0.0")).toBeNull();
		expect(compareVersions(null, "1.0.0")).toBeNull();
		expect(compareVersions("1.2", "1.2.0")).toBeNull();
	});
});

describe("extension HTTP route auth boundary", () => {
	let dir: string;
	let app: App;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-sec-"));
		const exts = join(dir, "exts");
		mkdirSync(exts, { recursive: true });
		writeFileSync(
			join(exts, "demo.js"),
			`export default (pi) => {
				pi.registerRoute({
					method: "GET",
					path: "/public/:a/:b",
					public: true,
					handler: async (_req, ctx) => ({ route: "public", authenticated: ctx.authenticated, params: ctx.params }),
				});
				pi.registerRoute({
					method: "GET",
					path: "/admin",
					public: false,
					handler: async (_req, ctx) => ({ route: "admin", authenticated: ctx.authenticated }),
				});
			};`,
		);
		const cfg: Config = {
			host: "0.0.0.0",
			port: 0,
			dataDir: dir,
			dbPath: join(dir, "db.sqlite"),
			token: "test-secret-token",
			workspaceRoot: join(dir, "ws"),
			logLevel: "silent",
		};
		app = await buildApp(cfg, { strictResponses: true, extensionDirs: [exts], home: dir });
	});

	afterAll(async () => {
		await app?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("dot-segment traversal on a public route cannot bypass auth to reach a private route", async () => {
		const pub = await app.server.inject({ method: "GET", url: "/x/demo/public/x/y" });
		expect(pub.statusCode).toBe(200);
		expect(pub.json()).toMatchObject({ route: "public", authenticated: false });

		const privDenied = await app.server.inject({ method: "GET", url: "/x/demo/admin" });
		expect(privDenied.statusCode).toBe(401);

		// Traversal payloads MUST NOT skip auth or reach /admin
		for (const payload of [
			"/x/demo/public/../admin",
			"/x/demo/public/x/../../admin",
			"/x/demo/public/%2e%2e/admin",
			"/x/demo/public/..%2fadmin",
			"/x/demo/public\\..\\admin",
		]) {
			const res = await app.server.inject({ method: "GET", url: payload });
			expect(res.statusCode).toBe(401);
		}

		// Even with an admin token, encoded slash / backslash traversal paths reaching the server are rejected as 400
		const authedEncodedTraversal = await app.server.inject({
			method: "GET",
			url: "/x/demo/public/..%2fadmin",
			headers: { authorization: "Bearer test-secret-token" },
		});
		expect(authedEncodedTraversal.statusCode).toBe(400);

		// Malformed Host header does not crash with 500
		const badHost = await app.server.inject({
			method: "GET",
			url: "/x/demo/public/x/y",
			headers: { host: "evil.com:bad" },
		});
		expect(badHost.statusCode).toBe(200);
	});
});
