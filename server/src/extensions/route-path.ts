/**
 * Single shared URL/path normalizer for `/x/<extension>/...` HTTP routes.
 * Used identically by `http-hooks.ts` (pre-auth public check) and `extensions/routes.ts` (handler dispatch)
 * so dot-segments, backslashes, or percent-encoded traversal can never cause auth/handler mismatch.
 */

const SAFE_HOST = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$|^\[[0-9a-fA-F:]+\](?::\d{1,5})?$/;

export interface ParsedExtensionRoute {
	/** Canonical pathname guaranteed free of dot-segments, backslashes, and encoded traversal. */
	pathname: string;
	/** Safe URL built with a validated host (falls back to `localhost` if Host header is malformed). */
	url: URL;
}

/**
 * Parse and validate an extension route request URL.
 * Returns `null` if the raw path contains backslashes, empty/malformed percent-escapes,
 * or raw/encoded `.` / `..` segments or encoded slashes (`%2f`, `%5c`).
 */
export function parseExtensionRouteRequest(rawUrl: string, rawHost?: string): ParsedExtensionRoute | null {
	const rawPath = rawUrl.split("?")[0] ?? "";
	if (!rawPath.startsWith("/")) return null;
	if (rawPath.includes("\\") || /%2f|%5c/i.test(rawPath)) return null;

	const rawSegments = rawPath.split("/");
	for (const seg of rawSegments) {
		if (seg === "." || seg === "..") return null;
		let decoded: string;
		try {
			decoded = decodeURIComponent(seg);
		} catch {
			return null;
		}
		if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return null;
	}

	const host = rawHost && SAFE_HOST.test(rawHost) ? rawHost : "localhost";
	let url: URL;
	try {
		url = new URL(rawUrl, `http://${host}`);
	} catch {
		return null;
	}
	// Extra guard: URL parsing must not have altered segment structure beyond standard normalization.
	if (url.pathname !== rawPath) return null;
	return { pathname: url.pathname, url };
}
