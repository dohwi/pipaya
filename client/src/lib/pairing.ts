/**
 * "Connect by QR": the link a PC shows as a QR code and a phone opens.
 *
 *   pipaya://connect?u=<server address>&c=<one-time code>[&n=<name>]
 *
 * The link never contains the access token. `c` is a code that works once for two minutes
 * (server/src/pairing.ts); the phone trades it for the token by calling the server.
 */
import { normalizeUrl } from "./api";

export const PAIRING_SCHEME = "pipaya:";
export const PAIRING_HOST = "connect";

export interface PairingLink {
	baseUrl: string;
	code: string;
	name: string;
}

export function buildPairingLink(baseUrl: string, code: string, name = ""): string {
	const q = new URLSearchParams({ u: baseUrl, c: code });
	if (name.trim()) q.set("n", name.trim().slice(0, 40));
	return `${PAIRING_SCHEME}//${PAIRING_HOST}?${q}`;
}

/** Parse a scanned or opened link. Returns null for anything that is not a connection link. */
export function parsePairingLink(input: string): PairingLink | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== PAIRING_SCHEME || url.hostname !== PAIRING_HOST) return null;
	const u = url.searchParams.get("u") ?? "";
	const code = url.searchParams.get("c") ?? "";
	if (!u || code.length < 8 || code.length > 128) return null;
	// "host:port" is fine (normalizeUrl adds http://), but any other scheme (ftp://, javascript:) must not be rewritten into a host
	if (/^[a-z][a-z0-9+.-]*:(\/\/|[^0-9])/i.test(u) && !/^https?:\/\//i.test(u)) return null;
	const baseUrl = normalizeUrl(u);
	try {
		const parsed = new URL(baseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		if (parsed.username || parsed.password) return null;
	} catch {
		return null;
	}
	return { baseUrl, code, name: (url.searchParams.get("n") ?? "").slice(0, 40) };
}

/** Exchange the code for the access token. Throws an Error with a message fit to show. */
/** `deviceName` is what this device is called in the server's list of paired devices. */
export async function redeemPairing(link: PairingLink, deviceName?: string, timeoutMs = 8000): Promise<string> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(`${link.baseUrl}/pairing/redeem`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code: link.code, ...(deviceName ? { name: deviceName } : {}) }),
			signal: ctl.signal,
		});
		if (res.status === 403) throw new PairingError("expired");
		if (res.status === 429) throw new PairingError("throttled");
		if (res.status === 404) throw new PairingError("unsupported");
		if (!res.ok) throw new PairingError("failed");
		const body = (await res.json()) as { token?: unknown };
		if (typeof body.token !== "string" || !body.token) throw new PairingError("failed");
		return body.token;
	} catch (e) {
		if (e instanceof PairingError) throw e;
		throw new PairingError((e as Error)?.name === "AbortError" ? "timeout" : "unreachable");
	} finally {
		clearTimeout(timer);
	}
}

export type PairingFailure = "expired" | "throttled" | "unsupported" | "failed" | "timeout" | "unreachable";
export class PairingError extends Error {
	constructor(readonly reason: PairingFailure) {
		super(reason);
	}
}

/**
 * Addresses a phone can actually reach. `localhost`/`127.0.0.1` on the PC mean nothing on another device,
 * so a QR built from them would connect the phone to itself.
 */
export function isLoopbackUrl(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
		return host === "localhost" || host === "::1" || host.startsWith("127.") || host === "0.0.0.0";
	} catch {
		return false;
	}
}

/**
 * Whether a plain-`http://` address stays on a network the owner controls: this machine, the home/office LAN,
 * or Tailscale (which encrypts the link itself). Anything else sends the token across the open internet in clear text.
 * `https://` is always fine; an unparsable address is not judged here.
 */
export function isPlainHttpOnOpenNetwork(baseUrl: string): boolean {
	let u: URL;
	try {
		u = new URL(baseUrl);
	} catch {
		return false;
	}
	if (u.protocol !== "http:") return false;
	const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".ts.net")) return false;
	if (host === "::1" || host.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(host)) return false; // loopback, link-local, unique-local IPv6
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		if (a === 127 || a === 10 || a === 0) return false;
		if (a === 192 && b === 168) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 169 && b === 254) return false;
		if (a === 100 && b >= 64 && b <= 127) return false; // Tailscale / CGNAT
		return true;
	}
	if (!host.includes(".")) return false; // a bare name like "nas" is a LAN name
	return true;
}
