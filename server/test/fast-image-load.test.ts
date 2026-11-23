import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as photon from "@silvia-odwyer/photon-node";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { previewToFit } from "../src/image-resize-core.ts";
import { stripOversizedToolResultImages, stripToolMessageImages, stripToolResultImages } from "../src/tool-images.ts";
import { ECHO_MODEL, ECHO_PNG, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

const IMG = { id: "img-model", name: "Img", contextWindow: 65536, maxTokens: 32768, reasoning: false, vision: true, imageGeneration: true };

function noisePng(w: number, h: number, alpha = 255): Buffer {
	const px = new Uint8Array(w * h * 4);
	let x = 12345;
	for (let i = 0; i < px.length; i += 4) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		px[i] = x >>> 8; px[i + 1] = x >>> 16; px[i + 2] = x >>> 24;
		px[i + 3] = i === 0 ? alpha : 255;
	}
	const img = new photon.PhotonImage(px, w, h);
	try {
		return Buffer.from(img.get_bytes());
	} finally {
		img.free();
	}
}

describe("stripToolMessageImages", () => {
	test("strips image blocks only from toolResult messages without mutating originals", () => {
		const user = { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "AAA", mimeType: "image/png" }] };
		expect(stripToolMessageImages(user)).toBe(user);

		const textOnlyTool = { role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "ok" }] };
		expect(stripToolMessageImages(textOnlyTool)).toBe(textOnlyTool);

		const imgTool = {
			role: "toolResult",
			toolCallId: "2",
			toolName: "generate_image",
			content: [{ type: "text", text: "Saved x.png" }, { type: "image", data: "BBB", mimeType: "image/png" }],
		};
		const stripped = stripToolMessageImages(imgTool);
		expect(stripped).not.toBe(imgTool);
		expect(stripped.content).toEqual([{ type: "text", text: "Saved x.png" }]);
		expect(imgTool.content).toHaveLength(2);

		const res = { content: [{ type: "text", text: "Saved" }, { type: "image", data: "CCC", mimeType: "image/png" }], details: {} };
		expect(stripToolResultImages(res).content).toEqual([{ type: "text", text: "Saved" }]);

		const mixed = {
			content: [
				{ type: "text", text: "Saved" },
				{ type: "image", data: "SMALL", mimeType: "image/png" },
				{ type: "image", data: "X".repeat(100), mimeType: "image/png" },
			],
		};
		expect(stripOversizedToolResultImages(mixed, 20).content).toEqual([
			{ type: "text", text: "Saved" },
			{ type: "image", data: "SMALL", mimeType: "image/png" },
		]);
		expect(mixed.content).toHaveLength(3);
	});
});

describe("previewToFit", () => {
	test("downscales opaque large PNGs to smaller JPEGs and preserves PNG for transparent images", async () => {
		const opaque = noisePng(600, 600, 255);
		expect(opaque.byteLength).toBeGreaterThan(100 * 1024);
		const jpegPreview = await previewToFit(opaque, 300);
		expect(jpegPreview).not.toBeNull();
		expect(jpegPreview!.mimeType).toBe("image/jpeg");
		expect(jpegPreview!.bytes.byteLength).toBeLessThan(opaque.byteLength / 3);

		const transparent = noisePng(600, 600, 0);
		const pngPreview = await previewToFit(transparent, 300);
		expect(pngPreview).not.toBeNull();
		expect(pngPreview!.mimeType).toBe("image/png");
		expect(pngPreview!.bytes.byteLength).toBeLessThan(transparent.byteLength);
	});
});

describe("fast session messages, events and cached file previews", () => {
	let app: App;
	let dir: string;
	let ws: string;
	let upstream: EchoUpstream;

	const call = async (method: any, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
		const r = await app.server.inject({
			method, url,
			headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...headers },
			...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
		});
		return { status: r.statusCode, headers: r.headers, body: r.rawPayload, json: r.body && String(r.headers["content-type"] ?? "").includes("json") ? r.json() : undefined };
	};
	const idle = async (id: string) => {
		for (let i = 0; i < 300; i++) {
			if (!(await call("GET", `/sessions/${id}/status`)).json.running) return;
			await Bun.sleep(20);
		}
		throw new Error("never idle");
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-fastload-"));
		ws = join(dir, "ws");
		mkdirSync(ws, { recursive: true });
		upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
		app = await buildApp(cfg, { strictResponses: true, home: dir });
		expect((await call("PUT", "/configuration/providers/up", { ...echoProviderBody(upstream.baseUrl), models: [{ ...ECHO_MODEL, vision: true }, IMG] })).status).toBe(200);
		expect((await call("PUT", "/configuration/defaults", { provider: "up", model: ECHO_MODEL.id })).status).toBe(200);
		expect((await call("PUT", "/image-model", { model: { provider: "up", model: IMG.id } })).status).toBe(200);
	});
	afterAll(async () => {
		await app.close();
		upstream.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("omitToolImages strips toolResult images while keeping user images and default API behavior; persisted events exclude toolResult images", async () => {
		const id = (await call("POST", "/sessions", { cwd: ws })).json.id as string;
		const liveSeen: any[] = [];
		const off = app.bus.subscribe((e) => liveSeen.push(e), id);
		try {
		const post1 = await call("POST", `/sessions/${id}/messages`, {
			text: "user photo",
			images: [{ type: "image", data: ECHO_PNG, mimeType: "image/png" }],
		});
		expect(post1.status).toBe(202);
		await idle(id);
		const post2 = await call("POST", `/sessions/${id}/messages`, {
			text: '!generate_image {"prompt":"hello"}',
		});
		expect(post2.status).toBe(202);
		await idle(id);
	} finally {
		off();
	}

	// Live subscriber still got tool_execution_end with the image for live WorkBox preview.
	const liveEnd = liveSeen.find((e) => e.type === "tool_execution_end");
	expect(liveEnd?.data?.result?.content?.some((c: any) => c.type === "image")).toBe(true);

		// Persisted events (used on SSE reconnect/replay) omit bulky base64 toolResult images.
		const persisted = app.bus.history({ sessionId: id, after: 0, limit: 100 });
		const persistedEnd = persisted.find((e) => e.type === "tool_execution_end");
		expect((persistedEnd?.data as any)?.result?.content?.some((c: any) => c.type === "image")).toBe(false);
		const persistedMsgEnd = persisted.find((e) => e.type === "message_end" && (e.data as any)?.message?.role === "toolResult");
		expect((persistedMsgEnd?.data as any)?.message?.content?.some((c: any) => c.type === "image")).toBe(false);
		const persistedTurnEnd = persisted.find((e) => e.type === "turn_end");
		expect((persistedTurnEnd?.data as any)?.toolResults?.some((tr: any) => tr.content?.some((c: any) => c.type === "image"))).toBe(false);

		// Default GET /messages keeps toolResult images for backwards compatibility.
		const full = (await call("GET", `/sessions/${id}/messages`)).json.messages as any[];
		expect(full.find((m) => m.role === "toolResult").message.content.some((c: any) => c.type === "image")).toBe(true);

		// UI client query `omitToolImages=true` strips toolResult images but preserves user-attached images.
		const slimRes = await call("GET", `/sessions/${id}/messages?omitToolImages=true`);
		expect(slimRes.status).toBe(200);
		const slim = slimRes.json.messages as any[];
		expect(slim.find((m) => m.role === "user").message.content.some((c: any) => c.type === "image")).toBe(true);
		expect(slim.find((m) => m.role === "toolResult").message.content.some((c: any) => c.type === "image")).toBe(false);
	});

	test("file route serves ETag/304 and downscaled preview with ?max= while keeping small/svg files unchanged", async () => {
		const id = (await call("POST", "/sessions", { cwd: ws })).json.id as string;
		const big = noisePng(600, 600, 255);
		const small = Buffer.from(ECHO_PNG, "base64");
		const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>");
		writeFileSync(join(ws, "big.png"), big);
		writeFileSync(join(ws, "small.png"), small);
		writeFileSync(join(ws, "icon.svg"), svg);

		// Original + ETag + 304
		const orig = await call("GET", `/sessions/${id}/files?path=big.png`);
		expect(orig.status).toBe(200);
		expect(orig.body.byteLength).toBe(big.byteLength);
		const origEtag = String(orig.headers.etag);
		expect(origEtag).toBeTruthy();
		expect(String(orig.headers["cache-control"])).toContain("max-age=60");

		const notMod = await call("GET", `/sessions/${id}/files?path=big.png`, undefined, { "if-none-match": origEtag });
		expect(notMod.status).toBe(304);

		// Downscaled preview (concurrent requests share work and shrink big.png)
		const [p1, p2] = await Promise.all([
			call("GET", `/sessions/${id}/files?path=big.png&max=300`),
			call("GET", `/sessions/${id}/files?path=big.png&max=300`),
		]);
		expect(p1.status).toBe(200);
		expect(p2.status).toBe(200);
		expect(p1.headers["content-type"]).toBe("image/jpeg");
		expect(p1.body.byteLength).toBeLessThan(big.byteLength / 3);
		expect(p1.headers.etag).not.toBe(origEtag);

		const pNotMod = await call("GET", `/sessions/${id}/files?path=big.png&max=300`, undefined, { "if-none-match": String(p1.headers.etag) });
		expect(pNotMod.status).toBe(304);

		// Small PNG and SVG are returned unmodified even with ?max=
		const smallRes = await call("GET", `/sessions/${id}/files?path=small.png&max=300`);
		expect(smallRes.status).toBe(200);
		expect(smallRes.body.byteLength).toBe(small.byteLength);

		const svgRes = await call("GET", `/sessions/${id}/files?path=icon.svg&max=300`);
		expect(svgRes.status).toBe(200);
		expect(svgRes.headers["content-type"]).toBe("image/svg+xml");
		expect(svgRes.body.byteLength).toBe(svg.byteLength);

		// Large (>4 MB) unshrinkable raw fallback does not blow away existing cached previews
		const hugeRaw = Buffer.alloc(5 * 1024 * 1024, 0xaa);
		writeFileSync(join(ws, "corrupt.png"), hugeRaw);
		const corruptRes = await call("GET", `/sessions/${id}/files?path=corrupt.png&max=300`);
		expect(corruptRes.status).toBe(200);
		expect(corruptRes.body.byteLength).toBe(hugeRaw.byteLength);
		const stillCached = await call("GET", `/sessions/${id}/files?path=big.png&max=300`, undefined, { "if-none-match": String(p1.headers.etag) });
		expect(stillCached.status).toBe(304);
	});

	test("file route supports Accept-Ranges, 206 Partial Content slices, and 416 for unsatisfiable ranges", async () => {
		const id = (await call("POST", "/sessions", { cwd: ws })).json.id as string;
		const data = Buffer.from("0123456789abcdefghij");
		writeFileSync(join(ws, "clip.bin"), data);

		const full = await call("GET", `/sessions/${id}/files?path=clip.bin`);
		expect(full.status).toBe(200);
		expect(full.headers["accept-ranges"]).toBe("bytes");
		expect(full.body.toString()).toBe("0123456789abcdefghij");

		const mid = await call("GET", `/sessions/${id}/files?path=clip.bin`, undefined, { range: "bytes=4-9" });
		expect(mid.status).toBe(206);
		expect(mid.headers["content-range"]).toBe("bytes 4-9/20");
		expect(mid.headers["content-length"]).toBe("6");
		expect(mid.body.toString()).toBe("456789");

		const tail = await call("GET", `/sessions/${id}/files?path=clip.bin`, undefined, { range: "bytes=-5" });
		expect(tail.status).toBe(206);
		expect(tail.headers["content-range"]).toBe("bytes 15-19/20");
		expect(tail.body.toString()).toBe("fghij");

		const open = await call("GET", `/sessions/${id}/files?path=clip.bin`, undefined, { range: "bytes=17-" });
		expect(open.status).toBe(206);
		expect(open.headers["content-range"]).toBe("bytes 17-19/20");
		expect(open.body.toString()).toBe("hij");

		const oob = await call("GET", `/sessions/${id}/files?path=clip.bin`, undefined, { range: "bytes=100-200" });
		expect(oob.status).toBe(416);
		expect(oob.headers["content-range"]).toBe("bytes */20");
	});
});
