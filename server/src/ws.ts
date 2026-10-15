import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { ApprovalManager } from "./approvals.ts";
import type { QuestionManager } from "./questions.ts";
import { HttpError, parse } from "./errors.ts";
import type { EventBus } from "./events.ts";
import type { SessionManager } from "./sessions.ts";

/**
 * WebSocket protocol (JSON text frames), a bidirectional alternative to REST + SSE.
 *
 * client -> server   { id?, op, ...args }
 *   subscribe        { sessionId?: string, after?: number, types?: string[] }   (omit sessionId = all sessions)
 *   unsubscribe      { sessionId?: string }
 *   prompt           { sessionId, text, mode?: "prompt"|"steer"|"follow_up", images? }
 *   abort            { sessionId }
 *   approve          { sessionId, toolCallId, approved, reason? }
 *   ping             {}
 *
 * server -> client
 *   { type: "ack", id, ok: true, result? } | { type: "ack", id, ok: false, error: { code, message } }
 *   { type: "event", event: PipayaEvent }
 *   { type: "hello", subscriptions: [...] }   on connect
 *
 * Liveness: the server sends a protocol ping every 30 s and drops a socket that missed the previous one (browsers answer on
 * their own). A client that falls more than 8 MB behind is closed with 1013; reconnect and `subscribe` with `after` to replay.
 */

const Subscribe = Type.Object({
	sessionId: Type.Optional(Type.String()),
	after: Type.Optional(Type.Integer({ minimum: 0 })),
	types: Type.Optional(Type.Array(Type.String())),
});
const Unsubscribe = Type.Object({ sessionId: Type.Optional(Type.String()) });
const Prompt = Type.Object({
	sessionId: Type.String(),
	text: Type.String({ minLength: 1 }),
	mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("follow_up")])),
	images: Type.Optional(Type.Array(Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }), { maxItems: 8 })),
});
const Abort = Type.Object({ sessionId: Type.String() });
const Approve = Type.Object({
	sessionId: Type.String(),
	toolCallId: Type.String(),
	approved: Type.Boolean(),
	reason: Type.Optional(Type.String()),
});

const Answer = Type.Object({ sessionId: Type.String(), toolCallId: Type.String(), answer: Type.String({ minLength: 1, maxLength: 10_000 }) });

const ALL = "*";

/** A protocol ping every 30 s; a socket that has not answered the previous one by the next tick is dead (phone asleep, network gone). */
export const HEARTBEAT_MS = 30_000;
/**
 * A client this far behind (bytes queued in the socket, not yet sent) cannot keep up: drop it and let it reconnect with its
 * replay cursor, instead of buffering every token of every session in memory.
 */
export const MAX_BUFFERED = 8 * 1024 * 1024;

export interface WebSocketOptions {
	heartbeatMs?: number;
	maxBuffered?: number;
}

export async function registerWebSocket(
	server: FastifyInstance,
	deps: { bus: EventBus; sessions: SessionManager; approvals: ApprovalManager; questions: QuestionManager },
	opts: WebSocketOptions = {},
): Promise<void> {
	const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
	const maxBuffered = opts.maxBuffered ?? MAX_BUFFERED;
	await server.register(websocket, { options: { maxPayload: 25 * 1024 * 1024 } });

	server.get("/ws", { websocket: true }, (socket, req) => {
		// Token was already checked by the global onRequest hook (header or ?token=).
		const subs = new Map<string, { unsubscribe: () => void }>();
		const send = (msg: unknown) => {
			if (socket.readyState !== socket.OPEN) return;
			if (socket.bufferedAmount > maxBuffered) {
				req.log.warn({ buffered: socket.bufferedAmount }, "websocket client too slow, closing");
				socket.close(1013, "client too slow"); // 1013 try again later: reconnect and replay from the cursor
				return;
			}
			socket.send(JSON.stringify(msg));
		};

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
		}, heartbeatMs);
		heartbeat.unref?.();

		const subscribe = (sessionId: string | undefined, after: number | undefined, types?: string[]) => {
			const key = sessionId ?? ALL;
			subs.get(key)?.unsubscribe();
			const wanted = types?.length ? new Set(types) : undefined;

			let lastSent = after ?? 0;
			let replaying = after !== undefined;
			const buffered: Parameters<Parameters<EventBus["subscribe"]>[0]>[0][] = [];
			const emit = (e: (typeof buffered)[number]) => {
				if (wanted && !wanted.has(e.type)) return;
				if (e.id !== 0) {
					if (e.id <= lastSent) return;
					lastSent = e.id;
				}
				send({ type: "event", event: e });
			};
			const unsubscribe = deps.bus.subscribe((e) => (replaying ? buffered.push(e) : emit(e)), sessionId);
			if (after !== undefined) {
				// The cursor must advance on every row read, including ones `emit` filters out;
				// otherwise a batch of all-filtered events is re-read forever.
				let cursor = after;
				for (;;) {
					const batch = deps.bus.history({ sessionId, after: cursor, limit: 500 });
					batch.forEach(emit);
					if (batch.length < 500) break;
					cursor = batch[batch.length - 1]!.id;
				}
				replaying = false;
				buffered.splice(0).forEach(emit);
			}
			subs.set(key, { unsubscribe });
		};

		const handlers: Record<string, (m: Record<string, unknown>) => Promise<unknown> | unknown> = {
			ping: () => ({ pong: Date.now() }),
			subscribe: (m) => {
				const a = parse(Subscribe, m);
				if (a.sessionId) deps.sessions.get(a.sessionId);
				subscribe(a.sessionId, a.after, a.types);
				return { subscribed: a.sessionId ?? ALL, latestId: deps.bus.latestId() };
			},
			unsubscribe: (m) => {
				const a = parse(Unsubscribe, m);
				const key = a.sessionId ?? ALL;
				subs.get(key)?.unsubscribe();
				subs.delete(key);
				return { unsubscribed: key };
			},
			prompt: async (m) => {
				const a = parse(Prompt, m);
				return deps.sessions.send(a.sessionId, a);
			},
			abort: (m) => ({ aborted: deps.sessions.abort(parse(Abort, m).sessionId) }),
			approve: (m) => {
				const a = parse(Approve, m);
				if (!deps.approvals.decide(a.sessionId, a.toolCallId, { approved: a.approved, reason: a.reason })) {
					throw new HttpError(404, "not_found", "pending approval not found");
				}
				return { ok: true };
			},
			answer: (m) => {
				const a = parse(Answer, m);
				const r = deps.questions.answer(a.sessionId, a.toolCallId, { answer: a.answer });
				if (r === "not_found") throw new HttpError(404, "not_found", "pending question not found");
				if (r === "invalid") throw new HttpError(400, "invalid_request", "the answer is empty or not one of the options");
				return { ok: true };
			},
		};

		socket.on("message", async (raw: Buffer) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(raw.toString());
				if (typeof msg !== "object" || msg === null || Array.isArray(msg)) throw new Error();
			} catch {
				return send({ type: "ack", ok: false, error: { code: "invalid_request", message: "frame must be a JSON object" } });
			}
			const id = msg.id;
			const handler = typeof msg.op === "string" ? handlers[msg.op] : undefined;
			if (!handler) {
				return send({ type: "ack", id, ok: false, error: { code: "unknown_op", message: `unknown op "${String(msg.op)}"` } });
			}
			try {
				send({ type: "ack", id, ok: true, result: await handler(msg) });
			} catch (e) {
				const err = e instanceof HttpError ? e : new HttpError(500, "internal_error", "internal server error");
				if (!(e instanceof HttpError)) req.log.error(e);
				send({ type: "ack", id, ok: false, error: { code: err.code, message: err.message } });
			}
		});

		const cleanup = () => {
			clearInterval(heartbeat);
			for (const s of subs.values()) s.unsubscribe();
			subs.clear();
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
		send({ type: "hello", subscriptions: [] });
	});
}
