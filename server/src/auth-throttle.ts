import { createHash } from "node:crypto";

/**
 * Slows down guessing of the access token.
 *
 * A generated token is 192 random bits and cannot be guessed, but `PIPAYA_TOKEN` is whatever the operator typed (24
 * characters at least, of unknown quality), and a device token or a stream ticket is tried against the same door.
 * Each caller address gets a number of *different* wrong credentials per minute; past it every request from that
 * address is turned away until the minute has passed, a right token included, or the limit would be no limit at all.
 *
 * Two things keep that from locking out the people who belong here:
 *  - Only different wrong credentials count. A phone whose access was revoked keeps asking with the same dead token;
 *    behind a proxy or a container it shares its address with everybody else, and must not shut them out.
 *  - Loopback is never throttled. A reverse proxy, a tunnel or `tailscale serve` on this machine makes every visitor
 *    arrive from 127.0.0.1; rate limiting belongs to that proxy then.
 */
export const AUTH_MAX_FAILURES = 20;
export const AUTH_FAILURE_WINDOW_MS = 60_000;
/** Addresses remembered at once: bounds memory under a flood from many sources. */
const MAX_TRACKED = 10_000;

export const isLoopback = (address: string): boolean => address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");

/** Enough of a hash to tell two guesses apart; the wrong credential itself is not kept. */
const mark = (credential: string) => createHash("sha256").update(credential).digest("base64url").slice(0, 16);

export class AuthThrottle {
	/** caller address -> its recent wrong credentials (by mark) and when each was first seen, oldest first */
	private failures = new Map<string, Map<string, number>>();

	constructor(private max = AUTH_MAX_FAILURES, private windowMs = AUTH_FAILURE_WINDOW_MS, private now: () => number = Date.now) {}

	private recent(from: string): Map<string, number> | undefined {
		const seen = this.failures.get(from);
		if (!seen) return undefined;
		const t = this.now();
		for (const [k, at] of seen) if (t - at >= this.windowMs) seen.delete(k);
		if (!seen.size) {
			this.failures.delete(from);
			return undefined;
		}
		return seen;
	}

	/** Milliseconds this caller still has to wait, or 0 when it may try. */
	blockedFor(from: string): number {
		if (isLoopback(from)) return 0;
		const seen = this.recent(from);
		if (!seen || seen.size < this.max) return 0;
		// It may try again once its oldest counted guess has left the window.
		const oldest = seen.values().next().value as number;
		return Math.max(1, oldest + this.windowMs - this.now());
	}

	/** Count one wrong credential from this caller. The same one again is the same guess. */
	fail(from: string, credential: string): void {
		if (isLoopback(from)) return;
		let seen = this.recent(from);
		if (!seen) {
			if (this.failures.size >= MAX_TRACKED) this.failures.delete(this.failures.keys().next().value as string);
			this.failures.set(from, (seen = new Map()));
		}
		const key = mark(credential);
		if (!seen.has(key) && seen.size < this.max) seen.set(key, this.now());
	}
}
