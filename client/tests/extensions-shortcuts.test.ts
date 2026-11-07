import { describe, expect, test } from "bun:test";
import { ComponentHandlerSet, composing, MAX_SHORTCUTS, appConflict, checkShortcutFree, normalizeCombo, parseComponentHandlers, parseShortcutSpec, releasedByKeyUp, componentShortcuts } from "../src/lib/extensions/shortcuts";
import { readFileSync } from "node:fs";
import { DEFAULT_BINDINGS } from "../src/lib/keys";

const key = (code: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) =>
	({ code, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift });

describe("normalizeCombo", () => {
	test("keeps Ctrl/⌘ or Alt plus exactly one key, in the app's canonical order", () => {
		expect(normalizeCombo("Mod+Shift+K")).toBe("Mod+Shift+K");
		expect(normalizeCombo("Shift+Mod+k")).toBe("Mod+Shift+K");
		expect(normalizeCombo("Shift+Alt+Mod+1")).toBe("Mod+Alt+Shift+1");
		expect(normalizeCombo("Alt+Space")).toBe("Alt+Space");
		expect(normalizeCombo("Alt+ArrowUp")).toBe("Alt+ArrowUp");
	});
	test("refuses plain or shift-only combos, several keys, nothing but modifiers and repeats", () => {
		for (const bad of ["", "K", "Shift+K", "Mod+J+K", "Mod", "Mod+Shift", "Mod+Mod+K", "Ctrl+K", "Mod++K", "+K"]) expect(normalizeCombo(bad)).toBeNull();
	});
});

describe("parseShortcutSpec", () => {
	test("returns a fresh, canonical spec; hold is off unless asked", () => {
		expect(parseShortcutSpec({ id: "mic", label: "Mic", combo: "alt+M".replace("alt", "Alt") })).toEqual({ id: "mic", label: "Mic", combo: "Alt+M", hold: false });
		expect(parseShortcutSpec({ id: "mic", label: "Mic", combo: "Alt+M", hold: true }).hold).toBe(true);
	});
	test("a component decides hold itself, whatever the spec says", () => {
		expect(parseShortcutSpec({ id: "mic", label: "Mic", combo: "Alt+M" }, true).hold).toBe(true);
		expect(parseShortcutSpec({ id: "mic", label: "Mic", combo: "Alt+M", hold: true }, false).hold).toBe(false);
	});
	test("rejects bad ids, labels, combos and a non-boolean hold", () => {
		for (const spec of [null, [], { id: "Mic", label: "M", combo: "Alt+M" }, { id: "mic", label: "", combo: "Alt+M" }, { id: "mic", label: "x".repeat(61), combo: "Alt+M" }, { id: "mic", label: "M", combo: "M" }, { id: "mic", label: "M", combo: "Alt+M", hold: 1 }])
			expect(() => parseShortcutSpec(spec)).toThrow();
	});
});

describe("parseComponentHandlers", () => {
	test("needs down and/or up, both functions, and nothing else", () => {
		const down = () => {};
		expect(parseComponentHandlers({ down }).down).toBe(down);
		expect(parseComponentHandlers({ up: down }).up).toBe(down);
		for (const bad of [undefined, null, {}, { down: 1 }, { down, extra() {} }, down, [down]]) expect(() => parseComponentHandlers(bad)).toThrow();
	});
});

describe("checkShortcutFree", () => {
	const spec = (id: string, combo: string) => ({ id, label: id, combo, hold: false });
	test("same-extension duplicate IDs, the maximum and other extensions' combos are refused", () => {
		const have = [{ owner: "a", id: "one", combo: "Alt+A" }];
		expect(() => checkShortcutFree(have, "a", spec("one", "Alt+B"))).toThrow();
		expect(() => checkShortcutFree(have, "b", spec("one", "Alt+A"))).toThrow(/Alt\+A/);
		expect(() => checkShortcutFree(have, "a", spec("two", "Alt+A"))).toThrow(); // the same extension cannot hold a combo twice either
		expect(() => checkShortcutFree(have, "b", spec("one", "Alt+B"))).not.toThrow();
		const full = Array.from({ length: MAX_SHORTCUTS }, (_, i) => ({ owner: "a", id: `k${i}`, combo: `Alt+${i}` }));
		expect(() => checkShortcutFree(full, "a", spec("more", "Alt+Z"))).toThrow();
		expect(() => checkShortcutFree(full, "b", spec("more", "Alt+Z"))).not.toThrow();
	});
});

describe("appConflict", () => {
	test("names the app action bound to the combo, or whose longer shortcut starts with it", () => {
		const bindings: Record<string, string> = { ...DEFAULT_BINDINGS };
		const own = Object.entries(bindings).find(([, combo]) => /^Mod\+[A-Z]$/.test(combo))!;
		expect(appConflict(own[1], bindings)).toBe(own[0] as never);
		expect(appConflict("Alt+Q", { ...bindings })).toBeUndefined();
		expect(appConflict("Alt+Q", { ...bindings, toggleSidebar: "Alt+Q+W" })).toBe("toggleSidebar");
	});
});

describe("releasedByKeyUp", () => {
	test("the key of the combo ends the hold, an unrelated key does not", () => {
		expect(releasedByKeyUp("Alt+M", "M", key("KeyM", { alt: true }))).toBe(true);
		expect(releasedByKeyUp("Alt+M", "M", key("KeyK", { alt: true }))).toBe(false);
		expect(releasedByKeyUp("Alt+Space", "Space", key("Space", { alt: true }))).toBe(true);
	});
	test("letting go of a modifier the combo needs ends it, even while the key is still down (macOS sends no key keyup under ⌘)", () => {
		expect(releasedByKeyUp("Mod+Shift+K", "K", key("MetaLeft"))).toBe(true);
		expect(releasedByKeyUp("Mod+Shift+K", "K", key("ControlLeft", { shift: true }))).toBe(true);
		expect(releasedByKeyUp("Mod+Shift+K", "K", key("ShiftLeft", { meta: true }))).toBe(true);
		expect(releasedByKeyUp("Alt+M", "M", key("AltLeft"))).toBe(true);
	});
	test("a modifier the combo does not need, or one that is still covered by its twin, keeps it", () => {
		expect(releasedByKeyUp("Alt+M", "M", key("ShiftLeft", { alt: true }))).toBe(false);
		expect(releasedByKeyUp("Mod+K", "K", key("ControlLeft", { meta: true }))).toBe(false); // ⌘ is still down
		expect(releasedByKeyUp("Mod+K", "K", key("MetaLeft", { ctrl: true }))).toBe(false);
	});
});

describe("ComponentHandlerSet", () => {
	const make = () => {
		const log: string[] = [];
		const handlers = (name: string) => ({ down: () => { log.push(`${name}:down`); }, up: (e: { phase: string; reason?: string }) => { log.push(`${name}:up:${e.reason}`); } });
		return { log, handlers };
	};
	test("down reaches every handler; up reaches exactly the ones that got the down", async () => {
		const { log, handlers } = make();
		const set = new ComponentHandlerSet();
		set.add(handlers("a"));
		await set.run({ phase: "down" });
		set.add(handlers("late")); // mounted while the key is down: never saw the down, so it gets no up
		await set.run({ phase: "up", reason: "release" });
		await set.run({ phase: "up", reason: "release" }); // nothing is pressed any more
		expect(log).toEqual(["a:down", "a:up:release"]);
	});
	test("removing a pressed handler delivers its up at once, and removing twice is harmless", async () => {
		const { log, handlers } = make();
		const set = new ComponentHandlerSet();
		const off = set.add(handlers("a"));
		set.add(handlers("b"));
		await set.run({ phase: "down" });
		off(); off();
		expect(log).toEqual(["a:down", "b:down", "a:up:removed"]);
		expect(set.size).toBe(1);
		await set.run({ phase: "up", reason: "blur" });
		expect(log.at(-1)).toBe("b:up:blur");
	});
	test("one failing handler does not stop the others, and the failure still reaches the caller", async () => {
		const log: string[] = [];
		const set = new ComponentHandlerSet();
		set.add({ down: () => { throw new Error("boom"); } });
		set.add({ down: async () => { await Promise.resolve(); log.push("second"); } });
		await expect(set.run({ phase: "down" })).rejects.toThrow("boom");
		expect(log).toEqual(["second"]);
	});
	test("an error of an up nobody awaits is reported", async () => {
		const seen: unknown[] = [];
		const set = new ComponentHandlerSet(e => seen.push(e));
		const off = set.add({ down() {}, up() { throw new Error("late"); } });
		await set.run({ phase: "down" });
		off();
		await Promise.resolve(); await Promise.resolve();
		expect(seen.map(e => (e as Error).message)).toEqual(["late"]);
	});
	test("a plain handler without up simply ignores the end of the key", async () => {
		const log: string[] = [];
		const set = new ComponentHandlerSet();
		set.add({ down: () => { log.push("down"); } });
		await set.run({ phase: "down" });
		await set.run({ phase: "up", reason: "blur" });
		expect(log).toEqual(["down"]);
	});
});

describe("componentShortcuts", () => {
	test("releases with the component when it can, and hands the function back either way", () => {
		const released: string[] = [];
		const destroyers: (() => void)[] = [];
		const api = componentShortcuts(() => () => { released.push("off"); }, off => { destroyers.push(off); });
		const off = api.register({}, {});
		expect(destroyers).toHaveLength(1);
		destroyers[0]!(); // the component is destroyed
		expect(released).toEqual(["off"]);
		expect(typeof off).toBe("function");
	});
	test("called outside a component, nothing is registered with Svelte and the caller keeps the function", () => {
		const api = componentShortcuts(() => () => {}, () => { throw new Error("lifecycle_outside_component"); });
		expect(typeof api.register({}, {})).toBe("function");
	});
});

describe("IME", () => {
	test("a composition, or the keyCode 229 keydown that ends one, is never a shortcut", () => {
		expect(composing({ isComposing: true, keyCode: 75 })).toBe(true);
		expect(composing({ isComposing: false, keyCode: 229 })).toBe(true);
		expect(composing({ isComposing: false, keyCode: 75 })).toBe(false);
		expect(composing({})).toBe(false);
	});
});

// actions.ts and App.svelte need the whole app store, so what keeps a microphone from staying on is checked in the source:
// every way the keyup can go missing must end the hold, and extension shortcuts must stand down for recording and IME.
describe("the app ends a hold whenever its keyup may never come", () => {
	const actions = readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
	const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
	const editor = readFileSync(new URL("../src/components/Shortcuts.svelte", import.meta.url), "utf8");
	test("window blur, a hidden page and pagehide", () => {
		expect(actions).toMatch(/export function resetKeyboard\(\) \{[^}]*endExtensionHold\("blur"\)/);
		expect(app).toContain("onblur={resetKeyboard}");
		expect(app).toMatch(/function settleOnHide\(\) \{\s*if \(!document\.hidden\) return;\s*endExtensionHold\("hidden"\)/);
		expect(app).toMatch(/onpagehide=\{[^}]*endExtensionHold\("hidden"\)/);
	});
	test("the keyup is heard in the capture phase, before a terminal or field can swallow it", () => {
		expect(app).toContain("onkeyupcapture={onShortcutUpCapture}");
	});
	test("starting to record a shortcut ends it, and recording or composing blocks a new one", () => {
		expect(editor).toContain('releaseShortcut("recording")');
		expect(actions).toMatch(/export function onShortcut\(e: KeyboardEvent\) \{\s*if \(e\.defaultPrevented \|\| app\.prefs\.recordingKey\) return;/);
		expect(actions).toContain("own && !composing(e)");
	});
});
