import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";


export interface Config {
	host: string;
	port: number;
	dataDir: string;
	dbPath: string;
	/** Bearer token required on every route except /health. */
	token: string;
	/** The default working directory for new sessions. */
	workspaceRoot: string;
	/** PIPAYA_RESTRICT_WORKSPACE=1: sessions, the folder picker and the default working directory stay inside workspaceRoot. */
	restrictWorkspace?: boolean;
	defaultProvider?: string;
	defaultModel?: string;
	/** Auto-deny a pending tool approval after this many ms (0 = never). */
	approvalTimeoutMs: number;
	logLevel: string;
	/** Extra browser origins allowed by CORS (comma separated, "*" = any). Loopback/Tailscale/LAN/Tauri are always allowed. */
	corsOrigins?: string;
	/** Uses Google Application Default Credentials; never exposed to clients/extensions. */
	pushEnabled?: boolean;
	/** PIPAYA_TERMINAL=0 turns off the interactive shells clients can open on this server. */
	terminals?: boolean;
	/** PIPAYA_MAX_SESSIONS: most active (not closed) sessions at once; 0 = no limit. Unset = DEFAULT_MAX_SESSIONS. */
	maxActiveSessions?: number;
}

/** As many as there are member names, so every active session has its own name. */
export const DEFAULT_MAX_SESSIONS = 200;

function int(value: string | undefined, fallback: number): number {
	const n = value === undefined ? NaN : Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
}

export const MIN_TOKEN_LENGTH = 24;

/** Use PIPAYA_TOKEN if set, otherwise create and persist one in the data dir. */
function resolveToken(env: Record<string, string | undefined>, dataDir: string): string {
	if (env.PIPAYA_TOKEN) {
		const supplied = env.PIPAYA_TOKEN.trim();
		if (supplied.length < MIN_TOKEN_LENGTH) {
			throw new Error(
				`PIPAYA_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (omit it to auto-generate one, or use: openssl rand -base64url 32)`,
			);
		}
		return supplied;
	}
	const file = join(dataDir, "token");
	if (existsSync(file)) {
		const token = readFileSync(file, "utf8").trim();
		if (!token) throw new Error(`Empty auth token file: ${file}`);
		return token;
	}
	const token = randomBytes(24).toString("base64url");
	writeFileSync(file, `${token}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	return token;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const dataDir = resolve(env.PIPAYA_DATA_DIR ?? join(homedir(), ".pipaya"));
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });

	return {
		host: env.PIPAYA_HOST ?? "0.0.0.0",
		port: int(env.PIPAYA_PORT, 8787),
		dataDir,
		dbPath: env.PIPAYA_DB ?? join(dataDir, "pipaya.db"),
		token: resolveToken(env, dataDir),
		workspaceRoot: resolve(env.PIPAYA_WORKSPACE ?? join(dataDir, "workspace")),
		restrictWorkspace: env.PIPAYA_RESTRICT_WORKSPACE === "1",
		defaultProvider: env.PIPAYA_PROVIDER,
		defaultModel: env.PIPAYA_MODEL,
		approvalTimeoutMs: int(env.PIPAYA_APPROVAL_TIMEOUT_MS, 10 * 60_000),
		logLevel: env.PIPAYA_LOG_LEVEL ?? "info",
		corsOrigins: env.PIPAYA_CORS_ORIGINS,
		// On by default; it only takes effect when Firebase credentials exist (see createPushTransports). "0" turns it off.
		pushEnabled: env.PIPAYA_PUSH_FCM !== "0",
		terminals: env.PIPAYA_TERMINAL !== "0",
		maxActiveSessions: Math.max(0, int(env.PIPAYA_MAX_SESSIONS, DEFAULT_MAX_SESSIONS)),
	};
}
