import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { EventBus } from "./events.ts";
import { badRequest, HttpError } from "./errors.ts";
import { errors } from "./schemas.ts";
import type { SqliteCredentialStore } from "./store.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";
import {
	DEFAULT_PATH, DEFAULT_VOICE_SETTINGS, MAX_AUDIO_BYTES, TIMEOUT_MS, VOICE_CREDENTIAL_ID, VoiceSettingsBody, VoiceSettingsResult,
	type VoiceSettings, type VoiceSettingsValue, endpointOf, usesLanguagesList,
} from "./voice-input.ts";

/** What the transcription endpoint answered, once it is known to be a usable answer. */
export const TranscribeResult = Type.Object({ text: Type.String() });
export const TranscribeTestResult = Type.Object({ text: Type.String(), status: Type.Integer() });

/** The kinds the client turns into a message of its own; anything else is a server error. */
export type VoiceFailure = "not_configured" | "bad_key" | "not_found" | "too_large" | "timeout" | "upstream_error" | "bad_response";

/** An upstream answer that is not a transcription, with the HTTP status the client should see. */
export function failureStatus(kind: VoiceFailure): number {
	switch (kind) {
		case "not_configured":
			return 400;
		case "bad_key":
			return 502;
		case "not_found":
			return 502;
		case "too_large":
			return 413;
		case "timeout":
			return 504;
		case "bad_response":
			return 502;
		default:
			return 502;
	}
}

/** The HTTP status of an upstream transcription answer, as the failure kind it means. */
export function upstreamFailure(status: number): VoiceFailure {
	if (status === 401 || status === 403) return "bad_key";
	if (status === 404 || status === 405) return "not_found";
	if (status === 413) return "too_large";
	if (status === 408 || status === 504) return "timeout";
	return "upstream_error";
}

export interface TranscribeInput {
	settings: VoiceSettingsValue;
	key: string;
	audio: { bytes: Uint8Array; type: string; name: string };
	language?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

/**
 * Sends one recording to the configured endpoint and returns the text. The key goes into the Authorization header only.
 * Throws an HttpError the client can explain; the upstream body is never logged (it may echo the audio's content).
 */
export async function transcribe(input: TranscribeInput): Promise<string> {
	const endpoint = endpointOf(input.settings);
	if (!endpoint) throw new HttpError(400, "not_configured", "voice input has no server address or path");
	if (!input.key) throw new HttpError(400, "not_configured", "voice input has no API key");
	const form = new FormData();
	form.append("file", new File([input.audio.bytes], input.audio.name, { type: input.audio.type }));
	const model = input.settings.model.trim();
	if (model) form.append("model", model);
	const language = (input.language ?? input.settings.language).trim();
	if (language) form.append(usesLanguagesList(model) ? "languages[]" : "language", language);
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await (input.fetchImpl ?? fetch)(endpoint, {
			method: "POST",
			headers: { authorization: `Bearer ${input.key}` },
			body: form,
			redirect: "error",
			signal,
		});
	} catch (cause) {
		if (timeout.aborted) throw new HttpError(failureStatus("timeout"), "timeout", "the transcription server did not answer in time");
		if (input.signal?.aborted) throw new HttpError(499, "aborted", "the client went away");
		throw new HttpError(failureStatus("upstream_error"), "upstream_error", `cannot reach the transcription server (${cause instanceof Error ? cause.name : "error"})`);
	}
	if (!response.ok) {
		const kind = upstreamFailure(response.status);
		throw new HttpError(failureStatus(kind), kind, `the transcription server answered ${response.status}`);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new HttpError(failureStatus("bad_response"), "bad_response", "the transcription server did not answer with JSON");
	}
	const text = (body as { text?: unknown } | null)?.text;
	if (typeof text !== "string") throw new HttpError(failureStatus("bad_response"), "bad_response", "the answer has no text field");
	return text.trim();
}

/**
 * The recording format of the first bytes, or null. The containers browsers record into, recognized by their magic
 * number: WebM/Matroska (EBML), Ogg, WAV/RIFF and MP4/M4A (`ftyp`).
 */
export function sniffAudio(bytes: Uint8Array): string | null {
	const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
	if (bytes.length < 12) return null;
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
	if (ascii(0, 4) === "OggS") return "audio/ogg";
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
	if (ascii(4, 4) === "ftyp") return "audio/mp4";
	if (bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return "audio/aac";
	if (ascii(0, 3) === "ID3") return "audio/mpeg";
	return null;
}

/** The audio part of a multipart upload, checked for size and kind. */
export async function audioPart(form: FormData): Promise<{ bytes: Uint8Array; type: string; name: string }> {
	const file = form.get("file");
	if (!(file instanceof File)) throw badRequest("the upload needs a file part named file");
	if (!file.size) throw badRequest("the audio is empty");
	if (file.size > MAX_AUDIO_BYTES) throw new HttpError(413, "too_large", "the recording is too large");
	// The runtime's File has no arrayBuffer() of its own; its stream does (and a zero-byte part is refused above).
	const bytes = new Uint8Array(await new Response(file.stream()).arrayBuffer());
	// The bytes decide: a multipart parser may report the container instead of the audio inside it (Bun turns
	// audio/webm into video/webm) or guess from the file name (application/octet-stream became video/webm), so a
	// known recording container is accepted and anything else is refused, whatever the part claimed. A browser
	// recording always starts with one of these headers.
	const type = sniffAudio(bytes);
	if (!type) throw badRequest("the file is not audio");
	const extension = type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "webm";
	return { bytes, type, name: `voice.${extension}` };
}

export function registerVoiceRoutes(server: FastifyInstance, settings: VoiceSettings, credentials: SqliteCredentialStore, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const keyOf = async (): Promise<string> => {
		const credential = await credentials.read(VOICE_CREDENTIAL_ID);
		return credential?.type === "api_key" ? credential.key ?? "" : "";
	};
	const view = async () => {
		const current = settings.get();
		return { settings: current, hasKey: (await keyOf()).length > 0, defaults: DEFAULT_VOICE_SETTINGS(), defaultPath: DEFAULT_PATH, endpoint: endpointOf(current) };
	};
	app.get("/voice", {
		schema: { response: { 200: VoiceSettingsResult, ...errors(401) } },
		handler: async () => view(),
	});
	app.put("/voice", {
		schema: { body: VoiceSettingsBody, response: { 200: VoiceSettingsResult, ...errors(400, 401) } },
		handler: async (req) => {
			const saved = settings.set(req.body.settings);
			if (req.body.apiKey !== undefined) {
				const key = req.body.apiKey.trim();
				if (key) await credentials.modify(VOICE_CREDENTIAL_ID, async () => ({ type: "api_key", key }));
				else await credentials.delete(VOICE_CREDENTIAL_ID);
			}
			bus.publish(null, "configuration_updated", { scope: "voice" });
			return { ...(await view()), settings: saved };
		},
	});
	/**
	 * One recording in, its text out. Multipart (`file`, optional `language`) so the browser's own recording format goes
	 * up as is; the bytes are relayed and dropped, never written anywhere.
	 */
	app.post("/voice/transcribe", {
		bodyLimit: MAX_AUDIO_BYTES + 1024 * 1024,
		schema: { response: { 200: TranscribeResult, ...errors(400, 401, 413, 502, 504) } },
		handler: async (req) => {
			const form = await multipartOf(req.headers["content-type"], req.body);
			// The upload is checked first: a malformed or non-audio request is the same answer whatever the settings say.
			const audio = await audioPart(form);
			const language = typeof form.get("language") === "string" ? String(form.get("language")).slice(0, 20) : undefined;
			const controller = new AbortController();
			req.raw.on("close", () => { if (!req.raw.complete) controller.abort(); });
			const text = await transcribe({ settings: settings.get(), key: await keyOf(), audio, language, signal: controller.signal });
			return { text };
		},
	});
	/** The connection test: a second of silence as a WAV, so a wrong address, key or model is caught before the user speaks. */
	app.post("/voice/test", {
		schema: { response: { 200: TranscribeTestResult, ...errors(400, 401, 502, 504) } },
		handler: async (req) => {
			const controller = new AbortController();
			req.raw.on("close", () => { if (!req.raw.complete) controller.abort(); });
			const text = await transcribe({ settings: settings.get(), key: await keyOf(), audio: { bytes: SILENCE_WAV, type: "audio/wav", name: "test.wav" }, signal: controller.signal });
			return { text, status: 200 };
		},
	});
}

/** A multipart body as a FormData, without a multipart dependency: the runtime's own parser reads it. */
export async function multipartOf(contentType: string | undefined, body: unknown): Promise<FormData> {
	if (!contentType?.toLowerCase().startsWith("multipart/form-data")) throw badRequest("the upload must be multipart/form-data");
	if (!(body instanceof Uint8Array)) throw badRequest("the upload body is missing");
	try {
		// The runtime's parser; its FormData type differs from the DOM one only in typings.
		const request = new Request("http://localhost/", { method: "POST", headers: { "content-type": contentType }, body: body as Uint8Array });
		return (await request.formData()) as unknown as FormData;
	} catch {
		throw badRequest("the multipart body is malformed");
	}
}

/** 0.5 s of 16 kHz mono 16-bit silence in a WAV container: an upload every transcription server accepts. */
export const SILENCE_WAV: Uint8Array = (() => {
	const rate = 16_000;
	const samples = rate / 2;
	const bytes = new Uint8Array(44 + samples * 2);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
	ascii(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); ascii(8, "WAVE");
	ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
	view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
	ascii(36, "data"); view.setUint32(40, samples * 2, true);
	return bytes;
})();


