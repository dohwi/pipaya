import { ApiError } from "./api";

/**
 * What the git panel says when its request fails:
 *  - `old-server`: the server does not have the git routes yet (it runs older code, so it answers 404 "route not found" or
 *    501): the fix is to update and restart the server, not a fault of this session.
 *  - `gone`: the session itself is unknown to the server ("session not found").
 *  - `other`: anything else, shown with its own message.
 */
export type GitFailure = { kind: "old-server" } | { kind: "gone" } | { kind: "other"; message: string };

export function gitFailure(e: unknown): GitFailure {
	if (e instanceof ApiError) {
		if (e.status === 501) return { kind: "old-server" };
		if (e.status === 404) return /route not found/i.test(e.message) ? { kind: "old-server" } : { kind: "gone" };
	}
	return { kind: "other", message: e instanceof Error ? e.message : String(e) };
}
