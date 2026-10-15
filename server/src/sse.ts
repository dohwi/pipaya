import type { FastifyReply, FastifyRequest } from "fastify";
import type { EventBus, HarnessEvent } from "./events.ts";
import type { CorsPolicy } from "./security.ts";

const HEARTBEAT_MS = 15_000;
const REPLAY_LIMIT = 5000;

export const encodeSse = (e: HarnessEvent): string =>
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
	opts: { sessionId?: string; types?: Set<string>; corsPolicy: CorsPolicy },
): void {
	const query = req.query as { after?: string };
	const header = req.headers["last-event-id"];
	const afterRaw = query.after ?? (Array.isArray(header) ? header[0] : header);
	const after = afterRaw !== undefined && afterRaw !== "" ? Number.parseInt(afterRaw, 10) : undefined;

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

	let lastSent = after ?? 0;
	let replaying = after !== undefined;
	const buffered: HarnessEvent[] = [];
	const wants = (e: HarnessEvent) => !opts.types || opts.types.has(e.type);

	const send = (e: HarnessEvent) => {
		if (!wants(e)) return;
		if (e.id !== 0) {
			if (e.id <= lastSent) return;
			lastSent = e.id;
		}
		res.write(encodeSse(e));
	};

	const unsubscribe = bus.subscribe((e) => (replaying ? buffered.push(e) : send(e)), opts.sessionId);

	if (after !== undefined) {
		let cursor = after;
		for (;;) {
			const batch = bus.history({ sessionId: opts.sessionId, after: cursor, limit: 500 });
			for (const e of batch) send(e);
			if (batch.length < 500) break;
			cursor = batch[batch.length - 1]!.id;
			if (cursor - after > REPLAY_LIMIT) break;
		}
		replaying = false;
		for (const e of buffered.splice(0)) send(e);
	}

	const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
	const close = () => {
		clearInterval(heartbeat);
		unsubscribe();
	};
	req.raw.on("close", close);
	res.on("error", close);
}
