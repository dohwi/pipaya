/**
 * Voice input, client side: the server's settings, the connection test, and the recorder. One small store so the
 * composer button and Settings > Voice read the same state, and a change in Settings shows the button at once.
 *
 * The microphone is offered only when voice input is on and the last connection test passed (`voiceState`). A
 * configuration failure (a rejected key, a wrong path) turns it off again until the user fixes it and tests; a passing
 * network hiccup leaves it on, so a lost packet does not hide the button.
 */
import { Api, ApiError, type VoiceSettings } from "./api";
import { app } from "./store.svelte";
import { t } from "./i18n";
import {
	MAX_RECORD_MS, MAX_UPLOAD_BYTES, MIN_RECORD_MS, FAILURE_TEXT, isConfigFailure, micAvailability, micFailure, pickMimeType,
	serverFailure, voiceState, type VoiceFailure, type VoiceState,
} from "./voice";

const TESTED_KEY = "pipaya.voice.tested";

/** What the last connection test concluded, kept per server so a restart does not hide a working button. */
type Tested = { at: number; ok: boolean; reason?: string };

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
	private serverKey = "";
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private startedAt = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private stream: MediaStream | null = null;
	/** The pane the recording belongs to: the text goes back into that composer. */
	paneId = $state<string | null>(null);

	/** Called when the open server changes (or on start): read its voice settings. */
	async load(api: Api | null, serverKey: string) {
		this.api = api;
		if (serverKey !== this.serverKey) {
			this.serverKey = serverKey;
			this.settings = { enabled: false, baseUrl: "", path: "", model: "", language: "" };
			this.hasKey = false;
			this.endpoint = null;
			this.loaded = false;
			this.tested = readTested(serverKey);
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

	private apply(view: { settings: VoiceSettings; hasKey: boolean; endpoint: string | null }) {
		this.settings = view.settings;
		this.hasKey = view.hasKey;
		this.endpoint = view.endpoint;
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
			tested: this.tested?.ok === true,
			available: this.availability === null,
		});
	}

	/** The button in the composer: on, usable, tested and recordable. */
	get visible() {
		return this.state === "ready";
	}

	/** Why the settings screen shows the microphone as unusable, or null when it is fine. */
	get blockedReason(): string | null {
		if (this.availability) return t(this.availability === "insecure" ? "마이크는 HTTPS 화면이나 앱에서만 켜집니다. pipaya를 https 주소로 열거나 앱에서 사용하세요." : "이 브라우저는 녹음을 지원하지 않습니다.");
		if (!this.settings.enabled) return null;
		if (!this.settings.baseUrl) return t("서버 주소를 입력하세요.");
		if (!this.hasKey) return t("API 키를 입력하세요.");
		if (!this.tested) return t("연결을 확인하면 입력창에 마이크가 나타납니다.");
		if (!this.tested.ok) return this.tested.reason ?? t("연결 확인에 실패했습니다.");
		return null;
	}

	async save(next: VoiceSettings, apiKey: string | undefined): Promise<string | null> {
		if (!this.api) return t("서버에 연결할 수 없습니다");
		try {
			const view = await this.api.saveVoice(next, apiKey);
			this.apply(view);
			// any change of address, path, model or key invalidates the test
			this.markUntested();
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
			writeTested(this.serverKey, this.tested);
			return { ok: true, message: result.text ? t("연결되었습니다: {text}", { text: result.text }) : t("연결되었습니다. 입력창에 마이크가 나타납니다.") };
		} catch (cause) {
			const failure = cause instanceof ApiError ? serverFailure(cause.code) : "network";
			const message = FAILURE_TEXT[failure];
			this.tested = { at: Date.now(), ok: false, reason: message };
			writeTested(this.serverKey, this.tested);
			return { ok: false, message };
		} finally {
			this.testing = false;
		}
	}

	private markUntested() {
		this.tested = null;
		writeTested(this.serverKey, null);
	}

	/** Starts recording into `paneId`. Returns a failure kind when the microphone could not be opened. */
	async start(paneId: string): Promise<VoiceFailure | null> {
		if (this.recording || this.transcribing) return null;
		this.failure = null;
		this.paneId = paneId;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
		} catch (cause) {
			const failure = micFailure(cause);
			this.failure = failure;
			return failure;
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
		if (!this.recording) return;
		this.recording = false;
		clearInterval(this.timer);
		this.timer = undefined;
		const duration = performance.now() - this.startedAt;
		const recorder = this.recorder;
		this.recorder = null;
		if (recorder && recorder.state !== "inactive") recorder.stop();
		if (duration < MIN_RECORD_MS) {
			this.chunks = [];
			this.releaseStream();
			this.fail("tooShort");
		}
	}

	/** Throws the recording away (the pill's cancel). */
	cancel() {
		if (!this.recording) return;
		this.recording = false;
		clearInterval(this.timer);
		this.timer = undefined;
		const recorder = this.recorder;
		this.recorder = null;
		this.chunks = [];
		if (recorder && recorder.state !== "inactive") recorder.stop();
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
		try {
			const text = await this.api.transcribe(blob, this.settings.language, AbortSignal.timeout(70_000));
			if (!text.trim()) return this.fail("empty");
			// "" is the new-chat composer: the text goes there, and a fresh chat becomes a pane when it is sent.
			app.insertIntoComposer(paneId ?? "", text.trim());
		} catch (cause) {
			const failure = cause instanceof ApiError ? serverFailure(cause.code) : (cause as Error)?.name === "AbortError" ? "aborted" : "network";
			this.fail(failure);
		} finally {
			this.transcribing = false;
		}
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
		app.toast(FAILURE_TEXT[failure], failure === "aborted" ? "info" : "error", this.paneId ?? undefined);
		if (isConfigFailure(failure)) {
			this.tested = { at: Date.now(), ok: false, reason: FAILURE_TEXT[failure] };
			writeTested(this.serverKey, this.tested);
		}
	}

	clearFailure() {
		this.failure = null;
	}
}

function readTested(serverKey: string): Tested | null {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(`${TESTED_KEY}.${serverKey}`) ?? "null");
		if (raw && typeof raw === "object" && typeof (raw as Tested).ok === "boolean" && typeof (raw as Tested).at === "number") return raw as Tested;
	} catch {
		/* unreadable: untested */
	}
	return null;
}

function writeTested(serverKey: string, value: Tested | null) {
	try {
		if (value) localStorage.setItem(`${TESTED_KEY}.${serverKey}`, JSON.stringify(value));
		else localStorage.removeItem(`${TESTED_KEY}.${serverKey}`);
	} catch {
		/* storage full: the in-memory state still works */
	}
}

export const voice = new VoiceStore();
