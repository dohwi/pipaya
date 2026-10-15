import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type ApprovalPolicy = "auto" | "ask" | "readonly";
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["auto", "ask", "readonly"];

export interface Config {
	host: string;
	port: number;
	dataDir: string;
	dbPath: string;
	/** Bearer token required on every route except /health. */
	token: string;
	/** The default working directory for new sessions. */
	workspaceRoot: string;
	/** HARNESS_RESTRICT_WORKSPACE=1: sessions, the folder picker and the default working directory stay inside workspaceRoot. */
	restrictWorkspace?: boolean;
	defaultProvider?: string;
	defaultModel?: string;
	defaultApproval: ApprovalPolicy;
	/** Auto-deny a pending tool approval after this many ms (0 = never). */
	approvalTimeoutMs: number;
	logLevel: string;
	/** Extra browser origins allowed by CORS (comma separated, "*" = any). Loopback/Tailscale/LAN/Tauri are always allowed. */
	corsOrigins?: string;
	/** Uses Google Application Default Credentials; never exposed to clients/extensions. */
	pushEnabled?: boolean;
}

function int(value: string | undefined, fallback: number): number {
	const n = value === undefined ? NaN : Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
}

export const MIN_TOKEN_LENGTH = 24;

/** Use HARNESS_TOKEN if set, otherwise create and persist one in the data dir. */
function resolveToken(env: Record<string, string | undefined>, dataDir: string): string {
	if (env.HARNESS_TOKEN) {
		const supplied = env.HARNESS_TOKEN.trim();
		if (supplied.length < MIN_TOKEN_LENGTH) {
			throw new Error(
				`HARNESS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (omit it to auto-generate one, or use: openssl rand -base64url 32)`,
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
	const dataDir = resolve(env.HARNESS_DATA_DIR ?? join(homedir(), ".pipaya"));
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });

	const approval = (env.HARNESS_APPROVAL ?? "ask") as ApprovalPolicy;
	if (!APPROVAL_POLICIES.includes(approval)) {
		throw new Error(`HARNESS_APPROVAL must be one of ${APPROVAL_POLICIES.join(", ")}`);
	}

	return {
		host: env.HARNESS_HOST ?? "0.0.0.0",
		port: int(env.HARNESS_PORT, 8787),
		dataDir,
		dbPath: env.HARNESS_DB ?? join(dataDir, "harness.db"),
		token: resolveToken(env, dataDir),
		workspaceRoot: resolve(env.HARNESS_WORKSPACE ?? join(dataDir, "workspace")),
		restrictWorkspace: env.HARNESS_RESTRICT_WORKSPACE === "1",
		defaultProvider: env.HARNESS_PROVIDER,
		defaultModel: env.HARNESS_MODEL,
		defaultApproval: approval,
		approvalTimeoutMs: int(env.HARNESS_APPROVAL_TIMEOUT_MS, 10 * 60_000),
		logLevel: env.HARNESS_LOG_LEVEL ?? "info",
		corsOrigins: env.HARNESS_CORS_ORIGINS,
		// On by default; it only takes effect when Firebase credentials exist (see createPushTransports). "0" turns it off.
		pushEnabled: env.HARNESS_PUSH_FCM !== "0",
	};
}
