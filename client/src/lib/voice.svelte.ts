/**
 * Voice input, client side: the server's settings, the connection test, and the recorder. One small store so the
 * composer button and Settings > Voice read the same state, and a change in Settings shows the button at once.
 *
 * The microphone is offered only when voice input is on and the last connection test passed (`voiceState`). The test
 * runs on the server and its result is stored there, so a phone, a desktop and a browser on the same server agree on
 * whether the microphone works; a configuration failure (a rejected key, a wrong path) turns it off again until the
 * user fixes it and tests, and a passing network hiccup leaves it on, so a lost packet does not hide the button.
 */
import { Api, ApiError, type VoiceSettings, type VoiceView } from "./api";
import { app } from "./store.svelte";
import { t } from "./i18n";
import { swallowClick } from "./press-menu";
import {
	MAX_RECORD_MS, MAX_UPLOAD_BYTES, MIN_RECORD_MS, FAILURE_TEXT, failureHasFix, failureTone, isConfigFailure, micAvailability, micFailure, pickMimeType,
	PressToTalk, serverFailure, voiceState, type VoiceFailure, type VoiceState,
} from "./voice";

/**
 * What the last connection test concluded, as the server keeps it (null when no test has run since the settings were
 * saved). `reason` is a failure kind (`VoiceFailure`), not a sentence, so each device says it in its own language.
 */
export type Tested = { at: number; ok: boolean; reason?: VoiceFailure };

class VoiceStore {
	settings = $state<VoiceSettings>({ enabled: false, baseUrl: "", path: "", model: "", language: "" });
	hasKey = $state(false);
	endpoint = $state<string | null>(null);
	/** The settings came from the server at least once. */
	loaded = $state(false);
	loading = $state(false);
	/** The last connection test: `null` = not run since these settings were saved. */
	tested = $state<Tested | null>(null);
	testing = $state(false);
	/** Why the microphone cannot work in this browser at all (`insecure`, `unsupported`), or null. */
	availability = $state<"insecure" | "unsupported" | null>(null);
	/** A recording is running (the pill shows the time). */
	recording = $state(false);
	transcribing = $state(false);
	/** The last failure, shown in the pill and as a toast; cleared when the next recording starts. */
	failure = $state<VoiceFailure | null>(null);
	/** Seconds recorded so far, for the pill. */
	elapsed = $state(0);

	private api: Api | null = null;
	/** The server these settings came from, so switching servers clears what the other one had. */
	private lastServer = "";
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private startedAt = 0;
	/** The running transcription's controller, so its cancel can stop the request. */
	private transcribeAbort: AbortController | null = null;
	/** When the transcription began (performance.now), for the panel's elapsed clock. */
	transcribeStartedAt = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private stream: MediaStream | null = null;
	/** The microphone is being opened (a permission prompt may be up); `recording` follows once it is. */
	private opening = false;
	/** A stop or cancel came while the microphone was still opening: close it as soon as it opens instead of recording. */
	private stopRequested = false;
	/** The pane the recording belongs to: the text goes back into that composer. */
	paneId = $state<string | null>(null);

	/** Called when the open server changes (or on start, or when another device saved the settings): read its voice settings. */
	async load(api: Api | null, serverKey: string) {
		this.api = api;
		if (serverKey !== this.lastServer) {
			this.lastServer = serverKey;
			this.settings = { enabled: false, baseUrl: "", path: "", model: "", language: "" };
			this.hasKey = false;
			this.endpoint = null;
			this.loaded = false;
			this.tested = null;
		}
		if (!api) return;
		this.loading = true;
		try {
			const view = await api.voice(AbortSignal.timeout(5000));
			this.apply(view);
		} catch {
			/* offline: keep what is shown, the settings screen says the server could not be read */
		} finally {
			this.loading = false;
		}
	}

	/**
	 * Takes the server's answer. The settings are applied first and on their own: an older server (before the test
	 * moved into its database) answers without `test`, and an exception on that one field used to throw away the whole
	 * answer — the pane stayed empty and the microphone stayed hidden although everything was configured.
	 */
	private apply(view: VoiceView) {
		this.settings = view.settings;
		this.hasKey = view.hasKey;
		this.endpoint = view.endpoint;
		this.tested = readTest(view.test);
		this.loaded = true;
	}

	/** Whether the browser can record at all; computed once, when the app starts. */
	probe() {
		const secure = typeof window !== "undefined" && (window.isSecureContext || location.protocol === "https:" || location.protocol === "tauri:");
		const hasRecorder = typeof MediaRecorder !== "undefined";
		const hasGetUserMedia = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
		const state = micAvailability(secure, hasRecorder, hasGetUserMedia);
		this.availability = state === "ok" ? null : state;
	}

	get state(): VoiceState {
		return voiceState({
			enabled: this.settings.enabled,
			usable: !!this.endpoint && this.hasKey,
			// a test that has not run yet is not a failure: the settings alone are enough to try the microphone
			failed: this.tested?.ok === false,
			available: this.availability === null,
		});
	}

	/** Recording, or the microphone is still being opened for a recording. */
	get busy() {
		return this.recording || this.opening;
	}

	/** The button in the composer: shown whenever voice input is on, disabled while it cannot record. */
	get visible() {
		return this.state !== "off";
	}

	/** The button records right now (on, configured and this browser can open a microphone). */
	get ready() {
		return this.state === "ready";
	}

	/** Why the microphone cannot be used, or null when it is fine. The button's tooltip and the settings row say it. */
	get blockedReason(): string | null {
		if (this.availability) return t(this.availability === "insecure" ? "마이크는 HTTPS 화면이나 앱에서만 켜집니다. pipaya를 https 주소로 열거나 앱에서 사용하세요." : "이 브라우저는 녹음을 지원하지 않습니다.");
		if (!this.settings.enabled) return null;
		if (!this.settings.baseUrl) return t("변환 서버 주소를 입력하세요.");
		if (!this.hasKey) return t("변환 API 키를 입력하세요.");
		// only a test that failed blocks it; an untested setup is offered and the first recording reports the problem
		if (this.tested && !this.tested.ok) return (this.tested.reason && FAILURE_TEXT[this.tested.reason]) || t("연결 확인에 실패했습니다.");
		return null;
	}

	async save(next: VoiceSettings, apiKey: string | undefined): Promise<string | null> {
		if (!this.api) return t("서버에 연결할 수 없습니다");
		try {
			// the server forgets the old test with the new settings, and answers with the cleared state
			const view = await this.api.saveVoice(next, apiKey);
			this.apply(view);
			return null;
		} catch (cause) {
			return cause instanceof ApiError ? cause.message : t("저장하지 못했습니다");
		}
	}

	/** The connection test: a second of silence through the server to the configured endpoint. */
	async test(): Promise<{ ok: boolean; message: string }> {
		if (!this.api) return { ok: false, message: t("서버에 연결할 수 없습니다") };
		this.testing = true;
		try {
			const result = await this.api.testVoice(AbortSignal.timeout(70_000));
			// An empty transcript is a pass: silence has nothing to say, and the answer was well formed.
			this.tested = { at: Date.now(), ok: true };
			return { ok: true, message: result.text ? t("연결되었습니다: {text}", { text: result.text }) : t("연결되었습니다. 입력창에 마이크가 나타납니다.") };
		} catch (cause) {
			const failure = cause instanceof ApiError ? serverFailure(cause.code) : "network";
			this.tested = { at: Date.now(), ok: false, reason: failure };
			return { ok: false, message: FAILURE_TEXT[failure] };
		} finally {
			this.testing = false;
		}
	}

	/** Starts recording into `paneId`. Returns a failure kind when the microphone could not be opened. */
	async start(paneId: string): Promise<VoiceFailure | null> {
		if (this.recording || this.opening || this.transcribing) return null;
		this.failure = null;
		this.paneId = paneId;
		this.opening = true;
		this.stopRequested = false;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
		} catch (cause) {
			this.opening = false;
			const failure = micFailure(cause);
			this.fail(failure);
			return failure;
		}
		this.opening = false;
		// let go (or cancelled) while the permission prompt was up: nothing of what was meant to be said got recorded
		if (this.stopRequested) {
			this.stopRequested = false;
			for (const track of stream.getTracks()) track.stop();
			return null;
		}
		const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
		const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
		this.stream = stream;
		this.recorder = recorder;
		this.chunks = [];
		recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
		recorder.onstop = () => { void this.finish(); };
		recorder.start();
		this.recording = true;
		this.startedAt = performance.now();
		this.elapsed = 0;
		this.timer = setInterval(() => {
			this.elapsed = performance.now() - this.startedAt;
			if (this.elapsed >= MAX_RECORD_MS) this.stop();
		}, 200);
		return null;
	}

	/** Stops recording; what was recorded is transcribed and inserted into the composer it started from. */
	stop() {
		if (this.opening) this.stopRequested = true;
		if (!this.recording) return;
		this.recording = false;
		clearInterval(this.timer);
		this.timer = undefined;
		const duration = performance.now() - this.startedAt;
		const recorder = this.recorder;
		this.recorder = null;
		if (duration < MIN_RECORD_MS) {
			this.discard(recorder);
			this.fail("tooShort");
			return;
		}
		if (recorder && recorder.state !== "inactive") recorder.stop();
	}

	/** Throws the recording away (the pill's cancel). */
	cancel() {
		if (this.opening) this.stopRequested = true;
		if (!this.recording) return;
		this.recording = false;
		clearInterval(this.timer);
		this.timer = undefined;
		const recorder = this.recorder;
		this.recorder = null;
		this.discard(recorder);
	}

	/**
	 * Ends a recording without transcribing it. `stop()` still hands over the last chunk (`dataavailable`) and then
	 * `onstop` uploads it, so the handlers go first; emptying `chunks` alone let a cancelled recording be transcribed.
	 */
	private discard(recorder: MediaRecorder | null) {
		if (recorder) {
			recorder.ondataavailable = null;
			recorder.onstop = null;
			if (recorder.state !== "inactive") recorder.stop();
		}
		this.chunks = [];
		this.releaseStream();
	}

	/** The recording is over: upload it and hand the text to the composer. */
	private async finish() {
		const chunks = this.chunks;
		this.chunks = [];
		this.releaseStream();
		if (!chunks.length) return;
		const blob = new Blob(chunks, { type: chunks[0]!.type || "audio/webm" });
		if (blob.size > MAX_UPLOAD_BYTES) return this.fail("tooBig");
		if (!this.api) return this.fail("network");
		const paneId = this.paneId;
		this.transcribing = true;
		this.transcribeStartedAt = performance.now();
		const abort = new AbortController();
		this.transcribeAbort = abort;
		let timedOut = false;
		// not AbortSignal.timeout/any: older webviews lack them
		const limit = setTimeout(() => { timedOut = true; abort.abort(); }, 70_000);
		try {
			const text = await this.api.transcribe(blob, this.settings.language, abort.signal);
			if (!text.trim()) return this.fail("empty");
			// "" is the new-chat composer: the text goes there, and a fresh chat becomes a pane when it is sent.
			app.insertIntoComposer(paneId ?? "", text.trim());
		} catch (cause) {
			// the user's own cancel is an answer, not a failure: no chip, no toast
			if (abort.signal.aborted && !timedOut) return;
			const failure = timedOut ? "timeout" : cause instanceof ApiError ? serverFailure(cause.code) : (cause as Error)?.name === "AbortError" ? "aborted" : "network";
			this.fail(failure);
		} finally {
			clearTimeout(limit);
			this.transcribeAbort = null;
			this.transcribing = false;
		}
	}

	/** Gives up on the transcription in flight (the panel's cancel): nothing is inserted. */
	cancelTranscribe() {
		this.transcribeAbort?.abort();
	}

	private releaseStream() {
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = null;
	}

	/** The live microphone stream while recording, for the pill's waveform. */
	analyserStream(): MediaStream | null {
		return this.recording ? this.stream : null;
	}

	/** Records a failure: the pill says it, and a settings problem also takes the button away until it is fixed. */
	fail(failure: VoiceFailure) {
		this.failure = failure;
		// severity: nothing heard or too short is a nudge (warn); a rejected key, a timeout, a server error is an error,
		// and a settings problem carries the way to Settings > Voice
		const tone = failureTone(failure);
		const fix = failureHasFix(failure) ? { label: t("설정에서 고치기"), run: () => app.openSettings("voice") } : undefined;
		app.toast(t(FAILURE_TEXT[failure]), tone, this.paneId ?? undefined, fix);
		// The server records a settings failure it finds itself (see POST /voice/transcribe), so every device hides the
		// microphone at once; here the local state follows without a round trip.
		if (isConfigFailure(failure)) this.tested = { at: Date.now(), ok: false, reason: failure };
	}

	clearFailure() {
		this.failure = null;
	}
}

/** The server's `test` field, or null when it is missing (an older server) or says no test has run. */
function readTest(test: VoiceView["test"] | undefined): Tested | null {
	if (!test || typeof test !== "object") return null;
	if (typeof test.ok !== "boolean" || typeof test.at !== "number") return null;
	return { ok: test.ok, at: test.at, reason: (test.reason as VoiceFailure | null) ?? undefined };
}

export const voice = new VoiceStore();

/** The voice shortcut's press (see `onShortcut` / `onShortcutUpCapture`): it records into the open pane. */
export const voiceKeyPress = new PressToTalk({ busy: () => voice.busy, start: () => voice.start(app.activeId ?? ""), stop: () => voice.stop() });

/** The composer the microphone button was pressed in. */
let buttonPane = "";
const buttonPress = new PressToTalk({ busy: () => voice.busy, start: () => voice.start(buttonPane), stop: () => voice.stop() });

/**
 * The microphone button went down. The press is followed here, on the window, not on the button: the button leaves the
 * page as soon as recording starts (the toolbar row becomes the recording row), so its own pointerup never comes.
 * While the press lasts a long-press context menu is held off, and the click that follows the lift is swallowed so it
 * cannot land on the recording row's buttons that took the button's place. A touch also ends on the button itself: a
 * touch's events keep going to the node it began on even after that node left the page (iOS sends `touchend` only
 * there), so whichever of the two arrives first ends the press.
 */
export function pressMic(e: PointerEvent, paneId: string) {
	if (buttonPress.active || !voice.ready) return;
	voice.clearFailure();
	buttonPane = paneId;
	const id = e.pointerId;
	const node = e.currentTarget as HTMLElement | null;
	const noMenu = (ev: Event) => ev.preventDefault();
	const off = () => {
		node?.removeEventListener("touchend", touchEnd);
		node?.removeEventListener("touchcancel", touchEnd);
		window.removeEventListener("pointerup", end, true);
		window.removeEventListener("pointercancel", end, true);
		window.removeEventListener("blur", lost);
		window.removeEventListener("contextmenu", noMenu, true);
	};
	const end = (ev: PointerEvent) => {
		if (ev.pointerId !== id) return;
		off();
		if (ev.type === "pointerup") {
			buttonPress.up();
			swallowClick();
		} else buttonPress.cancel();
	};
	const touchEnd = (ev: TouchEvent) => {
		off();
		if (ev.type === "touchend") {
			buttonPress.up();
			swallowClick();
		} else buttonPress.cancel();
	};
	const lost = () => {
		off();
		buttonPress.cancel();
	};
	if (e.pointerType === "touch") {
		node?.addEventListener("touchend", touchEnd);
		node?.addEventListener("touchcancel", touchEnd);
	}
	window.addEventListener("pointerup", end, true);
	window.addEventListener("pointercancel", end, true);
	window.addEventListener("blur", lost);
	window.addEventListener("contextmenu", noMenu, true);
	buttonPress.down();
}
