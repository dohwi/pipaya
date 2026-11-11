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
	logLevel: string;
	/** Extra browser origins allowed by CORS (comma separated, "*" = any). Loopback/Tailscale/LAN/Tauri are always allowed. */
	corsOrigins?: string;
	/** Uses Google Application Default Credentials; never exposed to clients/extensions. */
	pushEnabled?: boolean;
	/** PIPAYA_TERMINAL=0 turns off the interactive shells clients can open on this server. */
	terminals?: boolean;
	/** PIPAYA_DEVICE_TOKEN_IDLE_DAYS: a paired device unused for this many days must pair again; 0 = never. Unset = 90. */
	deviceTokenIdleDays?: number;
	/** PIPAYA_MAX_SESSIONS: most active (not closed) sessions at once; 0 = no limit. Unset = DEFAULT_MAX_SESSIONS. */
	maxActiveSessions?: number;
}

/** As many as there are member names, so every active session has its own name. */
export const DEFAULT_MAX_SESSIONS = 200;
/** Kept in step with DEFAULT_DEVICE_TOKEN_IDLE_DAYS in device-tokens.ts (config.ts imports nothing from the app). */
const DEFAULT_DEVICE_TOKEN_IDLE_DAYS = 90;

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
		// Loopback unless the operator says otherwise: the API is plain HTTP and its token runs commands, so a server
		// somebody just started must not be listening on every network the machine happens to be on.
		host: env.PIPAYA_HOST?.trim() || "127.0.0.1",
		port: int(env.PIPAYA_PORT, 8787),
		dataDir,
		dbPath: env.PIPAYA_DB ?? join(dataDir, "pipaya.db"),
		token: resolveToken(env, dataDir),
		workspaceRoot: resolve(env.PIPAYA_WORKSPACE ?? join(dataDir, "workspace")),
		restrictWorkspace: env.PIPAYA_RESTRICT_WORKSPACE === "1",
		defaultProvider: env.PIPAYA_PROVIDER,
		defaultModel: env.PIPAYA_MODEL,
		logLevel: env.PIPAYA_LOG_LEVEL ?? "info",
		corsOrigins: env.PIPAYA_CORS_ORIGINS,
		// On by default; it only takes effect when Firebase credentials exist (see createPushTransports). "0" turns it off.
		pushEnabled: env.PIPAYA_PUSH_FCM !== "0",
		terminals: env.PIPAYA_TERMINAL !== "0",
		maxActiveSessions: Math.max(0, int(env.PIPAYA_MAX_SESSIONS, DEFAULT_MAX_SESSIONS)),
		deviceTokenIdleDays: Math.max(0, int(env.PIPAYA_DEVICE_TOKEN_IDLE_DAYS, DEFAULT_DEVICE_TOKEN_IDLE_DAYS)),
	};
}
