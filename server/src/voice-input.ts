import type { Database } from "bun:sqlite";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { badRequest } from "./errors.ts";

/**
 * Voice input (speech to text). The client records audio and sends it here; this server relays it to one
 * OpenAI-compatible transcription endpoint, so the key never reaches a browser and the same code works in the
 * desktop app, on Android and on the web. Audio is passed through memory and never stored.
 *
 * The address, key, model and language are their own settings rather than a chat connection: a transcription
 * endpoint is not a chat model, and gateways often mount it on a path of its own (`/v0/management/audio/transcriptions`).
 */

const KEY = "voice_input";
export const DEFAULT_PATH = "/v1/audio/transcriptions";
/** One recording is at most five minutes of Opus; the cap is generous for that and refuses anything bigger. */
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
/** How long the upstream transcription may take. A five-minute recording takes a few seconds. */
export const TIMEOUT_MS = 60_000;

export const VoiceSettingsSchema = Type.Object(
	{
		enabled: Type.Boolean({ description: "The microphone button is offered in the composer" }),
		baseUrl: Type.String({ maxLength: 300, description: "Origin of the transcription server, e.g. https://api.openai.com" }),
		path: Type.String({ maxLength: 200, description: `Request path on that server; empty means ${DEFAULT_PATH}` }),
		model: Type.String({ maxLength: 100, description: "Model name, e.g. whisper-1 or voxtral-mini-latest" }),
		language: Type.String({ maxLength: 20, description: "Optional language hint (ISO-639-1); empty lets the server decide" }),
	},
	{ additionalProperties: false },
);
export type VoiceSettingsValue = Static<typeof VoiceSettingsSchema>;

export const DEFAULT_VOICE_SETTINGS = (): VoiceSettingsValue => ({ enabled: false, baseUrl: "", path: "", model: "", language: "" });

/** What the client may know about the key: only whether one is stored. */
export type VoiceSettingsView = VoiceSettingsValue & { hasKey: boolean };

export const VoiceSettingsResult = Type.Object({
	settings: VoiceSettingsSchema,
	hasKey: Type.Boolean(),
	defaults: VoiceSettingsSchema,
	defaultPath: Type.String(),
	/** The address the audio would go to right now, or null while the settings are incomplete (never includes the key). */
	endpoint: Type.Union([Type.String(), Type.Null()]),
});
export const VoiceSettingsBody = Type.Object(
	{
		settings: VoiceSettingsSchema,
		/** A new key. Absent keeps the stored one; an empty string removes it. */
		apiKey: Type.Optional(Type.String({ maxLength: 400 })),
	},
	{ additionalProperties: false },
);

/**
 * A request path only: one leading `/`, no scheme, origin, query, fragment, `..` segment, backslash or space.
 * Returns null when the value is not acceptable.
 */
export function parsePath(text: string): string | null {
	const value = text.trim();
	if (!value) return DEFAULT_PATH;
	if (value.length > 200 || !/^\/(?!\/)[A-Za-z0-9._~\-/%:@!$&'()*+,;=]*$/.test(value)) return null;
	if (value.split("/").some((part) => part === "." || part === ".." || /^(%2e)+$/i.test(part))) return null;
	return value;
}

/** The origin of a transcription server: http(s), no credentials, query, fragment or path. Empty is allowed (not set yet). */
export function parseBase(text: string): string | null {
	const value = text.trim();
	if (!value) return "";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) return null;
	return url.origin;
}

/** Where the audio goes: origin + path, or null when the settings are not usable yet. */
export function endpointOf(settings: Pick<VoiceSettingsValue, "baseUrl" | "path">): string | null {
	const base = parseBase(settings.baseUrl);
	const path = parsePath(settings.path);
	if (base === null || path === null || !base) return null;
	try {
		if (new URL(base + path).origin !== base) return null;
	} catch {
		return null;
	}
	return base + path;
}

/** OpenAI's `gpt-transcribe` takes `languages` (a list) instead of `language`, and the two must not be sent together. */
export const usesLanguagesList = (model: string) => model.trim().toLowerCase() === "gpt-transcribe";

export class VoiceSettings {
	constructor(private db: Database) {}

	get(): VoiceSettingsValue {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		if (!row) return DEFAULT_VOICE_SETTINGS();
		try {
			const parsed: unknown = JSON.parse(row.data);
			return Value.Check(VoiceSettingsSchema, parsed) ? parsed : DEFAULT_VOICE_SETTINGS();
		} catch {
			return DEFAULT_VOICE_SETTINGS();
		}
	}

	/** Validates and stores; returns what was stored. The key is not part of this row (see `readKey`/`writeKey`). */
	set(next: VoiceSettingsValue): VoiceSettingsValue {
		const baseUrl = parseBase(next.baseUrl);
		if (baseUrl === null) throw badRequest("baseUrl must be HTTP(S) without embedded credentials, query, fragment or path");
		const path = parsePath(next.path);
		if (path === null) throw badRequest("path must be a request path starting with one /");
		const value: VoiceSettingsValue = { enabled: next.enabled, baseUrl, path: path === DEFAULT_PATH ? "" : path, model: next.model.trim(), language: next.language.trim() };
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(value) });
		return this.get();
	}
}

/** The key lives in the credentials table, like provider keys, so it is never part of the settings row the client reads. */
export const VOICE_CREDENTIAL_ID = "voice_input";
