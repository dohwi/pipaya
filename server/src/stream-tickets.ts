import { createHash, randomBytes } from "node:crypto";

/**
 * One-time tickets for the connections a browser opens without headers (EventSource, WebSocket).
 *
 * Those two cannot send `Authorization`, so the credential has to ride in the URL, and a URL is what a reverse proxy,
 * a tunnel or a browser history keeps. The access token must not end up there: it never expires. A client asks for a
 * ticket over an authenticated request instead and puts that in the URL. A ticket opens one connection, within half a
 * minute, and is worth nothing afterwards. It stands for whoever asked: the admin, or one paired device.
 *
 * `?token=` is still accepted on those paths for clients from before this existed.
 */
export const STREAM_TICKET_TTL_MS = 30_000;
/** A client opens a handful at once (the event stream, a few terminals); the oldest make room past this. */
export const MAX_STREAM_TICKETS = 500;

/** Who a ticket stands for: the admin token, or the paired device with this id. */
export type TicketHolder = { device: string | null };

const digest = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

export class StreamTickets {
	/** sha256(ticket) -> holder and expiry. Only the hash is kept, in memory: a restart invalidates every ticket. */
	private tickets = new Map<string, { holder: TicketHolder; expires: number }>();

	constructor(private now: () => number = Date.now) {}

	private sweep() {
		const t = this.now();
		for (const [k, v] of this.tickets) if (v.expires <= t) this.tickets.delete(k);
	}

	issue(holder: TicketHolder): { ticket: string; expiresAt: number } {
		this.sweep();
		while (this.tickets.size >= MAX_STREAM_TICKETS) this.tickets.delete(this.tickets.keys().next().value as string);
		const ticket = randomBytes(24).toString("base64url");
		const expiresAt = this.now() + STREAM_TICKET_TTL_MS;
		this.tickets.set(digest(ticket), { holder, expires: expiresAt });
		return { ticket, expiresAt };
	}

	/** Who the ticket stands for, or null. The ticket is spent either way. */
	redeem(ticket: string | undefined): TicketHolder | null {
		if (!ticket || ticket.length > 128) return null;
		const key = digest(ticket);
		const entry = this.tickets.get(key);
		if (!entry) return null;
		this.tickets.delete(key);
		return entry.expires > this.now() ? entry.holder : null;
	}

	/** A revoked device must not keep a way in: drop the tickets it asked for. */
	revokeDevice(id: string) {
		for (const [k, v] of this.tickets) if (v.holder.device === id) this.tickets.delete(k);
	}
}
