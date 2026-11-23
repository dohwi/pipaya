import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Api, VoiceView } from "../src/lib/api";
import type { VoiceRemote as VoiceRemoteType } from "../src/lib/voice.svelte";
import {
	CONFIG_FAILURES, FAILURE_TEXT, failureHasFix, failureTone, MAX_RECORD_MS, MIME_CANDIDATES, TAP_MS, formatTime, isConfigFailure, micAvailability,
	micFailure, pickMimeType, PressToTalk, serverFailure, upstreamDetail, voiceState,
} from "../src/lib/voice";

describe("voiceState", () => {
	const base = { enabled: true, usable: true, failed: false, available: true };
	test("off until the user switches it on", () => {
		expect(voiceState({ ...base, enabled: false })).toBe("off");
		expect(voiceState({ ...base, enabled: false, usable: false, failed: true, available: false })).toBe("off");
	});
	test("unusable while the settings, the browser or the last test say no", () => {
		expect(voiceState({ ...base, usable: false })).toBe("unusable"); // no address or key
		expect(voiceState({ ...base, failed: true })).toBe("unusable"); // the last test failed
		expect(voiceState({ ...base, available: false })).toBe("unusable"); // insecure page, no MediaRecorder
	});
	test("ready when everything is in place, and also before the first test", () => {
		expect(voiceState(base)).toBe("ready");
		// the settings and the test live on the server: a device that never ran the test still gets the button
		expect(voiceState({ ...base, failed: false })).toBe("ready");
	});
	test("only a switched-off voice input has no button; every other state keeps it (disabled)", () => {
		// the button is drawn for "unusable" too — VoiceInput shows it disabled with the reason, never hidden
		expect(voiceState({ ...base, usable: false })).not.toBe("off");
		expect(voiceState({ ...base, failed: true })).not.toBe("off");
		expect(voiceState({ ...base, available: false })).not.toBe("off");
	});
});

describe("micAvailability", () => {
	test("a secure context with MediaRecorder and getUserMedia", () => {
		expect(micAvailability(true, true, true)).toBe("ok");
	});
	test("an insecure page is named before anything else", () => {
		expect(micAvailability(false, true, true)).toBe("insecure");
		expect(micAvailability(false, false, false)).toBe("insecure");
	});
	test("a browser without recording", () => {
		expect(micAvailability(true, false, true)).toBe("unsupported");
		expect(micAvailability(true, true, false)).toBe("unsupported");
	});
});

describe("failures", () => {
	test("microphone errors are named the way the pill explains them", () => {
		expect(micFailure({ name: "NotAllowedError" })).toBe("micDenied");
		expect(micFailure({ name: "SecurityError" })).toBe("micDenied");
		expect(micFailure({ name: "NotFoundError" })).toBe("noMic");
		expect(micFailure({ name: "NotReadableError" })).toBe("micBusy");
		expect(micFailure({ name: "AbortError" })).toBe("micBusy");
		expect(micFailure(new Error("?"))).toBe("micFailed");
		expect(micFailure(null)).toBe("micFailed");
	});
	test("server codes map to the same kinds; an unknown code is a server error", () => {
		expect(serverFailure("bad_key")).toBe("bad_key");
		expect(serverFailure("not_found")).toBe("not_found");
		expect(serverFailure("too_large")).toBe("too_large");
		expect(serverFailure("timeout")).toBe("timeout");
		expect(serverFailure("rate_limited")).toBe("rate_limited");
		expect(serverFailure("weird_new_code")).toBe("upstream_error");
	});
	test("the transcription server's own reason is read from the error's detail", () => {
		expect(upstreamDetail({ detail: " unknown model " })).toBe("unknown model");
		expect(upstreamDetail({ detail: "" })).toBeNull();
		expect(upstreamDetail({ detail: 3 })).toBeNull();
		expect(upstreamDetail(undefined)).toBeNull();
	});
	test("only settings problems take the button away; a passing network error leaves it", () => {
		for (const kind of CONFIG_FAILURES) expect(isConfigFailure(kind)).toBe(true);
		for (const kind of ["network", "timeout", "rate_limited", "tooShort", "tooBig", "micDenied", "empty", "aborted"] as const) expect(isConfigFailure(kind)).toBe(false);
	});
	test("every failure has a sentence", () => {
		for (const [kind, text] of Object.entries(FAILURE_TEXT)) expect({ kind, empty: !text }).toEqual({ kind, empty: false });
	});
	test("severity: nothing heard is a warning, a rejected key or timeout an error, a cancel a note", () => {
		expect(failureTone("empty")).toBe("warn");
		expect(failureTone("tooShort")).toBe("warn");
		for (const kind of ["bad_key", "timeout", "upstream_error", "network", "micDenied"] as const) expect(failureTone(kind)).toBe("error");
		expect(failureTone("aborted")).toBe("info");
	});
	test("settings problems and timeouts offer the way to Settings; the rest do not", () => {
		for (const kind of [...CONFIG_FAILURES, "timeout"] as const) expect(failureHasFix(kind)).toBe(true);
		for (const kind of ["empty", "tooShort", "micDenied", "network", "aborted"] as const) expect(failureHasFix(kind)).toBe(false);
	});
});

describe("recording helpers", () => {
	test("the first supported format wins, and none is fine", () => {
		expect(pickMimeType(() => true)).toBe(MIME_CANDIDATES[0]);
		expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
		expect(pickMimeType(() => false)).toBe("");
		expect(pickMimeType(() => { throw new Error("no"); })).toBe("");
	});
	test("the pill's clock", () => {
		expect(formatTime(0)).toBe("0:00");
		expect(formatTime(9_500)).toBe("0:09");
		expect(formatTime(65_000)).toBe("1:05");
		expect(formatTime(-5)).toBe("0:00");
	});
	test("a tap and a hold are told apart at 300 ms, and a recording may run five minutes", () => {
		expect(TAP_MS).toBe(300);
		expect(MAX_RECORD_MS).toBe(5 * 60 * 1000);
	});
});

describe("press to talk", () => {
	function rig(recording = false) {
		let clock = 0;
		const log: string[] = [];
		const state = { recording };
		const press = new PressToTalk({
			busy: () => state.recording,
			start: () => { log.push("start"); state.recording = true; },
			stop: () => { log.push("stop"); state.recording = false; },
			now: () => clock,
		});
		return { press, log, state, wait: (ms: number) => (clock += ms) };
	}
	test("recording starts as the press goes down, before it is known to be a tap or a hold", () => {
		const { press, log } = rig();
		press.down();
		expect(log).toEqual(["start"]);
		expect(press.active).toBe(true);
	});
	test("a tap starts recording and keeps it going", () => {
		const { press, log, state, wait } = rig();
		press.down();
		wait(TAP_MS - 1);
		expect(press.up()).toBe("keep");
		expect(log).toEqual(["start"]);
		expect(state.recording).toBe(true);
	});
	test("a hold records only while held", () => {
		const { press, log, state, wait } = rig();
		press.down();
		wait(TAP_MS);
		expect(press.up()).toBe("stop");
		expect(log).toEqual(["start", "stop"]);
		expect(state.recording).toBe(false);
	});
	test("a tap while recording stops it, and so does a hold", () => {
		for (const ms of [10, TAP_MS * 3]) {
			const { press, log, wait } = rig(true);
			press.down();
			wait(ms);
			expect(press.up()).toBe("stop");
			expect(log).toEqual(["stop"]);
		}
	});
	test("tap, tap: on then off", () => {
		const { press, log, state, wait } = rig();
		press.down(); wait(50); press.up();
		wait(2000);
		press.down(); wait(50); press.up();
		expect(log).toEqual(["start", "stop"]);
		expect(state.recording).toBe(false);
	});
	test("a cancelled press stops what it started, even a tap's", () => {
		const { press, log } = rig();
		press.down();
		press.cancel();
		expect(log).toEqual(["start", "stop"]);
		expect(press.active).toBe(false);
	});
	test("a second down (key repeat) and an up without a press do nothing", () => {
		const { press, log, wait } = rig();
		press.down(); press.down(); press.down();
		expect(log).toEqual(["start"]);
		wait(TAP_MS); press.up();
		expect(press.up()).toBeNull();
		press.cancel();
		expect(log).toEqual(["start", "stop"]);
	});
});

describe("VoiceRemote", () => {
	let VoiceRemote: typeof VoiceRemoteType;
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "pipaya-voice-remote-"));
		const srcPath = resolve("src/lib/voice.svelte.ts");
		const build = await Bun.build({
			entrypoints: [srcPath],
			target: "bun",
			plugins: [
				{
					name: "voice-runes",
					setup(builder) {
						builder.onResolve({ filter: /^\.\/store\.svelte$/ }, () => ({ path: "store-stub", namespace: "stub" }));
						builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
							contents: "export const app = { prefs: { soundOn: false, cue() {} }, activeId: null, liveText: null, insertIntoComposer() {}, toast() {}, openSettings() {} };",
							loader: "js",
						}));
						builder.onLoad({ filter: /voice\.svelte\.ts$/ }, async ({ path }) => {
							const raw = await Bun.file(path).text();
							const transpiled = ts.transpileModule(raw, {
								compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
							}).outputText;
							return { contents: compileModule(transpiled, { filename: path, generate: "client" }).js.code, loader: "js" };
						});
					},
				},
			],
		});
		if (!build.success) throw new Error(build.logs.join("\n"));
		const file = join(dir, "voice.mjs");
		await writeFile(file, await build.outputs[0]!.text());
		VoiceRemote = (await import(file)).VoiceRemote;
	});

	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	const makeView = (over: Partial<VoiceView> = {}): VoiceView => ({
		settings: {
			enabled: true,
			baseUrl: "https://ai.example.com",
			path: "",
			model: "gpt-transcribe",
			language: "ko",
			mode: "realtime",
			realtime: { url: "wss://ai.example.com/v1/realtime", model: "gpt-realtime-2.1", transcribeModel: "gpt-live-transcribe", keywords: [], prompt: "" },
		},
		hasKey: true,
		hasRealtimeKey: true,
		realtimeEndpoint: "wss://ai.example.com/v1/realtime?model=gpt-realtime-2.1",
		defaults: { enabled: false, baseUrl: "", path: "", model: "", language: "" },
		defaultPath: "/v1/audio/transcriptions",
		endpoint: "https://ai.example.com/v1/audio/transcriptions",
		test: { ok: true, at: 1000, reason: null },
		...over,
	});

	test("ignores stale load response when superseded by a newer server load", async () => {
		const remote = new VoiceRemote();
		let resolveSlow!: (v: VoiceView) => void;
		const slowApi = {
			voice: () => new Promise<VoiceView>((r) => { resolveSlow = r; }),
		} as unknown as Api;
		const fastApi = {
			voice: async () => makeView({ settings: { enabled: true, baseUrl: "", path: "", model: "", language: "en", mode: "file" }, realtimeEndpoint: null }),
		} as unknown as Api;

		const pSlow = remote.load(slowApi, "server-a");
		const pFast = remote.load(fastApi, "server-b");
		await pFast;
		expect(remote.loaded).toBe(true);
		expect(remote.settings.mode).toBe("file");
		expect(remote.settings.language).toBe("en");

		resolveSlow(makeView());
		await pSlow;
		// server-a's late response must not overwrite server-b
		expect(remote.settings.mode).toBe("file");
		expect(remote.settings.language).toBe("en");
	});

	test("refreshes capabilities when re-loaded on the same server (e.g. after server upgrade)", async () => {
		const remote = new VoiceRemote();
		const oldApi = {
			voice: async () => makeView({ settings: { enabled: true, baseUrl: "https://ai.example.com", path: "", model: "gpt-transcribe", language: "ko" }, hasRealtimeKey: undefined, realtimeEndpoint: undefined }),
		} as unknown as Api;
		const upgradedApi = {
			voice: async () => makeView(),
		} as unknown as Api;

		await remote.load(oldApi, "ubuntu");
		expect(remote.settings.mode).toBeUndefined();

		await remote.load(upgradedApi, "ubuntu");
		expect(remote.settings.mode).toBe("realtime");
		expect(remote.realtime).toBe(true);
		expect(remote.state).toBe("ready");
	});

	test("save supersedes an in-flight load", async () => {
		const remote = new VoiceRemote();
		let resolveLoad!: (v: VoiceView) => void;
		const api = {
			voice: () => new Promise<VoiceView>((r) => { resolveLoad = r; }),
			saveVoice: async (settings: VoiceView["settings"]) => makeView({ settings }),
		} as unknown as Api;

		const pLoad = remote.load(api, "ubuntu");
		const err = await remote.save(makeView().settings, undefined, "new-key");
		expect(err).toBeNull();
		expect(remote.settings.mode).toBe("realtime");

		resolveLoad(makeView({ settings: { enabled: false, baseUrl: "", path: "", model: "", language: "", mode: "file" } }));
		await pLoad;
		expect(remote.settings.mode).toBe("realtime");
		expect(remote.settings.enabled).toBe(true);
	});
});
