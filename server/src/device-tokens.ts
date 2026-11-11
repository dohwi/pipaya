import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Socket } from "node:net";

/**
 * One access token per paired device.
 *
 * Pairing used to hand every phone the server's single admin token, so a lost phone could only be locked out by
 * changing that token and re-pairing everything. Now each pairing mints its own token. Only its SHA-256 is stored
 * (a database leak yields nothing usable), and revoking it cuts that one device off, open streams included.
 * The admin token keeps working and is the only credential that can mint or revoke device tokens.
 *
 * A device that has not connected for a long time loses its access by itself (`PIPAYA_DEVICE_TOKEN_IDLE_DAYS`, 90 by
 * default, 0 = never): a phone that was sold or lost without being revoked must not stay a way in for ever. Pairing
 * it again takes one scan.
 */
export const DEVICE_TOKEN_PREFIX = "hdt_";
export const DEFAULT_DEVICE_TOKEN_IDLE_DAYS = 90;
const DAY_MS = 24 * 3600_000;
const LAST_USED_GRANULARITY_MS = 60_000;

export interface DeviceTokenInfo {
	id: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** A label is shown in a list: strip control characters and keep it short. */
export function cleanLabel(raw: string | undefined): string {
	const label = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
	return label || "Paired device";
}

export class DeviceTokens {
	/** device id -> its open connections (SSE, WebSocket), so revoking can hang them up */
	private sockets = new Map<string, Set<Socket>>();
	private touched = new Map<string, number>();

	/** `idleDays`: a token unused for this long stops working; 0 keeps it for ever. */
	constructor(private db: Database, private now: () => number = Date.now, private idleDays = DEFAULT_DEVICE_TOKEN_IDLE_DAYS) {}

	/** Forget the tokens of devices that have not connected (or, never having connected, were paired) for `idleDays`. */
	private expireIdle(): void {
		if (this.idleDays <= 0) return;
		const cutoff = this.now() - this.idleDays * DAY_MS;
		const stale = this.db.query("SELECT id FROM device_tokens WHERE COALESCE(last_used_at, created_at) <= ?").all(cutoff) as { id: string }[];
		for (const { id } of stale) this.revoke(id);
	}

	issue(name?: string): { id: string; token: string } {
		const id = randomBytes(8).toString("hex");
		const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
		this.db
			.query("INSERT INTO device_tokens (id, name, hash, created_at) VALUES (?, ?, ?, ?)")
			.run(id, cleanLabel(name), hashOf(token), this.now());
		return { id, token };
	}

	/** The device id a token belongs to, or null. */
	verify(token: string | undefined): string | null {
		if (!token || !token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 200) return null;
		const row = this.db.query("SELECT id, created_at, last_used_at FROM device_tokens WHERE hash = ?").get(hashOf(token)) as { id: string; created_at: number; last_used_at: number | null } | null;
		if (!row) return null;
		const t = this.now();
		if (this.idleDays > 0 && t - (row.last_used_at ?? row.created_at) >= this.idleDays * DAY_MS) {
			this.revoke(row.id);
			return null;
		}
		if (t - (this.touched.get(row.id) ?? 0) >= LAST_USED_GRANULARITY_MS) {
			this.touched.set(row.id, t);
			this.db.query("UPDATE device_tokens SET last_used_at = ? WHERE id = ?").run(t, row.id);
		}
		return row.id;
	}

	/** Whether this device id still has a token (it was not revoked). */
	has(id: string): boolean {
		return this.db.query("SELECT 1 FROM device_tokens WHERE id = ?").get(id) !== null;
	}

	/** Days of silence after which a device must pair again; 0 = never. Shown next to the list. */
	get idleLimitDays(): number {
		return Math.max(0, this.idleDays);
	}

	list(): DeviceTokenInfo[] {
		this.expireIdle(); // the list shows who can get in: an expired device is not one of them
		return (
			this.db.query("SELECT id, name, created_at, last_used_at FROM device_tokens ORDER BY created_at DESC").all() as {
				id: string;
				name: string;
				created_at: number;
				last_used_at: number | null;
			}[]
		).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
	}

	/** Revoke a device: its token stops working at once and its open connections are dropped. */
	revoke(id: string): boolean {
		const removed = this.db.query("DELETE FROM device_tokens WHERE id = ?").run(id).changes > 0;
		this.touched.delete(id);
		for (const socket of this.sockets.get(id) ?? []) socket.destroy();
		this.sockets.delete(id);
		return removed;
	}

	/** Remember a connection made with this device's token, so `revoke` can close it. */
	track(id: string, socket: Socket | undefined): void {
		if (!socket) return;
		let set = this.sockets.get(id);
		if (!set) this.sockets.set(id, (set = new Set()));
		if (set.has(socket)) return;
		set.add(socket);
		socket.once("close", () => {
			set.delete(socket);
			if (!set.size && this.sockets.get(id) === set) this.sockets.delete(id);
		});
	}
}
