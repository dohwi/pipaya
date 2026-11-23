import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as photon from "@silvia-odwyer/photon-node";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { assistantMessageText, extractAssistantImagePaths, normalizeMediaPath, SessionMedia } from "../src/session-media.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

function noisePng(w: number, h: number): Buffer {
	const px = new Uint8Array(w * h * 4);
	let x = 424242;
	for (let i = 0; i < px.length; i += 4) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		px[i] = x >>> 8;
		px[i + 1] = x >>> 16;
		px[i + 2] = x >>> 24;
		px[i + 3] = 255;
	}
	const img = new photon.PhotonImage(px, w, h);
	try {
		return Buffer.from(img.get_bytes());
	} finally {
		img.free();
	}
}

describe("extractAssistantImagePaths & normalizeMediaPath", () => {
	test("extracts local image links and skips code blocks, remote URLs, traversal, and non-images", () => {
		const md = [
			"Here are the shots:",
			"![one](./tmp/shots/a.png?v=1#top)",
			"[two](tmp/shots/my%20pic.jpg)",
			"[![dup](tmp/shots/a.png)](tmp/shots/a.png)",
			'![titled](<tmp/shots/with space.webp> "caption")',
			"![abs](/var/tmp/chart.png)",
			"![fileurl](file:///var/tmp/other.svg)",
			"![remote](https://example.com/pic.png)",
			"![escape](../secret.png)",
			"[doc](tmp/report.pdf)",
			"inline `![fake](tmp/inline-code.png)` text",
			"```md",
			"![fenced](tmp/fenced-code.png)",
			"```",
		].join("\n");

		expect(extractAssistantImagePaths(md)).toEqual([
			"tmp/shots/a.png",
			"tmp/shots/my pic.jpg",
			"tmp/shots/with space.webp",
			"/var/tmp/chart.png",
			"/var/tmp/other.svg",
		]);
		expect(extractAssistantImagePaths("")).toEqual([]);
		expect(normalizeMediaPath("./tmp/a.png?max=10#x")).toBe("tmp/a.png");
		expect(assistantMessageText({ role: "user", content: "![u](a.png)" })).toBe("");
		expect(assistantMessageText({ role: "assistant", content: [{ type: "text", text: "![a](x.png)" }] })).toBe("![a](x.png)");
	});
});

describe("SessionMedia unit", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-session-media-unit-"));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("downscales large images, keeps small images, cleans old extension, and deletes cleanly", async () => {
		const root = join(dir, "store");
		const work = join(dir, "work");
		mkdirSync(join(work, "tmp"), { recursive: true });
		const big = Buffer.alloc(150 * 1024, 0xaa);
		const small = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
		writeFileSync(join(work, "tmp/big.png"), big);
		writeFileSync(join(work, "tmp/small.svg"), small);

		const alive = new Set(["s1"]);
		let shrinkToJpg = true;
		const media = new SessionMedia(root, (id) => alive.has(id), {
			minResizeBytes: 1024,
			preview: async () =>
				shrinkToJpg
					? { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg" }
					: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" },
		});

		await media.captureFromText("s1", [work], "![b](tmp/big.png) ![s](tmp/small.svg)");
		const resolvedBig = await media.resolve("s1", "./tmp/big.png");
		expect(resolvedBig).not.toBeNull();
		expect(resolvedBig!.endsWith(".jpg")).toBe(true);
		const resolvedSmall = await media.resolve("s1", "tmp/small.svg");
		expect(resolvedSmall).not.toBeNull();
		expect(resolvedSmall!.endsWith(".svg")).toBe(true);

		// Re-capturing the same path with a different output extension removes the previous extension file.
		shrinkToJpg = false;
		await media.captureFromText("s1", [work], "![b](tmp/big.png)");
		const resolvedBig2 = await media.resolve("s1", "tmp/big.png");
		expect(resolvedBig2!.endsWith(".png")).toBe(true);
		expect(readdirSync(join(root, "s1")).filter((f) => f.endsWith(".jpg"))).toEqual([]);

		// Unsafe session IDs are ignored.
		expect(await media.resolve("../s1", "tmp/big.png")).toBeNull();

		// Delete removes the entire session folder.
		alive.delete("s1");
		await media.delete("s1");
		expect(existsSync(join(root, "s1"))).toBe(false);
		expect(await media.resolve("s1", "tmp/big.png")).toBeNull();
	});

	test("delete mid-flight prevents resurrecting the session directory", async () => {
		const root = join(dir, "store-midflight");
		const work = join(dir, "work-midflight");
		mkdirSync(work, { recursive: true });
		writeFileSync(join(work, "shot.png"), Buffer.alloc(4096, 1));

		const alive = new Set(["s-race"]);
		let releasePreview!: () => void;
		const previewGate = new Promise<void>((r) => (releasePreview = r));

		const media = new SessionMedia(root, (id) => alive.has(id), {
			minResizeBytes: 100,
			preview: async () => {
				await previewGate;
				return { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" };
			},
		});

		const capturePromise = media.captureFromText("s-race", [work], "![](shot.png)");
		// Delete while preview worker is still running.
		alive.delete("s-race");
		await media.delete("s-race");
		releasePreview();
		await capturePromise;

		expect(existsSync(join(root, "s-race"))).toBe(false);
	});

	test("fork preserves snapshots independently when the source session is deleted", async () => {
		const root = join(dir, "store-fork");
		const work = join(dir, "work-fork");
		mkdirSync(work, { recursive: true });
		writeFileSync(join(work, "chart.png"), Buffer.from("png-bytes"));

		const alive = new Set(["parent", "child"]);
		const media = new SessionMedia(root, (id) => alive.has(id), { minResizeBytes: 1024 * 1024 });

		await media.captureFromText("parent", [work], "![](chart.png)");
		await media.fork("parent", "child");
		alive.delete("parent");
		await media.delete("parent");

		expect(await media.resolve("parent", "chart.png")).toBeNull();
		const childFile = await media.resolve("child", "chart.png");
		expect(childFile).not.toBeNull();
		expect(existsSync(childFile!)).toBe(true);
	});
});

describe("SessionMedia integration with /sessions/:id/files", () => {
	let dir: string;
	let app: App;
	let upstream: EchoUpstream;
	const token = "session-media-test-token";
	const auth = { authorization: `Bearer ${token}` };

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-session-media-int-"));
		mkdirSync(join(dir, "work/tmp"), { recursive: true });
		upstream = startEchoUpstream();
		const cfg: Config = {
			host: "127.0.0.1",
			port: 0,
			token,
			dataDir: join(dir, "data"),
			dbPath: join(dir, "data/pipaya.db"),
			workspaceRoot: join(dir, "work"),
			restrictWorkspace: false,
			logLevel: "silent",
		};
		app = await buildApp(cfg, { home: dir });
		const prov = await app.server.inject({
			method: "PUT",
			url: "/configuration/providers/echo",
			headers: auth,
			payload: echoProviderBody(upstream.baseUrl),
		});
		expect(prov.statusCode).toBe(200);
	});

	afterAll(async () => {
		await app.close();
		upstream.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("serves original while present, falls back to downscaled snapshot after file deletion, survives fork, and cleans up on session delete", async () => {
		const original = noisePng(700, 700);
		expect(original.byteLength).toBeGreaterThan(100 * 1024);
		const imgFile = join(dir, "work/tmp/demo.png");
		writeFileSync(imgFile, original);

		const created = await app.server.inject({
			method: "POST",
			url: "/sessions",
			headers: auth,
			payload: { cwd: join(dir, "work"), provider: "echo", model: ECHO_MODEL.id },
		});
		const sessionId = created.json().id as string;

		// Simulate an assistant message referencing tmp/demo.png via the event bus (as SessionManager does on message_end).
		app.bus.publish(sessionId, "message_end", {
			seq: 1,
			message: { role: "assistant", content: [{ type: "text", text: "Done: ![demo](tmp/demo.png)" }] },
		});

		// Wait briefly for the async snapshot capture to land under <dataDir>/session-media/<sessionId>.
		const mediaDir = join(dir, "data/session-media", sessionId);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (existsSync(mediaDir) && readdirSync(mediaDir).some((f) => !f.endsWith(".tmp"))) break;
			await new Promise((r) => setTimeout(r, 30));
		}
		expect(existsSync(mediaDir)).toBe(true);

		// 1. While the original exists, requesting without `max` returns the exact original bytes.
		const liveFull = await app.server.inject({
			method: "GET",
			url: `/sessions/${sessionId}/files?path=${encodeURIComponent("tmp/demo.png")}`,
			headers: auth,
		});
		expect(liveFull.statusCode).toBe(200);
		expect(liveFull.headers["content-type"]).toBe("image/png");
		expect(liveFull.rawPayload.byteLength).toBe(original.byteLength);

		// 2. Delete the original file (as when tmp/ or a worktree is cleaned up).
		rmSync(imgFile);

		// Requesting the deleted file now falls back to the downscaled archived snapshot.
		const fallback = await app.server.inject({
			method: "GET",
			url: `/sessions/${sessionId}/files?path=${encodeURIComponent("tmp/demo.png")}`,
			headers: auth,
		});
		expect(fallback.statusCode).toBe(200);
		expect(fallback.headers["content-type"]).toBe("image/jpeg");
		expect(fallback.rawPayload.byteLength).toBeLessThan(original.byteLength);

		// Inline `?max=400` also works against the fallback snapshot.
		const fallbackSmall = await app.server.inject({
			method: "GET",
			url: `/sessions/${sessionId}/files?path=${encodeURIComponent("tmp/demo.png")}&max=400`,
			headers: auth,
		});
		expect(fallbackSmall.statusCode).toBe(200);
		expect(fallbackSmall.headers["content-type"]).toBe("image/jpeg");

		// 3. Forking copies the snapshot so the forked session keeps serving it after the parent is deleted.
		const forked = await app.server.inject({
			method: "POST",
			url: `/sessions/${sessionId}/fork`,
			headers: auth,
			payload: {},
		});
		const forkId = forked.json().id as string;
		const forkMediaDir = join(dir, "data/session-media", forkId);
		const forkDeadline = Date.now() + 5_000;
		while (Date.now() < forkDeadline) {
			if (existsSync(forkMediaDir) && readdirSync(forkMediaDir).length > 0) break;
			await new Promise((r) => setTimeout(r, 20));
		}

		// 4. Delete the original session and verify its snapshot folder is removed.
		const del = await app.server.inject({ method: "DELETE", url: `/sessions/${sessionId}`, headers: auth });
		expect(del.statusCode).toBe(204);
		const delDeadline = Date.now() + 5_000;
		while (Date.now() < delDeadline && existsSync(mediaDir)) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(existsSync(mediaDir)).toBe(false);

		// Forked session still serves the snapshot.
		const forkRes = await app.server.inject({
			method: "GET",
			url: `/sessions/${forkId}/files?path=${encodeURIComponent("tmp/demo.png")}`,
			headers: auth,
		});
		expect(forkRes.statusCode).toBe(200);
		expect(forkRes.headers["content-type"]).toBe("image/jpeg");

		// Delete forked session too -> cleans up its media folder.
		await app.server.inject({ method: "DELETE", url: `/sessions/${forkId}`, headers: auth });
		const forkDelDeadline = Date.now() + 5_000;
		while (Date.now() < forkDelDeadline && existsSync(forkMediaDir)) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(existsSync(forkMediaDir)).toBe(false);
	});
});
