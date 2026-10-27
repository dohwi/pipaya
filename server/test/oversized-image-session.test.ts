import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as photon from "@silvia-odwyer/photon-node";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { sniffImage } from "../src/image-file.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

// A picture bigger than 3000px in a session's history made every later request fail with a 400, and retrying resent it.
const VISION = { ...ECHO_MODEL, id: "vision-model", vision: true };

let app: App;
let dir: string;
let ws: string;
let upstream: EchoUpstream;
const api = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({
		method, url,
		headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};
const idle = async (id: string) => {
	for (let i = 0; i < 300; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(20); }
	throw new Error("never idle");
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-bigimg-"));
	ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, home: dir });
	expect((await api("PUT", "/configuration/providers/up", { ...echoProviderBody(upstream.baseUrl), models: [VISION] })).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "up", model: VISION.id })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

test("a 3200x1800 attachment is shrunk in every request sent upstream, including later turns", async () => {
	const big = Buffer.from(new photon.PhotonImage(new Uint8Array(3200 * 1800 * 4).fill(180), 3200, 1800).get_bytes()).toString("base64");
	const id = (await api("POST", "/sessions", { cwd: ws })).json.id;

	for (const text of ["look at this", "and continue"]) {
		const sent = await api("POST", `/sessions/${id}/messages`, { text, ...(text === "look at this" ? { images: [{ type: "image", data: big, mimeType: "image/png" }] } : {}) });
		expect(sent.status).toBe(202);
		await idle(id);
	}

	const sizes: number[] = [];
	for (const req of upstream.requests) {
		for (const m of req.body?.messages ?? []) {
			if (!Array.isArray(m.content)) continue;
			for (const part of m.content) {
				if (part?.type !== "image_url") continue;
				const info = sniffImage(Buffer.from(String(part.image_url.url).split(",")[1] ?? "", "base64"));
				sizes.push(Math.max(info?.width ?? 0, info?.height ?? 0));
			}
		}
	}
	expect(sizes.length).toBeGreaterThanOrEqual(2); // the picture is part of both requests
	expect(Math.max(...sizes)).toBeLessThanOrEqual(2000);
	expect(Math.min(...sizes)).toBeGreaterThan(0);
});
