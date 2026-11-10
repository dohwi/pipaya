import { describe, expect, test } from "bun:test";
import {
	CONFIG_FAILURES, FAILURE_TEXT, failureHasFix, failureTone, MAX_RECORD_MS, MIME_CANDIDATES, TAP_MS, formatTime, isConfigFailure, micAvailability,
	micFailure, pickMimeType, PressToTalk, serverFailure, voiceState,
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
		expect(serverFailure("weird_new_code")).toBe("upstream_error");
	});
	test("only settings problems take the button away; a passing network error leaves it", () => {
		for (const kind of CONFIG_FAILURES) expect(isConfigFailure(kind)).toBe(true);
		for (const kind of ["network", "timeout", "tooShort", "tooBig", "micDenied", "empty", "aborted"] as const) expect(isConfigFailure(kind)).toBe(false);
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
