import { TERMINAL_SOCKET } from "./routes/terminal-routes.ts";
import { REALTIME_SOCKET } from "./voice-realtime.ts";

/** Paths reachable without the access token (the one-time pairing code is the credential). */
export const PUBLIC_PAIRING_PATH = "/pairing/redeem";

/**
 * Only the admin token may open the door for another device: a paired phone must not be able to pair more phones,
 * install/remove server extensions, reconfigure stdio MCP servers, or trigger server self-updates.
 *
 * `path` must be the route pattern the router matched (`req.routeOptions.url`, e.g. `/devices/tokens/:id`), never the raw
 * request URL: the router decodes percent-escapes, so `/devices/token%73` reaches `/devices/tokens`.
 */
export const isAdminOnlyRoute = (method: string, path: string): boolean =>
	(path === "/pairing" && (method === "POST" || method === "DELETE")) ||
	path === "/devices/tokens" ||
	path.startsWith("/devices/tokens/") ||
	((path === "/server-extensions/reload" || path === "/server-extensions/install") && method === "POST") ||
	(path.startsWith("/server-extensions/") && method === "DELETE") ||
	(path === "/mcp" && method === "PUT") ||
	(path === "/mcp/reload" && method === "POST") ||
	path === "/server/update";

/** Long-lived streaming endpoints (SSE or WebSocket) where browsers cannot send custom Authorization headers. */
export const isStreamPath = (path: string): boolean =>
	path === "/ws" ||
	path === "/events" ||
	path === REALTIME_SOCKET ||
	TERMINAL_SOCKET.test(path) ||
	/^\/sessions\/[^/]+\/events$/.test(path);
