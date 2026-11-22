/**
 * Realtime voice input, the browser half: the microphone is read as 24 kHz mono PCM16 and streamed to the server's
 * `/voice/realtime` socket, which relays it to the Realtime API; each phrase comes back as soon as a pause ends it.
 * See server/src/voice-realtime.ts for the protocol.
 */
import { PROTOCOL_QUERY, PROTOCOL_VERSION } from "./protocol";

export const PCM_RATE = 24_000;

/** The socket's URL: browsers cannot set headers on a WebSocket, so the credential (`Api.streamCredential()`) rides in the query. */
export function realtimeSocketUrl(baseUrl: string, credential: string, language: string): string {
	const base = baseUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
	const lang = language.trim() ? `&language=${encodeURIComponent(language.trim())}` : "";
	return `${base}/voice/realtime?${PROTOCOL_QUERY}=${PROTOCOL_VERSION}${lang}&${credential}`;
}

/** Float samples at `from` Hz to PCM16 at `to` Hz (linear interpolation: speech, not music, and cheap enough per frame). */
export function toPcm16(input: Float32Array, from: number, to = PCM_RATE): Int16Array {
	const ratio = from / to;
	const length = Math.floor(input.length / ratio);
	const out = new Int16Array(length);
	for (let i = 0; i < length; i++) {
		const at = i * ratio;
		const lo = Math.floor(at);
		const hi = Math.min(lo + 1, input.length - 1);
		const v = input[lo]! + (input[hi]! - input[lo]!) * (at - lo);
		const clamped = Math.max(-1, Math.min(1, v));
		out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
	}
	return out;
}

/** What the server sends back. */
export type RealtimeMessage =
	| { type: "ready" }
	| { type: "delta"; item: string; text: string }
	| { type: "phrase"; item: string; text: string }
	| { type: "error"; code: string; message: string }
	| { type: "done" };

/**
 * Captures the microphone stream as PCM16 frames of about 100 ms. A ScriptProcessor rather than an AudioWorklet: it
 * needs no separate module file (the Tauri CSP and the dev server both serve one bundle), and 100 ms frames are
 * well within what it handles on the main thread.
 */
export function capturePcm(stream: MediaStream, onFrame: (pcm: Int16Array) => void): () => void {
	const context = new AudioContext();
	const source = context.createMediaStreamSource(stream);
	const node = context.createScriptProcessor(4096, 1, 1);
	const rate = context.sampleRate;
	node.onaudioprocess = (e) => onFrame(toPcm16(e.inputBuffer.getChannelData(0), rate));
	source.connect(node);
	// a processor only runs while connected to the output; it writes silence, so nothing is heard
	node.connect(context.destination);
	return () => {
		node.onaudioprocess = null;
		source.disconnect();
		node.disconnect();
		void context.close();
	};
}
