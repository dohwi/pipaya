/**
 * Voice input, the parts that do not touch the DOM: which browser format to record, how long a recording may be, how a
 * failure reads, and the three states the microphone button is shown in. Pure, so the state machine and the messages
 * can be tested without a browser.
 */
import { msg } from "./i18n";

/** One recording may be five minutes; the server refuses more than 12 MB, which is well above that. */
export const MAX_RECORD_MS = 5 * 60 * 1000;
/** Below this a recording is a click, not speech. */
export const MIN_RECORD_MS = 400;
/** The server's cap, mirrored so the client stops before an upload it knows will be refused. */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
/** A tap shorter than this toggles recording; a longer press records while held (the "both" shortcut mode). */
export const TAP_MS = 300;

/** Preference order: what Chrome/Firefox (webm, ogg) and Safari (mp4) record. The server sniffs the container anyway. */
export const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

export function pickMimeType(isSupported: (type: string) => boolean): string {
	for (const type of MIME_CANDIDATES) {
		try {
			if (isSupported(type)) return type;
		} catch {
			/* try the next one */
		}
	}
	return "";
}

/** `m:ss` for the recording pill. */
export function formatTime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Where the microphone can work at all: `getUserMedia` needs a secure context (https, localhost or the desktop app).
 * `secure` is `window.isSecureContext`, `hasRecorder` whether MediaRecorder exists.
 */
export function micAvailability(secure: boolean, hasRecorder: boolean, hasGetUserMedia: boolean): "ok" | "insecure" | "unsupported" {
	if (!secure) return "insecure";
	if (!hasRecorder || !hasGetUserMedia) return "unsupported";
	return "ok";
}

/** What the settings screen says about the microphone itself, before the server is even asked. */
export const AVAILABILITY_TEXT = {
	insecure: msg("마이크는 HTTPS 화면이나 앱에서만 켜집니다. pipaya를 https 주소로 열거나 앱에서 사용하세요."),
	unsupported: msg("이 브라우저는 녹음을 지원하지 않습니다."),
} as const;

/** The three states the composer button is shown in. */
export type VoiceState = "off" | "unusable" | "ready";

/**
 * `off`: the user has not switched voice input on — no button at all. `unusable`: on, but not usable yet (no address,
 * no key, the last connection test failed, or the browser cannot record) — the button is shown **disabled**, with the
 * reason as its tooltip and a tap that opens Settings. `ready`: on and usable — the button records.
 *
 * Hiding the button on `unusable` was the bug: a configured setup that had not been tested (or whose test lived in
 * another device's storage) left the user staring at a composer with no microphone and no way to find out why. Showing
 * it disabled says "this exists, here is what it needs", and the reason is one hover (or one tap) away.
 *
 * A test that has not run yet is not a failure: the settings alone are enough to try a recording.
 */
export function voiceState(o: { enabled: boolean; usable: boolean; failed: boolean; available: boolean }): VoiceState {
	if (!o.enabled) return "off";
	if (!o.available || !o.usable || o.failed) return "unusable";
	return "ready";
}

/** Why a recording or its upload failed, as the pill and the toast say it. */
export type VoiceFailure =
	| "micDenied" | "noMic" | "micBusy" | "micFailed" | "tooShort" | "tooBig" | "network" | "timeout"
	| "not_configured" | "bad_key" | "not_found" | "too_large" | "upstream_error" | "bad_response" | "empty" | "aborted";

/** The kinds that mean the settings are wrong: the button goes away until the user fixes them and tests again. */
export const CONFIG_FAILURES: readonly VoiceFailure[] = ["not_configured", "bad_key", "not_found", "bad_response", "upstream_error"];

export function micFailure(error: unknown): VoiceFailure {
	switch ((error as { name?: string } | null)?.name) {
		case "NotAllowedError":
		case "PermissionDeniedError":
		case "SecurityError":
			return "micDenied";
		case "NotFoundError":
		case "DevicesNotFoundError":
		case "OverconstrainedError":
			return "noMic";
		case "NotReadableError":
		case "TrackStartError":
		case "AbortError":
			return "micBusy";
		default:
			return "micFailed";
	}
}

/** The server's error code as a failure kind; unknown codes are a server error. */
export function serverFailure(code: string): VoiceFailure {
	const known: VoiceFailure[] = ["not_configured", "bad_key", "not_found", "too_large", "timeout", "upstream_error", "bad_response", "network"];
	return known.includes(code as VoiceFailure) ? (code as VoiceFailure) : "upstream_error";
}

export const FAILURE_TEXT: Record<VoiceFailure, string> = {
	micDenied: msg("마이크 권한이 거부되었습니다. 브라우저나 앱의 권한 설정에서 마이크를 허용한 뒤 다시 시도하세요."),
	noMic: msg("마이크를 찾을 수 없습니다. 장치 연결을 확인하세요."),
	micBusy: msg("마이크를 열 수 없습니다. 다른 앱이 쓰고 있을 수 있습니다."),
	micFailed: msg("마이크를 시작하지 못했습니다."),
	tooShort: msg("녹음이 너무 짧습니다."),
	tooBig: msg("녹음이 너무 깁니다. 더 짧게 나눠 말해 주세요."),
	network: msg("서버에 연결할 수 없습니다. 네트워크를 확인하세요."),
	timeout: msg("변환이 제한 시간 안에 끝나지 않았습니다."),
	not_configured: msg("설정 > 음성 입력에서 서버 주소와 API 키를 입력하고 연결을 확인하세요."),
	bad_key: msg("API 키가 거부되었습니다. 설정 > 음성 입력에서 키를 고치고 다시 확인하세요."),
	not_found: msg("변환 경로를 찾을 수 없습니다. 설정의 주소와 경로를 확인하세요."),
	too_large: msg("녹음이 너무 커서 서버가 거부했습니다. 더 짧게 나눠 말해 주세요."),
	upstream_error: msg("변환 서버가 오류를 돌려주었습니다. 주소·모델 설정을 확인하세요."),
	bad_response: msg("변환 서버의 응답을 읽을 수 없습니다. 주소와 경로를 확인하세요."),
	empty: msg("인식된 내용이 없습니다. 다시 말해 보세요."),
	aborted: msg("녹음을 취소했습니다."),
};

/**
 * The chip's short form of each failure. The toast and the chip's title carry the whole sentence (`FAILURE_TEXT`), so
 * the composer keeps one line and the detail stays one hover (or one screen reader) away.
 */
export const FAILURE_SUMMARY: Record<VoiceFailure, string> = {
	micDenied: msg("마이크 권한이 거부되었습니다"),
	noMic: msg("마이크를 찾을 수 없습니다"),
	micBusy: msg("마이크를 열 수 없습니다"),
	micFailed: msg("마이크를 시작하지 못했습니다"),
	tooShort: msg("녹음이 너무 짧습니다"),
	tooBig: msg("녹음이 너무 깁니다"),
	network: msg("서버에 연결할 수 없습니다"),
	timeout: msg("변환이 늦어지고 있습니다"),
	not_configured: msg("음성 입력 설정이 필요합니다"),
	bad_key: msg("API 키가 거부되었습니다"),
	not_found: msg("변환 경로를 찾을 수 없습니다"),
	too_large: msg("녹음이 너무 큽니다"),
	upstream_error: msg("변환 서버가 오류를 돌려주었습니다"),
	bad_response: msg("변환 응답을 읽을 수 없습니다"),
	empty: msg("인식된 내용이 없습니다"),
	aborted: msg("녹음을 취소했습니다"),
};

/** Whether a failure means the settings must be fixed before the button may show again. */
export const isConfigFailure = (failure: VoiceFailure) => CONFIG_FAILURES.includes(failure);
