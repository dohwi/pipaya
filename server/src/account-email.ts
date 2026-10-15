import type { Database } from "bun:sqlite";
import type { Credential } from "@earendil-works/pi-ai";

const key = (providerId: string) => `account_email:${providerId}`;
const FETCH_TIMEOUT_MS = 5000;

/** The email claim of a JWT access token (OpenAI puts it under its own profile claim), without verifying anything: it is only shown. */
export function emailFromJwt(token: string): string | undefined {
	const part = token.split(".")[1];
	if (!part) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
		const profile = claims["https://api.openai.com/profile"] as { email?: unknown } | undefined;
		const email = typeof claims.email === "string" ? claims.email : typeof profile?.email === "string" ? profile.email : undefined;
		return email && email.length <= 320 ? email : undefined;
	} catch {
		return undefined;
	}
}

/** Anthropic's tokens are opaque, so ask its profile endpoint (the one Claude Code uses). Any failure just means no email is shown. */
async function anthropicEmail(access: string): Promise<string | undefined> {
	try {
		const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
			headers: { authorization: `Bearer ${access}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return undefined;
		const data = (await res.json()) as { account?: { email?: unknown } };
		const email = data.account?.email;
		return typeof email === "string" && email.length <= 320 ? email : undefined;
	} catch {
		return undefined;
	}
}

/** The account's email for a signed-in (OAuth) credential, if the provider reveals one. API keys carry no account. */
export async function lookupEmail(providerId: string, credential: Credential | undefined): Promise<string | undefined> {
	if (!credential || credential.type !== "oauth") return undefined;
	const access = typeof credential.access === "string" ? credential.access : "";
	const fromToken = emailFromJwt(access);
	if (fromToken) return fromToken;
	if (providerId === "anthropic" && access) return anthropicEmail(access);
	return undefined;
}

/** Remembers which email belongs to a provider's sign-in, so the list does not ask the provider every time. */
export class AccountEmails {
	private tried = new Set<string>();

	constructor(private db: Database) {}

	get(providerId: string): string | undefined {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: key(providerId) }) as { data: string } | null;
		return row ? (JSON.parse(row.data) as string) : undefined;
	}

	set(providerId: string, email: string | undefined) {
		if (email) this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: key(providerId), data: JSON.stringify(email) });
		else this.clear(providerId);
	}

	clear(providerId: string) {
		this.tried.delete(providerId);
		this.db.query("DELETE FROM settings WHERE key = $key").run({ key: key(providerId) });
	}

	/** A fresh sign-in: whatever was remembered belongs to the previous account. */
	async refresh(providerId: string, credential: Credential | undefined) {
		this.tried.add(providerId);
		this.set(providerId, await lookupEmail(providerId, credential));
	}

	/** A sign-in made before emails were remembered: look once per server run. */
	async backfill(providerId: string, credential: () => Promise<Credential | undefined>): Promise<string | undefined> {
		const known = this.get(providerId);
		if (known || this.tried.has(providerId)) return known;
		this.tried.add(providerId);
		const email = await lookupEmail(providerId, await credential());
		if (email) this.set(providerId, email);
		return email;
	}
}
