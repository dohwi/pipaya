import type { FastifyInstance } from "fastify";
import { HttpError } from "./errors.ts";
import type { RealtimeSettingsValue, VoiceSettings } from "./voice-input.ts";

/**
 * Realtime voice input: the browser streams the microphone here (24 kHz mono PCM16, binary frames) and this server
 * relays it to an OpenAI Realtime session (`wss://<connection>/v1/realtime`) opened with a chat connection's key, so
 * the key never reaches the browser. The session is transcription only: text output, the server's voice activity
 * detection cuts phrases at a pause, no assistant response is ever asked for. Each finished phrase goes back to the
 * browser as it arrives, and nothing is stored.
 *
 * browser -> server   binary  PCM16 audio
 *                     text    { type: "stop" }       the user finished: commit what is buffered, then close
 * server -> browser   text    { type: "ready" }      the upstream session took the settings; audio may flow
 *                     text    { type: "delta", item, text }   part of the phrase being transcribed
 *                     text    { type: "phrase", item, text }  a phrase is final
 *                     text    { type: "error", code, message }
 *                     text    { type: "done" }       every phrase is in; the socket closes after it
 */

export const REALTIME_SOCKET = "/voice/realtime";
export const PCM_RATE = 24_000;
/** One session is at most ten minutes of speech; a forgotten microphone does not stream for ever. */
export const MAX_SESSION_MS = 10 * 60_000;
/** How long the upstream may take to open and confirm the session. */
const OPEN_TIMEOUT_MS = 10_000;
/** After "stop", how long the last phrase may take before the socket closes anyway. */
const DRAIN_MS = 8_000;
/** Silence that ends a phrase. Short, so text follows speech closely; a breath mid-sentence may split it, which reads fine. */
const SILENCE_MS = 400;

/** Where and how to reach the Realtime API: an address of the chat connection and its key. */
export interface RealtimeTarget {
	url: string;
	key: string;
}

/**
 * A streaming ("live") transcription model sends words while the user is still speaking and takes no voice activity
 * detection: the turn ends when the user stops. Other models (gpt-transcribe) start once a pause ends a phrase.
 */
export const isLiveModel = (model: string) => /(^|-)live-transcribe/.test(model.trim().toLowerCase());

/** The `session.update` that makes the session transcription only, with the hints. */
export function sessionUpdate(rt: RealtimeSettingsValue, language: string) {
	const live = isLiveModel(rt.transcribeModel);
	const transcription: Record<string, unknown> = { model: rt.transcribeModel };
	if (language) transcription.languages = [language];
	if (rt.keywords.length) transcription.keywords = rt.keywords;
	if (rt.prompt) transcription.prompt = rt.prompt;
	// "low" measured best: the first words about a second after speech, names kept as the keywords spell them
	if (live) transcription.delay = "low";
	return {
		type: "session.update",
		session: {
			type: "realtime",
			output_modalities: ["text"],
			audio: {
				input: {
					format: { type: "audio/pcm", rate: PCM_RATE },
					transcription,
					turn_detection: live ? null : { type: "server_vad", silence_duration_ms: SILENCE_MS, create_response: false, interrupt_response: false },
				},
			},
		},
	};
}

type Send = (msg: Record<string, unknown>) => void;

/** The upstream socket; a keyless local server gets no Authorization header. */
const openUpstream = (url: string, key: string): WebSocket =>
	new WebSocket(url, (key ? { headers: { authorization: `Bearer ${key}` } } : {}) as unknown as string[]);

/**
 * One relayed session. Pure of Fastify so a test can drive it with a fake upstream: `audio` and `stop` come from the
 * browser, `send` goes to it, `close` ends the browser's socket.
 */
export class RealtimeRelay {
	private upstream: WebSocket | null = null;
	private ready = false;
	private stopping = false;
	private closed = false;
	/** Phrases the upstream committed but has not finished transcribing: "stop" waits for them. */
	private pending = new Set<string>();
	private timers: ReturnType<typeof setTimeout>[] = [];
	/** Audio that came before the session was ready (the first syllable must not be lost while the upstream opens). */
	private early: Uint8Array[] = [];
	private earlyBytes = 0;

	constructor(
		private target: RealtimeTarget,
		private rt: RealtimeSettingsValue,
		private language: string,
		private send: Send,
		private close: (code: number, reason: string) => void,
		private connect: (url: string, key: string) => WebSocket = openUpstream,
	) {}

	start() {
		let ws: WebSocket;
		try {
			ws = this.connect(this.target.url, this.target.key);
		} catch {
			return this.fail("upstream_error", "cannot reach the realtime server");
		}
		this.upstream = ws;
		this.timer(OPEN_TIMEOUT_MS, () => { if (!this.ready) this.fail("timeout", "the realtime server did not answer in time"); });
		this.timer(MAX_SESSION_MS, () => this.stop());
		ws.onopen = () => ws.send(JSON.stringify(sessionUpdate(this.rt, this.language)));
		ws.onmessage = (m) => this.onUpstream(String(m.data));
		ws.onerror = () => this.fail("upstream_error", "the realtime connection failed");
		ws.onclose = (e) => {
			if (this.closed) return;
			if (!this.ready) return this.fail(e.code === 1008 || e.code === 4001 || e.code === 4003 ? "bad_key" : "upstream_error", `the realtime server closed the connection (${e.code})`);
			this.finish();
		};
	}

	/** Microphone audio from the browser (PCM16, 24 kHz, mono). */
	audio(bytes: Uint8Array) {
		if (this.closed || this.stopping || !bytes.length) return;
		if (!this.ready) {
			// at most five seconds wait for the session; more means it is not coming
			if (this.earlyBytes + bytes.length > PCM_RATE * 2 * 5) return;
			this.early.push(bytes);
			this.earlyBytes += bytes.length;
			return;
		}
		this.append(bytes);
	}

	/** The user finished: what is still buffered becomes the last phrase, then the socket closes. */
	stop() {
		if (this.closed || this.stopping) return;
		this.stopping = true;
		if (!this.ready) return this.finish();
		this.upstreamSend({ type: "input_audio_buffer.commit" });
		this.timer(DRAIN_MS, () => this.finish());
		// nothing buffered: the commit is refused with an error the drain ignores, and nothing is pending
		this.timer(600, () => { if (!this.pending.size) this.finish(); });
	}

	/** The browser went away: drop everything. */
	abort() {
		this.closed = true;
		this.cleanup();
	}

	private append(bytes: Uint8Array) {
		this.upstreamSend({ type: "input_audio_buffer.append", audio: Buffer.from(bytes).toString("base64") });
	}

	private onUpstream(raw: string) {
		let e: { type?: string; item_id?: string; delta?: string; transcript?: string; error?: { message?: string; code?: string } };
		try {
			e = JSON.parse(raw);
		} catch {
			return;
		}
		switch (e.type) {
			case "session.updated":
				if (this.ready) return;
				this.ready = true;
				this.send({ type: "ready" });
				for (const bytes of this.early.splice(0)) this.append(bytes);
				this.earlyBytes = 0;
				if (this.stopping) {
					// stopped while the session was opening: what was said still counts
					this.stopping = false;
					this.stop();
				}
				return;
			case "input_audio_buffer.committed":
				if (e.item_id) this.pending.add(e.item_id);
				return;
			case "conversation.item.input_audio_transcription.delta":
				if (e.item_id && e.delta) this.send({ type: "delta", item: e.item_id, text: e.delta });
				return;
			case "conversation.item.input_audio_transcription.completed":
				if (e.item_id) this.pending.delete(e.item_id);
				this.send({ type: "phrase", item: e.item_id ?? "", text: (e.transcript ?? "").trim() });
				if (this.stopping && !this.pending.size) this.finish();
				return;
			case "conversation.item.input_audio_transcription.failed":
				if (e.item_id) this.pending.delete(e.item_id);
				this.send({ type: "error", code: "upstream_error", message: "a phrase could not be transcribed" });
				if (this.stopping && !this.pending.size) this.finish();
				return;
			case "error": {
				// an empty buffer at "stop" is not a failure: there was simply nothing left to say
				if (this.stopping && /buffer.*(empty|too small)|small/i.test(e.error?.message ?? "")) {
					if (!this.pending.size) this.finish();
					return;
				}
				if (!this.ready) return this.fail("bad_response", e.error?.message?.slice(0, 300) ?? "the realtime server refused the session");
				this.send({ type: "error", code: "upstream_error", message: e.error?.message?.slice(0, 300) ?? "realtime error" });
				return;
			}
			default:
				if (e.type?.startsWith("response.")) this.fail("bad_response", "the realtime server started an answer");
		}
	}

	private upstreamSend(msg: unknown) {
		if (this.upstream?.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify(msg));
	}

	private fail(code: string, message: string) {
		if (this.closed) return;
		this.send({ type: "error", code, message });
		this.closed = true;
		this.cleanup();
		this.close(1011, code);
	}

	private finish() {
		if (this.closed) return;
		this.send({ type: "done" });
		this.closed = true;
		this.cleanup();
		this.close(1000, "done");
	}

	private timer(ms: number, fn: () => void) {
		const t = setTimeout(fn, ms);
		(t as { unref?: () => void }).unref?.();
		this.timers.push(t);
	}

	private cleanup() {
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
		this.early = [];
		const ws = this.upstream;
		this.upstream = null;
		if (ws) {
			ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
			try {
				ws.close(1000);
			} catch {
				/* already closed */
			}
		}
	}
}

/**
 * The connection test of the realtime mode: open a session, send the settings and wait until the upstream confirms
 * them, then close. Nothing is spoken, so nothing is transcribed. Throws an HttpError the client can explain.
 */
export async function probeRealtime(
	target: RealtimeTarget,
	rt: RealtimeSettingsValue,
	language: string,
	connect: (url: string, key: string) => WebSocket = openUpstream,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let ws: WebSocket;
		try {
			ws = connect(target.url, target.key);
		} catch {
			return reject(new HttpError(502, "upstream_error", "cannot reach the realtime server"));
		}
		let settled = false;
		const end = (error?: HttpError) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
			try {
				ws.close(1000);
			} catch {
				/* already closed */
			}
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => end(new HttpError(504, "timeout", "the realtime server did not answer in time")), OPEN_TIMEOUT_MS);
		ws.onopen = () => ws.send(JSON.stringify(sessionUpdate(rt, language)));
		ws.onmessage = (m) => {
			let e: { type?: string; error?: { message?: string } };
			try {
				e = JSON.parse(String(m.data));
			} catch {
				return;
			}
			if (e.type === "session.updated") end();
			else if (e.type === "error") end(new HttpError(502, "bad_response", "the realtime server refused the session", e.error?.message ? { detail: e.error.message.slice(0, 300) } : undefined));
		};
		ws.onerror = () => end(new HttpError(502, "upstream_error", "the realtime connection failed"));
		ws.onclose = (e) => end(new HttpError(502, e.code === 1008 || e.code === 4001 || e.code === 4003 ? "bad_key" : "upstream_error", `the realtime server closed the connection (${e.code})`));
	});
}

/**
 * The browser's socket. `target` finds the connection's address and key for the stored settings, or says why there is
 * none. The token is checked by the global hook (a one-time ticket in the URL, like the other browser streams).
 */
export function registerRealtimeVoice(
	server: FastifyInstance,
	settings: VoiceSettings,
	target: (rt: RealtimeSettingsValue) => Promise<RealtimeTarget | { error: string }>,
	connect?: (url: string, key: string) => WebSocket,
): void {
	server.get(REALTIME_SOCKET, { websocket: true }, (socket, req) => {
		const current = settings.get();
		const query = req.query as { language?: string };
		const language = (typeof query.language === "string" ? query.language.slice(0, 20) : current.language).trim();
		const send: Send = (msg) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg)); };
		const close = (code: number, reason: string) => { if (socket.readyState === socket.OPEN) socket.close(code, reason); };
		let relay: RealtimeRelay | null = null;
		// audio and a stop that come while the connection is still being looked up wait for the relay
		const early: { stop?: boolean; audio: Uint8Array[] } = { audio: [] };
		socket.on("message", (raw: Buffer, isBinary: boolean) => {
			if (isBinary) {
				const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
				if (relay) relay.audio(bytes);
				else if (early.audio.length < 100) early.audio.push(bytes);
				return;
			}
			let msg: { type?: unknown };
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (msg.type === "stop") {
				if (relay) relay.stop();
				else early.stop = true;
			}
		});
		socket.on("close", () => relay?.abort());
		if (!current.enabled || current.mode !== "realtime") {
			send({ type: "error", code: "not_configured", message: "realtime voice input is off" });
			return close(1008, "not_configured");
		}
		void target(current.realtime).then((found) => {
			if (socket.readyState !== socket.OPEN) return;
			if ("error" in found) {
				send({ type: "error", code: "not_configured", message: found.error });
				return close(1008, "not_configured");
			}
			relay = new RealtimeRelay(found, current.realtime, language, send, close, connect);
			relay.start();
			for (const bytes of early.audio.splice(0)) relay.audio(bytes);
			if (early.stop) relay.stop();
		});
	});
}
