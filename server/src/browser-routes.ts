import type { FastifyInstance } from "fastify";
import { IdParams, Ok, errors } from "./schemas.ts";
import { BrowserProfileList, BrowserProfileSchema, BrowserSupport, BrowserTabList, BrowserTabSchema, CreateBrowserBody, CreateProfileBody, DEFAULT_PROFILE, NavigateBrowserBody, PatchProfileBody, type BrowserInput, type BrowserManager } from "./browser.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Path of a tab's view socket; the auth hook lets browsers pass the token as ?token= here. */
export const BROWSER_SOCKET = /^\/browsers\/[^/]+\/ws$/;

const NAV = new Set(["back", "forward", "reload"]);

function parseInput(msg: Record<string, unknown>): BrowserInput | null {
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	if (msg.type === "mouse") {
		const x = num(msg.x), y = num(msg.y);
		if (x === null || y === null || !["move", "down", "up"].includes(msg.action as string)) return null;
		const button = ["left", "middle", "right"].includes(msg.button as string) ? (msg.button as "left" | "middle" | "right") : undefined;
		return { type: "mouse", action: msg.action as "move" | "down" | "up", x, y, button, clickCount: num(msg.clickCount) ?? undefined };
	}
	if (msg.type === "wheel") {
		const x = num(msg.x), y = num(msg.y), dx = num(msg.dx), dy = num(msg.dy);
		return x === null || y === null || dx === null || dy === null ? null : { type: "wheel", x, y, dx, dy };
	}
	if (msg.type === "key") {
		if (typeof msg.key !== "string" || !["down", "up"].includes(msg.action as string)) return null;
		return { type: "key", action: msg.action as "down" | "up", key: msg.key, code: typeof msg.code === "string" ? msg.code : undefined, text: typeof msg.text === "string" ? msg.text : undefined, modifiers: num(msg.modifiers) ?? 0 };
	}
	if (msg.type === "text" && typeof msg.text === "string" && msg.text.length <= 100_000) return { type: "text", text: msg.text };
	return null;
}

/**
 * REST for browser tabs, plus one WebSocket per attached view:
 *
 * server -> client   text    { type: "hello", tab, control }
 *                    binary  one JPEG frame of the page
 *                    text    { type: "frame", width, height }  sent right before each binary frame (page size in CSS px)
 *                    text    { type: "state", tab, control, by }   title / address changed, or control moved ("user" | "agent"; `by` = the session whose agent acts; `handoff` = {by, note} while an agent waits for the person to finish something in the page)
 *                    text    { type: "closed" }
 * client -> server   text    { type: "mouse" | "wheel" | "key" | "text", ... }   input for the page
 *                    text    { type: "fit", width, height }    the panel's size: the page is laid out for it
 *                    text    { type: "navigate", to }          an address, or "back" | "forward" | "reload"
 *
 * Needs @fastify/websocket registered first (see ws.ts).
 */
export function registerBrowserRoutes(server: FastifyInstance, browsers: BrowserManager): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/browsers/info", {
		schema: { response: { 200: BrowserSupport, ...errors(401) } },
		handler: async () => browsers.support(),
	});
	app.get("/browsers", {
		schema: { response: { 200: BrowserTabList, ...errors(401) } },
		handler: async () => ({ tabs: browsers.list() }),
	});
	// Profiles: a profile is a browser's saved logins and cookies. Only names and flags travel here, never their contents.
	app.get("/browsers/profiles", {
		schema: { response: { 200: BrowserProfileList, ...errors(401) } },
		handler: async () => ({ profiles: browsers.listProfiles(), default: DEFAULT_PROFILE }),
	});
	app.post("/browsers/profiles", {
		schema: { body: CreateProfileBody, response: { 201: BrowserProfileSchema, ...errors(400, 401, 409) } },
		handler: async (req, reply) => reply.status(201).send(browsers.createProfile(req.body)),
	});
	app.patch("/browsers/profiles/:id", {
		schema: { params: IdParams, body: PatchProfileBody, response: { 200: BrowserProfileSchema, ...errors(400, 401, 404, 409) } },
		handler: async (req) => await browsers.updateProfile(req.params.id, req.body),
	});
	app.post("/browsers/profiles/:id/clear", {
		schema: { params: IdParams, response: { 200: Ok, ...errors(400, 401, 404) } },
		handler: async (req) => {
			await browsers.clearProfile(req.params.id);
			return { ok: true };
		},
	});
	app.delete("/browsers/profiles/:id", {
		schema: { params: IdParams, response: { 200: Ok, ...errors(400, 401, 404, 409) } },
		handler: async (req) => {
			await browsers.deleteProfile(req.params.id);
			return { ok: true };
		},
	});
	app.post("/browsers", {
		schema: { body: CreateBrowserBody, response: { 201: BrowserTabSchema, ...errors(400, 401, 403, 409, 502) } },
		handler: async (req, reply) => reply.status(201).send(await browsers.create(req.body ?? {})),
	});
	app.post("/browsers/:id/navigate", {
		schema: { params: IdParams, body: NavigateBrowserBody, response: { 200: BrowserTabSchema, ...errors(400, 401, 404) } },
		handler: async (req) => browsers.navigate(req.params.id, NAV.has(req.body.url) ? (req.body.url as "back") : req.body.url),
	});
	app.delete("/browsers/:id", {
		schema: { params: IdParams, response: { 200: Ok, ...errors(401, 404) } },
		handler: async (req) => {
			await browsers.close(req.params.id);
			return { ok: true };
		},
	});

	server.get("/browsers/:id/ws", { websocket: true }, (socket, req) => {
		const { id } = req.params as { id: string };
		const MAX_BUFFERED = 8 * 1024 * 1024;
		let control: "user" | "agent" = "user";
		let lastSize = { width: 0, height: 0 };
		const sendText = (o: unknown) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(o));
		let attached: ReturnType<BrowserManager["attach"]>;
		try {
			attached = browsers.attach(id, {
				frame(jpeg, size) {
					if (socket.readyState !== socket.OPEN) return;
					// A viewer that cannot keep up skips frames instead of queueing them.
					if (socket.bufferedAmount > MAX_BUFFERED / 4) return;
					if (size.width !== lastSize.width || size.height !== lastSize.height) {
						lastSize = size;
						sendText({ type: "frame", ...size });
					}
					socket.send(jpeg);
				},
				state(tab, c, by, handoff) {
					control = c;
					sendText({ type: "state", tab, control, by: by ?? null, handoff: handoff ?? null });
				},
				closed() {
					sendText({ type: "closed" });
					if (socket.readyState === socket.OPEN) socket.close(1000, "closed");
				},
			});
		} catch {
			sendText({ type: "closed", missing: true });
			socket.close(4404, "browser tab not found");
			return;
		}
		sendText({ type: "hello", tab: attached.info, control });

		socket.on("message", (raw: Buffer, isBinary: boolean) => {
			if (isBinary) return;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (msg.type === "navigate" && typeof msg.to === "string") {
				browsers.navigate(id, NAV.has(msg.to) ? (msg.to as "back") : msg.to).catch((e) => sendText({ type: "error", message: e instanceof Error ? e.message : String(e) }));
				return;
			}
			if (msg.type === "fit" && typeof msg.width === "number" && typeof msg.height === "number") {
				browsers.fit(id, msg.width, msg.height).catch(() => {});
				return;
			}
			const input = parseInput(msg);
			if (input) browsers.input(id, input).catch(() => {});
		});
		let alive = true;
		socket.on("pong", () => (alive = true));
		const heartbeat = setInterval(() => {
			if (!alive) return void socket.terminate();
			alive = false;
			try {
				socket.ping();
			} catch {
				socket.terminate();
			}
		}, 30_000);
		heartbeat.unref?.();
		const cleanup = () => {
			clearInterval(heartbeat);
			attached.detach();
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
	});
}
