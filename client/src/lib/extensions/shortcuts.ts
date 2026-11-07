/**
 * Extension shortcuts, in one place: what a registration may look like, when it is refused, and how a component's
 * handlers are called. The sandboxed SDK (`sdk.shortcuts.register`) and trusted components (`shortcuts.register` of the
 * `pipaya` kit) both go through here, so the two cannot drift apart. Pure: no reactive state and no app imports, so the
 * host and the tests can use it as is.
 */
import { LocalizedError, msg, t } from "../i18n";
import { actionFor, hasLongerBinding, isModifierCode, keyName, ACTIONS, type ActionId } from "../keys";
import { localId, object, string } from "./host-values";
import type { ShortcutEvent } from "./sdk";

export type { ShortcutEvent, ShortcutUpReason } from "./sdk";

/** Shortcuts one extension may hold at once, whichever way they were registered. */
export const MAX_SHORTCUTS = 10;

export interface ShortcutSpec { id: string; label: string; combo: string; hold: boolean }

/** What a component passes to `shortcuts.register`. `up` makes the shortcut a hold. */
export interface ComponentHandlers {
  down?(event: ShortcutEvent): unknown;
  up?(event: ShortcutEvent): unknown;
}

/** `register` of the component kit: a spec and `{ down?, up? }` in, a function that removes the shortcut out. */
export type ShortcutRegistrar = (spec: unknown, handlers: unknown) => () => void;

const MODS = ["Mod", "Alt", "Shift"];
const NEEDS = msg("단축키는 Ctrl/⌘ 또는 Alt와 키 하나로 구성해야 합니다 (예: Mod+Shift+K)");

/**
 * The canonical form (`Mod`, `Alt`, `Shift` in that order, a letter upper case) of a combo made of Ctrl/⌘ or Alt and
 * exactly one key, or null. Canonical, so `Shift+Mod+k` and `Mod+Shift+K` are one shortcut, as the key handler sees it.
 */
export function normalizeCombo(combo: string): string | null {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  if (!key || MODS.includes(key) || parts.some((p) => !MODS.includes(p)) || new Set(parts).size !== parts.length) return null;
  if (!parts.includes("Mod") && !parts.includes("Alt")) return null;
  return [...MODS.filter((m) => parts.includes(m)), key.length === 1 ? key.toUpperCase() : key].join("+");
}

/** Check what an extension handed over. A component decides `hold` by having an `up` handler and passes it in. */
export function parseShortcutSpec(value: unknown, hold?: boolean): ShortcutSpec {
  const s = object(value);
  const combo = normalizeCombo(string(s.combo, 40, "combo"));
  if (!combo) throw new LocalizedError(t(NEEDS));
  if (s.hold !== undefined && typeof s.hold !== "boolean") throw new LocalizedError(t("hold는 true 또는 false여야 합니다"));
  return { id: localId(s.id), label: string(s.label, 60), combo, hold: hold ?? s.hold === true };
}

/** The handlers of a component: an object with `down` and/or `up`, both functions. */
export function parseComponentHandlers(value: unknown): ComponentHandlers {
  const h = object(value);
  for (const key of Object.keys(h)) if (key !== "down" && key !== "up") throw new LocalizedError(t("단축키 핸들러는 down과 up만 받습니다"));
  if (h.down === undefined && h.up === undefined) throw new LocalizedError(t("단축키 핸들러가 필요합니다"));
  for (const fn of [h.down, h.up]) if (fn !== undefined && typeof fn !== "function") throw new LocalizedError(t("단축키 핸들러는 함수여야 합니다"));
  return { down: h.down as ComponentHandlers["down"], up: h.up as ComponentHandlers["up"] };
}

/** Refuse a registration over the limit, with an ID the extension already uses, or on a combo another extension has. */
export function checkShortcutFree(existing: readonly { owner: string; id: string; combo: string }[], owner: string, spec: ShortcutSpec) {
  const own = existing.filter((x) => x.owner === owner);
  if (own.length >= MAX_SHORTCUTS || own.some((x) => x.id === spec.id)) throw new LocalizedError(t("단축키 제한 또는 중복 ID"));
  if (existing.some((x) => x.combo === spec.combo)) throw new LocalizedError(t("이미 다른 확장이 쓰는 단축키입니다: {combo}", { combo: spec.combo }));
}

/**
 * The app action that takes this combo before any extension does (app shortcuts always win): bound to exactly it, or
 * starting a longer app shortcut (Ctrl+B of Ctrl+B+V waits for its next key). Shown to the user; the key handler applies
 * the same order.
 */
export function appConflict(combo: string, bindings: Record<string, string>): ActionId | undefined {
  const own = actionFor(combo, bindings);
  if (own) return own;
  return ACTIONS.find((a) => !a.fixed && bindings[a.id] && hasLongerBinding(combo, { [a.id]: bindings[a.id]! }))?.id;
}

/** An IME composition owns the key. `keyCode` 229 is how Safari reports the keydown that ends one (`isComposing` is already false). */
export const composing = (e: { isComposing?: boolean; keyCode?: number }): boolean => !!e.isComposing || e.keyCode === 229;

interface KeyUp { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

/**
 * Whether this keyup ends a hold on `combo` (whose key is `key`): the key itself came up, or a modifier the combo needs
 * is no longer down. On macOS the second case is the only one that ever arrives: no keyup is sent for a key while ⌘ is down.
 */
export function releasedByKeyUp(combo: string, key: string, e: KeyUp): boolean {
  if (!isModifierCode(e.code)) return keyName(e.code) === key;
  const need = combo.split("+");
  return (need.includes("Mod") && !e.ctrlKey && !e.metaKey) || (need.includes("Alt") && !e.altKey) || (need.includes("Shift") && !e.shiftKey);
}

/**
 * The handlers behind one shortcut ID of a component. A component mounted once per pane registers the same ID in each
 * pane, so every handler is called and each decides whether it is the one meant (the focused pane, say). `up` reaches
 * exactly the handlers that got the `down`; a handler removed while pressed gets its `up` (reason `removed`) at once.
 * Handlers run synchronously inside the key event, so browser features that need a user gesture (the microphone) work.
 */
export class ComponentHandlerSet {
  private all = new Set<ComponentHandlers>();
  private pressed = new Set<ComponentHandlers>();
  /** `report` hears about an error of an `up` that nobody awaits (a handler removed while pressed). */
  constructor(private report: (error: unknown) => void = () => {}) {}

  get size() { return this.all.size; }

  /** Adds handlers; the returned function removes them again (calling it twice is fine). */
  add(handlers: ComponentHandlers): () => void {
    this.all.add(handlers);
    return () => {
      if (!this.all.delete(handlers)) return;
      if (this.pressed.delete(handlers)) this.call(handlers, { phase: "up", reason: "removed" }).catch(this.report);
    };
  }

  /** Delivers an event to the handlers it belongs to. Every handler is called; rejects with the first error. */
  run(event: ShortcutEvent): Promise<void> {
    let targets: ComponentHandlers[];
    if (event.phase === "down") { targets = [...this.all]; this.pressed = new Set(targets); }
    else { targets = [...this.pressed]; this.pressed = new Set(); }
    return Promise.all(targets.map((h) => this.call(h, event))).then(() => {});
  }

  private call(h: ComponentHandlers, event: ShortcutEvent): Promise<void> {
    const fn = event.phase === "down" ? h.down : h.up;
    if (!fn) return Promise.resolve();
    try { return Promise.resolve(fn.call(h, event)).then(() => {}); }
    catch (e) { return Promise.reject(e); }
  }
}

/**
 * The `shortcuts` of the component kit: `register(spec, handlers)` returns a function that removes it. Called while a
 * component starts or inside its `$effect`, it is removed on its own when the component goes away (`autoRelease` is
 * Svelte's `onDestroy`); called later (in an event handler) it cannot tell, and the caller keeps the function. Either way
 * the extension's shortcuts are all removed when it is disabled.
 */
export function componentShortcuts(register: ShortcutRegistrar, autoRelease: (off: () => void) => void) {
  return Object.freeze({
    register(spec: unknown, handlers: unknown): () => void {
      const off = register(spec, handlers);
      try { autoRelease(off); } catch { /* not inside a component: the caller releases it */ }
      return off;
    },
  });
}
