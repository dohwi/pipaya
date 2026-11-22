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
 * The phrases of one recording in the order they were spoken: each shows its words as they arrive, and its final text
 * replaces them when the phrase is done. `text` is everything heard so far.
 */
export class PhraseList {
	private order: string[] = [];
	private parts = new Map<string, { text: string; final: boolean }>();

	apply(msg: RealtimeMessage): boolean {
		if (msg.type !== "delta" && msg.type !== "phrase") return false;
		let part = this.parts.get(msg.item);
		if (!part) {
			part = { text: "", final: false };
			this.parts.set(msg.item, part);
			this.order.push(msg.item);
		}
		if (msg.type === "delta") {
			if (part.final) return false;
			part.text += msg.text;
		} else {
			part.text = msg.text;
			part.final = true;
		}
		return true;
	}

	get text(): string {
		return this.order.map((id) => this.parts.get(id)!.text.trim()).filter(Boolean).join(" ");
	}
}

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
