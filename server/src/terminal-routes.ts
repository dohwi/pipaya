import type { FastifyInstance } from "fastify";
import { IdParams, Ok, errors } from "./schemas.ts";
import { CreateTerminalBody, PatchTerminalBody, TerminalList, TerminalSchema, TerminalSupport, type TerminalManager } from "./terminals.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Path of a terminal's I/O socket; the auth hook lets browsers pass the token as ?token= here. */
export const TERMINAL_SOCKET = /^\/terminals\/[^/]+\/ws$/;

/**
 * REST for terminals, plus one WebSocket per attached view:
 *
 * server -> client   text   { type: "hello", terminal }   then the kept output as one binary frame
 *                    binary  output bytes
 *                    text   { type: "exit", code }        the shell ended; the socket closes after it
 * client -> server   text   { type: "input", data } | { type: "resize", cols, rows }
 *
 * Needs @fastify/websocket registered first (see ws.ts).
 */
export function registerTerminalRoutes(server: FastifyInstance, terminals: TerminalManager): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/terminals/info", {
		schema: { response: { 200: TerminalSupport, ...errors(401) } },
		handler: async () => terminals.support(),
	});
	app.get("/terminals", {
		schema: { response: { 200: TerminalList, ...errors(401) } },
		handler: async () => ({ terminals: terminals.list() }),
	});
	app.post("/terminals", {
		schema: { body: CreateTerminalBody, response: { 201: TerminalSchema, ...errors(400, 401, 403, 409) } },
		handler: async (req, reply) => reply.status(201).send(terminals.create(req.body ?? {})),
	});
	app.patch("/terminals/:id", {
		schema: { params: IdParams, body: PatchTerminalBody, response: { 200: TerminalSchema, ...errors(400, 401, 404) } },
		handler: async (req) => terminals.rename(req.params.id, req.body.title),
	});
	app.delete("/terminals/:id", {
		schema: { params: IdParams, response: { 200: Ok, ...errors(401, 404) } },
		handler: async (req) => {
			terminals.kill(req.params.id);
			return { ok: true };
		},
	});

	server.get("/terminals/:id/ws", { websocket: true }, (socket, req) => {
		const { id } = req.params as { id: string };
		const MAX_BUFFERED = 4 * 1024 * 1024;
		let attached: ReturnType<TerminalManager["attach"]>;
		const sendBinary = (data: Uint8Array) => {
			if (socket.readyState !== socket.OPEN) return;
			// A viewer that cannot keep up re-attaches and gets the scrollback instead of an ever-growing queue.
			if (socket.bufferedAmount > MAX_BUFFERED) return void socket.close(1013, "client too slow");
			socket.send(data);
		};
		try {
			attached = terminals.attach(id, {
				output: sendBinary,
				exit: (code) => {
					if (socket.readyState !== socket.OPEN) return;
					socket.send(JSON.stringify({ type: "exit", code }));
					socket.close(1000, "exited");
				},
			});
		} catch {
			socket.send(JSON.stringify({ type: "exit", code: null, missing: true }));
			socket.close(4404, "terminal not found");
			return;
		}
		socket.send(JSON.stringify({ type: "hello", terminal: attached.info }));
		if (attached.scrollback.length) sendBinary(attached.scrollback);

		socket.on("message", (raw: Buffer, isBinary: boolean) => {
			if (isBinary) return void terminals.write(id, raw.toString("utf8"));
			let msg: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (msg.type === "input" && typeof msg.data === "string" && msg.data.length <= 1_000_000) terminals.write(id, msg.data);
			else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") terminals.resize(id, msg.cols, msg.rows);
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

