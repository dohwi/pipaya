import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

/**
 * Wire-compatibility between this server and the clients (browser, desktop, Android, iOS).
 *
 * `PROTOCOL_VERSION` is an integer that is raised only when REST/WebSocket/SSE shapes change in a way an older peer cannot
 * cope with (a field renamed or removed, a route's meaning changed). Adding a field or a route does not raise it: clients
 * ignore what they do not know. `MIN_CLIENT_PROTOCOL` is the oldest client protocol this server still serves; a client that
 * declares a lower one is refused with 426 so it can tell the user to update instead of failing in odd ways.
 *
 * The client keeps its own copy in client/src/lib/protocol.ts; client/tests/protocol.test.ts fails when they drift.
 */
export const PROTOCOL_VERSION = 1;
export const MIN_CLIENT_PROTOCOL = 1;

/** Request header (REST) and query parameter (EventSource/WebSocket, which cannot set headers) carrying the client's protocol. */
export const PROTOCOL_HEADER = "x-pipaya-protocol";
export const PROTOCOL_QUERY = "protocol";

export const SERVER_VERSION: string = pkg.version;

/** The checkout this server runs from (server/src -> repo root). */
export const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Commit of the running code, or null when it is not a git checkout (Docker image, compiled binary). */
export function gitCommit(root: string = REPO_ROOT): string | null {
	try {
		if (!existsSync(join(root, ".git"))) return null;
		const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "ignore" });
		const out = r.exitCode === 0 ? r.stdout.toString().trim() : "";
		return /^[0-9a-f]{7,64}$/.test(out) ? out : null;
	} catch {
		return null;
	}
}

/** Read once at startup: a self-update restarts the process, so the value never goes stale. */
export const SERVER_COMMIT = gitCommit();
