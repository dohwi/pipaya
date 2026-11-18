import type { Server } from "node:http";
import type { Socket } from "node:net";

/** A little past Node's own keep-alive default (Fastify sets 72 s), so a client reusing a socket is never cut mid-reuse. */
export const IDLE_SOCKET_MS = 75_000;

type Tracked = { busy: number; idleSince: number };

/**
 * Closes keep-alive sockets that sit with no request in flight. Under Bun `server.keepAliveTimeout` and socket timeouts
 * are not applied, so every device that went to sleep or off the network leaves its sockets open for the server's life.
 * A socket with a request still running (a long poll, an SSE stream, an upgraded WebSocket) is never touched.
 */
export class IdleSockets {
	private sockets = new Map<Socket, Tracked>();
	private sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly idleMs = IDLE_SOCKET_MS,
		private readonly now: () => number = Date.now,
	) {}

	attach(server: Server): void {
		server.on("connection", (socket: Socket) => {
			this.sockets.set(socket, { busy: 0, idleSince: this.now() });
			socket.once("close", () => this.sockets.delete(socket));
		});
	}

	/** Call at the start of every request; the socket counts as busy until the request's connection side closes. */
	requestStarted(socket: Socket, done: { once(event: "close", fn: () => void): unknown }): void {
		let t = this.sockets.get(socket);
		if (!t) {
			t = { busy: 0, idleSince: this.now() };
			this.sockets.set(socket, t);
		}
		const tracked = t;
		tracked.busy++;
		done.once("close", () => {
			tracked.busy = Math.max(0, tracked.busy - 1);
			tracked.idleSince = this.now();
		});
	}

	sweep(): number {
		const now = this.now();
		let closed = 0;
		for (const [socket, t] of this.sockets) {
			if (socket.destroyed) {
				this.sockets.delete(socket);
				continue;
			}
			if (t.busy === 0 && now - t.idleSince >= this.idleMs) {
				this.sockets.delete(socket);
				socket.destroy();
				closed++;
			}
		}
		return closed;
	}

	start(everyMs = 15_000): void {
		clearInterval(this.sweeper);
		this.sweeper = setInterval(() => this.sweep(), everyMs);
		this.sweeper.unref?.();
	}

	stop(): void {
		clearInterval(this.sweeper);
		this.sweeper = undefined;
	}

	get size(): number {
		return this.sockets.size;
	}
}
