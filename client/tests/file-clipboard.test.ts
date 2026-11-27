import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	MAX_CLIPBOARD_FILE_BYTES,
	canInterceptCopyKey,
	copyFile,
	fileCopyMessage,
	isCopyShortcut,
	isTextInputTarget,
	type FileClipboardInvoke,
	type FileCopyResult,
} from "../src/lib/clipboard";
import { setLang } from "../src/lib/i18n";
import { isDesktopTauri } from "../src/lib/tauri";
import { disposeVideoPlayer, videoPlayer } from "../src/lib/video-view";

const origWindow = globalThis.window;
const origDocument = globalThis.document;
const origNavigator = globalThis.navigator;
const origElement = globalThis.Element;
const origEvent = globalThis.Event;
const origKeyboardEvent = globalThis.KeyboardEvent;

function restoreGlobals() {
	(globalThis as { window?: unknown }).window = origWindow;
	(globalThis as { document?: unknown }).document = origDocument;
	(globalThis as { navigator?: unknown }).navigator = origNavigator;
	(globalThis as { Element?: unknown }).Element = origElement;
	(globalThis as { Event?: unknown }).Event = origEvent;
	(globalThis as { KeyboardEvent?: unknown }).KeyboardEvent = origKeyboardEvent;
}

beforeEach(() => {
	setLang("ko");
});

afterEach(() => {
	restoreGlobals();
});

afterAll(() => {
	setLang("en");
});

describe("isDesktopTauri", () => {
	test("returns false in plain browsers and mobile Tauri shells, true on desktop Tauri", () => {
		const mockEnv = (tauri: boolean, ua: string, platform = "Win32", maxTouchPoints = 0) => {
			(globalThis as { window?: unknown }).window = tauri ? { __TAURI_INTERNALS__: {} } : {};
			(globalThis as { navigator?: unknown }).navigator = { userAgent: ua, platform, maxTouchPoints };
		};

		mockEnv(false, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		expect(isDesktopTauri()).toBe(false);

		mockEnv(true, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		expect(isDesktopTauri()).toBe(true);

		mockEnv(true, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
		expect(isDesktopTauri()).toBe(true);

		mockEnv(true, "Mozilla/5.0 (X11; Linux x86_64)");
		expect(isDesktopTauri()).toBe(true);

		mockEnv(true, "Mozilla/5.0 (Linux; Android 15; Pixel 9)");
		expect(isDesktopTauri()).toBe(false);

		mockEnv(true, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
		expect(isDesktopTauri()).toBe(false);

		// iPadOS requesting desktop site
		mockEnv(true, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", "MacIntel", 5);
		expect(isDesktopTauri()).toBe(false);
	});
});

describe("copyFile", () => {
	test("returns unsupported without invoking when not on desktop Tauri", async () => {
		let called = false;
		const invoke: FileClipboardInvoke = async () => {
			called = true;
		};
		const res = await copyFile(new Blob(["mp4"]), "clip.mp4", { supported: () => false, invoke });
		expect(res).toBe("unsupported");
		expect(called).toBe(false);
	});

	test("sends raw Uint8Array bytes and percent-encoded UTF-8 filename header", async () => {
		let gotCmd = "";
		let gotBytes: Uint8Array | null = null;
		let gotHeader = "";
		const invoke: FileClipboardInvoke = async (cmd, payload, options) => {
			gotCmd = cmd;
			gotBytes = payload;
			gotHeader = options.headers["x-file-name"] ?? "";
		};
		const payload = new Uint8Array([0, 1, 2, 255]);
		const res = await copyFile(new Blob([payload], { type: "video/mp4" }), "최종 영상 (1).mp4", {
			supported: () => true,
			invoke,
		});
		expect(res).toBe("ok");
		expect(gotCmd).toBe("copy_file_to_clipboard");
		expect([...gotBytes!]).toEqual([0, 1, 2, 255]);
		expect(decodeURIComponent(gotHeader)).toBe("최종 영상 (1).mp4");
	});

	test("handles empty filename fallback and zero-byte files", async () => {
		let gotHeader = "";
		let gotLen = -1;
		const invoke: FileClipboardInvoke = async (_cmd, payload, options) => {
			gotLen = payload.byteLength;
			gotHeader = options.headers["x-file-name"] ?? "";
		};
		const res = await copyFile(new Blob([]), "   ", { supported: () => true, invoke });
		expect(res).toBe("ok");
		expect(gotLen).toBe(0);
		expect(gotHeader).toBe("file");
	});

	test("rejects files larger than MAX_CLIPBOARD_FILE_BYTES without invoking (blob or knownSize)", async () => {
		let called = false;
		const fakeHugeBlob = {
			size: MAX_CLIPBOARD_FILE_BYTES + 1,
			arrayBuffer: async () => new ArrayBuffer(0),
		} as unknown as Blob;
		const res = await copyFile(fakeHugeBlob, "huge.mp4", {
			supported: () => true,
			invoke: async () => {
				called = true;
			},
		});
		expect(res).toBe("too_large");
		expect(called).toBe(false);

		const resKnown = await copyFile("blob:never-fetched", "huge.mp4", {
			supported: () => true,
			knownSize: MAX_CLIPBOARD_FILE_BYTES + 1,
			invoke: async () => {
				called = true;
			},
		});
		expect(resKnown).toBe("too_large");
		expect(called).toBe(false);
	});

	test("handles lone surrogates in filename without throwing URIError", async () => {
		let gotHeader = "";
		const res = await copyFile(new Blob(["ok"]), "bad\uD800name.mp4", {
			supported: () => true,
			invoke: async (_cmd, _payload, options) => {
				gotHeader = options.headers["x-file-name"] ?? "";
			},
		});
		expect(res).toBe("ok");
		expect(gotHeader.length).toBeGreaterThan(0);
	});

	test("maps backend errors cleanly to error or too_large", async () => {
		const errRes = await copyFile(new Blob(["x"]), "a.mp4", {
			supported: () => true,
			invoke: async () => {
				throw new Error("clipboard busy");
			},
		});
		expect(errRes).toBe("error");

		const largeRes = await copyFile(new Blob(["x"]), "a.mp4", {
			supported: () => true,
			invoke: async () => {
				throw new Error("file exceeds 268435456 byte limit");
			},
		});
		expect(largeRes).toBe("too_large");
	});
});

describe("fileCopyMessage", () => {
	test("formats localized messages for all outcomes", () => {
		expect(fileCopyMessage("ok")).toEqual({ text: "파일을 복사했습니다", ok: true });
		expect(fileCopyMessage("ok", "clip.mp4")).toEqual({ text: "clip.mp4을(를) 복사했습니다", ok: true });
		expect(fileCopyMessage("too_large")).toEqual({ text: "파일이 너무 커서 복사할 수 없습니다", ok: false });
		expect(fileCopyMessage("error")).toEqual({ text: "복사하지 못했습니다", ok: false });
		expect(fileCopyMessage("unsupported")).toEqual({ text: "복사하지 못했습니다", ok: false });
		setLang("en");
		expect(fileCopyMessage("ok")).toEqual({ text: "File copied", ok: true });
		expect(fileCopyMessage("too_large")).toEqual({ text: "File is too large to copy", ok: false });
	});
});

describe("copy shortcut guards", () => {
	test("matches Cmd+C on macOS and Ctrl+C elsewhere, supporting Dvorak/Colemak and Korean layouts", () => {
		// Non-Mac: Ctrl+C matches, Meta+C does not
		expect(isCopyShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, code: "KeyC", key: "c" }, false)).toBe(true);
		expect(isCopyShortcut({ ctrlKey: false, metaKey: true, shiftKey: false, altKey: false, code: "KeyC", key: "c" }, false)).toBe(false);
		// Mac: Cmd+C matches, Ctrl+C does not
		expect(isCopyShortcut({ ctrlKey: false, metaKey: true, shiftKey: false, altKey: false, code: "KeyC", key: "c" }, true)).toBe(true);
		expect(isCopyShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, code: "KeyC", key: "c" }, true)).toBe(false);
		// Dvorak: physical KeyI produces 'c' → matches; physical KeyC produces 'j' → does NOT match
		expect(isCopyShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, code: "KeyI", key: "c" }, false)).toBe(true);
		expect(isCopyShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, code: "KeyC", key: "j" }, false)).toBe(false);
		// Korean IME: physical KeyC produces 'ㅊ' → falls back to code === KeyC
		expect(isCopyShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, code: "KeyC", key: "ㅊ" }, false)).toBe(true);
		// Modifiers reject Shift/Alt
		expect(isCopyShortcut({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, code: "KeyC", key: "C" }, false)).toBe(false);
		expect(isCopyShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: true, code: "KeyC", key: "c" }, false)).toBe(false);
		expect(isCopyShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, code: "KeyV", key: "v" }, false)).toBe(false);
		expect(isCopyShortcut({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, code: "KeyC", key: "c" }, false)).toBe(false);
	});

	test("protects text inputs and active selections while allowing range sliders and buttons", () => {
		const win = new Window();
		const doc = win.document;
		(globalThis as { window?: unknown }).window = win;
		(globalThis as { document?: unknown }).document = doc;

		const ta = doc.createElement("textarea");
		const textInput = doc.createElement("input");
		textInput.type = "text";
		const rangeInput = doc.createElement("input");
		rangeInput.type = "range";
		const btn = doc.createElement("button");
		const editable = doc.createElement("div");
		editable.contentEditable = "true";
		doc.body.append(ta, textInput, rangeInput, btn, editable);

		expect(isTextInputTarget(ta as unknown as Element)).toBe(true);
		expect(isTextInputTarget(textInput as unknown as Element)).toBe(true);
		expect(isTextInputTarget(editable as unknown as Element)).toBe(true);
		expect(isTextInputTarget(rangeInput as unknown as Element)).toBe(false);
		expect(isTextInputTarget(btn as unknown as Element)).toBe(false);
		expect(isTextInputTarget(null)).toBe(false);

		const mkKey = (overrides: Partial<KeyboardEvent> = {}) =>
			({
				ctrlKey: true,
				metaKey: false,
				shiftKey: false,
				altKey: false,
				code: "KeyC",
				defaultPrevented: false,
				isComposing: false,
				...overrides,
			}) as KeyboardEvent;

		btn.focus();
		expect(canInterceptCopyKey(mkKey())).toBe(true);
		expect(canInterceptCopyKey(mkKey({ defaultPrevented: true }))).toBe(false);
		expect(canInterceptCopyKey(mkKey({ isComposing: true }))).toBe(false);

		rangeInput.focus();
		expect(canInterceptCopyKey(mkKey())).toBe(true);

		textInput.focus();
		expect(canInterceptCopyKey(mkKey())).toBe(false);

		btn.focus();
		win.getSelection = (() => ({ toString: () => "selected text" })) as unknown as typeof win.getSelection;
		expect(canInterceptCopyKey(mkKey())).toBe(false);

		win.close();
	});
});

describe("videoPlayer file clipboard integration", () => {
	function installDom() {
		const win = new Window();
		(globalThis as { window?: unknown }).window = win;
		(globalThis as { document?: unknown }).document = win.document;
		(globalThis as { navigator?: unknown }).navigator = win.navigator;
		(globalThis as { Element?: unknown }).Element = win.Element;
		(globalThis as { Event?: unknown }).Event = win.Event;
		(globalThis as { KeyboardEvent?: unknown }).KeyboardEvent = win.KeyboardEvent;
		return win;
	}

	test("hides copy button when unsupported (web/mobile)", () => {
		const win = installDom();
		const player = videoPlayer("blob:demo");
		win.document.body.append(player as unknown as Node);
		expect(player.querySelector(".wd-video-copy")).toBeNull();
		disposeVideoPlayer(player);
		win.close();
	});

	test("copies on Ctrl+C when focused, prevents concurrent copies, shows feedback, and cleans up on dispose", async () => {
		const win = installDom();
		let calls = 0;
		let finish!: (res: FileCopyResult) => void;
		const player = videoPlayer("blob:demo", {
			filename: "demo.mp4",
			onCopy: () => {
				calls++;
				return new Promise<FileCopyResult>((resolve) => {
					finish = resolve;
				});
			},
		});
		win.document.body.append(player as unknown as Node);

		const copyBtn = player.querySelector<HTMLButtonElement>(".wd-video-copy");
		expect(copyBtn).not.toBeNull();
		expect(copyBtn?.getAttribute("aria-label")).toBe("파일 복사");

		player.focus();
		const ev1 = new win.KeyboardEvent("keydown", { ctrlKey: true, code: "KeyC", bubbles: true, cancelable: true });
		win.dispatchEvent(ev1);
		expect(ev1.defaultPrevented).toBe(true);
		expect(calls).toBe(1);
		expect(copyBtn?.disabled).toBe(true);

		// Concurrent Ctrl+C while copy is still in flight must be ignored.
		const ev2 = new win.KeyboardEvent("keydown", { ctrlKey: true, code: "KeyC", bubbles: true, cancelable: true });
		win.dispatchEvent(ev2);
		expect(calls).toBe(1);

		finish("ok");
		await Promise.resolve();
		await Promise.resolve();

		expect(copyBtn?.disabled).toBe(false);
		const note = player.querySelector<HTMLElement>(".wd-video-note");
		expect(note?.classList.contains("show")).toBe(true);
		expect(note?.textContent).toContain("파일을 복사했습니다");

		// After dispose, Ctrl+C no longer triggers the player.
		disposeVideoPlayer(player);
		player.remove();
		const ev3 = new win.KeyboardEvent("keydown", { ctrlKey: true, code: "KeyC", bubbles: true, cancelable: true });
		win.dispatchEvent(ev3);
		expect(calls).toBe(1);

		win.close();
	});
});
