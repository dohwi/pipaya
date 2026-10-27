/**
 * Wire compatibility with the server. Plain TypeScript (no runes), so it is unit-tested directly.
 *
 * `PROTOCOL_VERSION` mirrors server/src/version.ts: an integer raised only when REST/WebSocket/SSE shapes change in a way an
 * older peer cannot cope with. client/tests/protocol.test.ts fails when the two files drift apart.
 */
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_HEADER = "X-Pipaya-Protocol";
export const PROTOCOL_QUERY = "protocol";

/** What `GET /health` says about the server. A server from before the handshake leaves all three out. */
export interface ServerVersions {
	version?: string;
	protocol?: number;
	minClientProtocol?: number;
}

/**
 * - `ok`            nothing to do (also when the server has not been probed yet).
 * - `update-app`    the server needs a newer client than this one; connecting would fail in odd ways.
 * - `update-server` the server is older than this client (or predates the handshake): it works, but newer features are missing.
 */
export type Compat = "ok" | "update-app" | "update-server";

export function compat(server: ServerVersions | null | undefined, mine: number = PROTOCOL_VERSION): Compat {
	if (!server) return "ok";
	if (typeof server.minClientProtocol === "number" && mine < server.minClientProtocol) return "update-app";
	if (typeof server.protocol !== "number" || server.protocol < mine) return "update-server";
	return "ok";
}

/** Compares `major.minor.patch` versions (a leading `v` and any `-pre`/`+build` suffix are ignored); null when either is unreadable. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
	const parse = (v: string | null | undefined) => {
		const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v?.trim() ?? "");
		return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
	};
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
	return 0;
}

/**
 * How the server's release compares with the app's, used when the server cannot check its own git checkout.
 * Releases ship the app and the server with the same version, so a server below the app is out of date.
 * - `older`   the server is behind the app.
 * - `current` same release as the app, or newer.
 * - `unknown` either version is missing or unreadable.
 */
export function serverReleaseState(server: string | null | undefined, app: string | null | undefined): "older" | "current" | "unknown" {
	const c = compareVersions(server, app);
	return c === null ? "unknown" : c < 0 ? "older" : "current";
}

/** True for the 426 the server sends to a client below its minimum. */
export const isClientTooOld = (status: number, code: string) => status === 426 && code === "client_too_old";

/** `GET /server/update` and `POST /server/update` (admin token only). */
export interface ServerUpdateStatus {
	managed: boolean;
	reason?: "disabled" | "unmanaged" | "not_git" | "detached" | "fetch_failed";
	ref: string | null;
	/** Commit hashes: for comparing, never for showing to people. */
	current: string | null;
	latest: string | null;
	/** Versions (`0.5.0`). Servers from before these existed leave them out, and `latestVersion` is null when it could not be read. */
	currentVersion?: string | null;
	latestVersion?: string | null;
	available: boolean;
	checkedAt: number;
}

/**
 * What to show for a server's installed and newest version: the versions when the server names them, nothing otherwise.
 * Never a commit hash. `to` is only set while an update is on offer and its version is known.
 */
export function serverVersionLabel(
	status: Pick<ServerUpdateStatus, "currentVersion" | "latestVersion" | "available"> | null | undefined,
	reported?: string | null,
): { from: string; to: string } {
	const from = status?.currentVersion || reported || "";
	const to = status?.available && status.latestVersion && status.latestVersion !== from ? status.latestVersion : "";
	return { from, to };
}
