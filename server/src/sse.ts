import type { FastifyReply, FastifyRequest } from "fastify";
import type { EventBus, PipayaEvent } from "./events.ts";
import type { CorsPolicy } from "./security.ts";

const HEARTBEAT_MS = 15_000;
const REPLAY_LIMIT = 5000;
const REPLAY_DRAIN_TIMEOUT_MS = 15_000;
/** A client this far behind (bytes queued in the socket, not yet sent) is cut off; it reconnects and replays from its cursor, like the WebSocket's limit. */
export const SSE_MAX_BUFFERED = 16 * 1024 * 1024;

export const encodeSse = (e: PipayaEvent): string =>
	`${e.id ? `id: ${e.id}\n` : ""}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/**
 * Stream events as Server-Sent Events.
 *
 * Reconnect: the browser's EventSource sends `Last-Event-ID` automatically; other clients may
 * pass `?after=<id>`. Persisted events after that cursor are replayed before going live.
 * With neither, the stream starts live ("tail -f" semantics).
 *
 * Subscribing before replaying, and de-duplicating by id, guarantees no gap and no duplicate.
 */
export function streamEvents(
	req: FastifyRequest,
	reply: FastifyReply,
	bus: EventBus,
	opts: { sessionId?: string; types?: Set<string>; corsPolicy: CorsPolicy; maxBuffered?: number; drainTimeoutMs?: number },
): void {
	const query = req.query as { after?: string };
	const header = req.headers["last-event-id"];
	const afterRaw = query.after ?? (Array.isArray(header) ? header[0] : header);
	const after = afterRaw !== undefined && afterRaw !== "" ? Number.parseInt(afterRaw, 10) : undefined;
	const limit = opts.maxBuffered ?? SSE_MAX_BUFFERED;
	const drainTimeoutMs = opts.drainTimeoutMs ?? REPLAY_DRAIN_TIMEOUT_MS;

	reply.hijack();
	const res = reply.raw;
	const origin = req.headers.origin as string | undefined;
	res.writeHead(200, {
		...(origin && opts.corsPolicy.allows(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write("retry: 2000\n\n");

	let closed = false;
	let unsubscribe = () => {};
	function close(end = false) {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		unsubscribe();
		if (end === true) res.destroy(); // too slow: drop the queue instead of holding it in memory
	}
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let lastSent = after ?? 0;
	let replaying = after !== undefined;
	const buffered: PipayaEvent[] = [];
	const wants = (e: PipayaEvent) => !opts.types || opts.types.has(e.type);

	const send = (e: PipayaEvent) => {
		if (closed || !wants(e)) return;
		if (e.id !== 0) {
			if (e.id <= lastSent) return;
			lastSent = e.id;
		}
		const before = res.writableLength;
		res.write(encodeSse(e));
		// Allow a single large event written into an empty socket to drain; cut off once more piles onto an un-drained queue.
		if (before > 0 && res.writableLength > limit) close(true);
	};

	const waitDrain = (): Promise<boolean> =>
		new Promise((resolve) => {
			if (closed || res.writableLength === 0) {
				resolve(!closed);
				return;
			}
			const cleanup = () => {
				clearTimeout(timer);
				res.off("drain", onDrain);
				req.raw.off("close", onClose);
				res.off("close", onClose);
				res.off("error", onClose);
			};
			const onDrain = () => {
				cleanup();
				resolve(!closed);
			};
			const onClose = () => {
				cleanup();
				resolve(false);
			};
			const timer = setTimeout(() => {
				cleanup();
				close(true);
				resolve(false);
			}, drainTimeoutMs);
			timer.unref?.();
			res.once("drain", onDrain);
			req.raw.once("close", onClose);
			res.once("close", onClose);
			res.once("error", onClose);
		});

	const replayOne = async (e: PipayaEvent): Promise<boolean> => {
		if (closed || !wants(e)) return !closed;
		if (e.id !== 0 && e.id <= lastSent) return true;
		const chunk = encodeSse(e);
		if (res.writableLength > 0 && res.writableLength + Buffer.byteLength(chunk) > limit) {
			if (!(await waitDrain())) return false;
		}
		if (closed) return false;
		if (e.id !== 0) {
			if (e.id <= lastSent) return true;
			lastSent = e.id;
		}
		const ok = res.write(chunk);
		if ((!ok && res.writableLength >= limit / 2) || res.writableLength > limit) {
			if (!(await waitDrain())) return false;
		}
		return !closed;
	};

	unsubscribe = bus.subscribe((e) => (replaying ? buffered.push(e) : send(e)), opts.sessionId);

	if (after !== undefined) {
		void (async () => {
			let cursor = after;
			for (;;) {
				const batch = bus.history({ sessionId: opts.sessionId, after: cursor, limit: 500 });
				for (const e of batch) {
					if (!(await replayOne(e))) return;
				}
				if (closed || batch.length < 500) break;
				cursor = batch[batch.length - 1]!.id;
				if (cursor - after > REPLAY_LIMIT) break;
			}
			while (buffered.length > 0) {
				for (const e of buffered.splice(0)) {
					if (!(await replayOne(e))) return;
				}
			}
			replaying = false;
		})();
	}

	heartbeat = setInterval(() => {
		if (!closed && res.writableLength === 0) res.write(`: ping ${Date.now()}\n\n`);
	}, HEARTBEAT_MS);
	if (closed) clearInterval(heartbeat);
	req.raw.on("close", () => close());
	res.on("error", () => close());
}
