import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.ts";

/**
 * One-time connection codes, for "scan this QR with your phone".
 *
 * The QR must never carry the access token itself: anyone who photographs the screen would own the server.
 * It carries a code instead: valid for two minutes, usable once, and worth nothing afterwards. Redeeming it
 * mints a token for that one device (see device-tokens.ts). Codes live in memory only, so a restart invalidates them.
 */
export const PAIRING_TTL_MS = 120_000;
export const MAX_ACTIVE_CODES = 5;
const MAX_FAILURES = 10; // wrong codes per caller per minute
const MAX_FAILURES_ANY = 100; // wrong codes from everyone per minute: bounds memory, and still stops a distributed guess
const FAILURE_WINDOW_MS = 60_000;

const digest = (code: string) => createHash("sha256").update(code).digest();

export class Pairing {
	/** sha256(code) -> expiry. Only the hash is kept. */
	private codes = new Map<string, { hash: Buffer; expires: number }>();
	/** caller address -> times of its recent wrong guesses. One noisy caller must not lock the owner out. */
	private failures = new Map<string, number[]>();

	/** `mint` turns a redeemed code into the credential handed to the device; `label` is what the device calls itself. */
	constructor(private mint: (label?: string) => string, private now: () => number = Date.now) {}

	private sweep() {
		const t = this.now();
		for (const [k, v] of this.codes) if (v.expires <= t) this.codes.delete(k);
		for (const [who, times] of this.failures) {
			const recent = times.filter((at) => t - at < FAILURE_WINDOW_MS);
			if (recent.length) this.failures.set(who, recent);
			else this.failures.delete(who);
		}
	}

	create(): { code: string; expiresAt: number } {
		this.sweep();
		// the oldest code makes room, so pressing "new code" always works
		while (this.codes.size >= MAX_ACTIVE_CODES) this.codes.delete(this.codes.keys().next().value as string);
		const code = randomBytes(24).toString("base64url");
		const hash = digest(code);
		const expiresAt = this.now() + PAIRING_TTL_MS;
		this.codes.set(hash.toString("hex"), { hash, expires: expiresAt });
		return { code, expiresAt };
	}

	/** Returns a new device token for a valid code and burns the code. Wrong guesses are throttled per caller (`from`). */
	redeem(code: string, from = "", label?: string): string {
		this.sweep();
		const mine = this.failures.get(from) ?? [];
		let all = 0;
		for (const times of this.failures.values()) all += times.length;
		if (mine.length >= MAX_FAILURES || all >= MAX_FAILURES_ANY) throw new HttpError(429, "pairing_throttled", "too many wrong codes; wait a minute");
		const hash = digest(code);
		const entry = this.codes.get(hash.toString("hex"));
		if (!entry || entry.expires <= this.now() || !timingSafeEqual(entry.hash, hash)) {
			this.failures.set(from, [...mine, this.now()]);
			throw new HttpError(403, "invalid_pairing_code", "this connection code is not valid any more");
		}
		this.codes.delete(hash.toString("hex"));
		return this.mint(label);
	}

	/** Forget every code (the user closed the dialog) */
	clear() {
		this.codes.clear();
	}
}
