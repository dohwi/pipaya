/**
 * Browser-facing hardening helpers: CORS origin policy and log redaction.
 *
 * Auth is a Bearer token (not cookies), so CORS is not a CSRF barrier here. It still limits which
 * web pages can use a leaked token from a victim's browser, so only known client origins are allowed.
 */

const TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

/** Hostnames of the machines a client is normally served from: loopback, Tailscale, and RFC1918 LAN. */
function isTrustedHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host === "::1" || host.endsWith(".ts.net")) return true;
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if (a === 127 || a === 10) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT 100.64.0.0/10
	if (a === 192 && b === 168) return true;
	return a === 172 && b >= 16 && b <= 31;
}

export interface CorsPolicy {
	/** True when a cross-origin browser request from `origin` may be answered with CORS headers. */
	allows(origin: string | undefined): boolean;
	/** `PIPAYA_CORS_ORIGINS=*`: any web page may call the API with a token it holds, so the operator should know. */
	readonly allowsAll: boolean;
}

/**
 * Default: Tauri app origins plus loopback/Tailscale/LAN hosts on any port.
 * `extra` (PIPAYA_CORS_ORIGINS, comma separated) adds exact origins; "*" allows every origin.
 */
export function createCorsPolicy(extra: string | undefined): CorsPolicy {
	const entries = (extra ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const allowAll = entries.includes("*");
	const exact = new Set(entries.map((s) => s.replace(/\/+$/, "")));
	return {
		allowsAll: allowAll,
		allows(origin) {
			if (!origin) return false;
			if (allowAll || exact.has(origin) || TAURI_ORIGINS.has(origin)) return true;
			try {
				const url = new URL(origin);
				return (url.protocol === "http:" || url.protocol === "https:") && isTrustedHost(url.hostname);
			} catch {
				return false;
			}
		},
	};
}

/** Replace `token=` query values so credentials passed via URL (SSE/WebSocket) never reach logs. */
export function redactUrl(url: string): string {
	return url.replace(/([?&]token=)[^&#]*/gi, "$1[redacted]");
}
