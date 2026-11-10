import { describe, expect, test } from "bun:test";
import {
	CONFIG_FAILURES, FAILURE_SUMMARY, FAILURE_TEXT, MAX_RECORD_MS, MIME_CANDIDATES, TAP_MS, formatTime, isConfigFailure, micAvailability,
	micFailure, pickMimeType, serverFailure, voiceState,
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
	test("every failure has a short chip form, and it is shorter than the sentence", () => {
		for (const kind of Object.keys(FAILURE_TEXT) as (keyof typeof FAILURE_TEXT)[]) {
			const short = FAILURE_SUMMARY[kind];
			expect({ kind, empty: !short }).toEqual({ kind, empty: false });
			expect({ kind, shorter: short.length < FAILURE_TEXT[kind].length }).toEqual({ kind, shorter: true });
		}
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
