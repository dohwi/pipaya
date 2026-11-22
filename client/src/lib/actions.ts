import { errorText } from "./api";
import { app } from "./store.svelte";
import { isTauri } from "./tauri";
import { findChat, runCommand } from "./commands";
import { paneToward, panesOf, type Edge } from "./layout";
import { connectionState, orderServers, unreachable } from "./sidebar-model";
import { stepRowTarget, stepWorkspaceTarget } from "./step-session";
import { projectKey } from "./projects";
import { needsLook, stepFrom, tabPanes } from "./nav";
import { appTakesKey } from "./terminal";
import {
  actionFor,
  buildCombo,
  escapeShouldStop,
  escapeShouldUnzoom,
  hasLongerBinding,
  isBareCombo,
  keyName,
  MAX_KEYS,
  nextChord,
  OVERLAY_SELECTOR,
  RENAME_KEY,
  renameShouldFallThrough,
  splitCombo,
  tabComboYieldsFocus,
  type ActionId,
} from "./keys";
import { topLayer } from "./dialog";
import { renameNow } from "./rename-places";
import { chord } from "./chord.svelte";
import { extensions } from "./extensions/host.svelte";
import { composing, releasedByKeyUp, type ShortcutUpReason } from "./extensions/shortcuts";
import { voice, voiceKeyPress } from "./voice.svelte";
import { THINKING_LEVELS, type ThinkingLevel } from "./types";
import { t } from "./i18n";


const LEVELS: ThinkingLevel[] = [...THINKING_LEVELS];
/** Step to the next entry (wrapping), or the first entry when `current` is not in the list. */
function next<T>(
  list: readonly T[],
  current: (x: T) => boolean,
): T | undefined {
  const i = list.findIndex(current);
  return list[(i + 1) % list.length];
}

async function cycleModel() {
  // Only the starred models, in the order they were starred
  const starred = app.favModelList.filter((m) => m.configured && m.available !== false);
  if (!starred.length)
    return void app.toast(
      t("즐겨찾기한 모델이 없습니다. 모델 선택창에서 별표를 눌러 추가하세요"),
      "error",
    );
  const e = app.effective;
  const cur = starred.findIndex(
    (x) => x.provider === e.provider && x.id === e.model,
  );
  if (starred.length === 1 && cur === 0)
    return void app.toast(t("바꿀 다른 즐겨찾기 모델이 없습니다"), "error");
  const m = starred[(cur + 1) % starred.length];
  if (!m) return;
  // A model and its starting strength travel together (like the model picker): the target's own default, else "medium".
  const lvl = m.reasoning ? (m.defaultThinkingLevel ?? "medium") : undefined;
  await app.configure({ provider: m.provider, model: m.id, ...(lvl ? { thinkingLevel: lvl } : {}) });
}

async function cycleThinking() {
  const model = app.effectiveModel;
  if (!model?.reasoning)
    return void app.toast(t("이 모델은 추론 강도를 지원하지 않습니다"), "error", app.activeId);
  // Only the strengths this model accepts.
  const own = model.thinkingLevels.length ? LEVELS.filter((x) => model.thinkingLevels.includes(x)) : LEVELS;
  const l = next(own, (x) => x === app.effective.thinkingLevel);
  if (l) await app.configure({ thinkingLevel: l });
}

/** Every server as the sidebar lists it, for stepping across them. */
function stepBands() {
  return orderServers(
    app.servers.map((s) => {
      const link = app.links[s.id];
      return { id: s.id, local: s.local, state: link ? connectionState(link.net) : ("checking" as const), dirs: app.dirsByServer[s.id] ?? [] };
    }),
  ).map((b) => ({ id: b.id, dirs: b.dirs, hidden: unreachable(b.state), foldedDirs: foldedProjectDirs(b.id) }));
}

/** The folders of a server that sit inside a folded project (their rows are hidden under its header). */
function foldedProjectDirs(serverId: string): string[] {
  return (app.blocksByServer[serverId] ?? []).flatMap((b) => (b.kind === "project" && app.sidebar.folded.includes(projectKey(serverId, b.root)) ? b.dirs.map((d) => d.path) : []));
}

function goTo(to: { server: string; id: string } | null) {
  if (!to) return;
  if (to.server !== app.serverId) app.openIn(to.server, { session: to.id });
  else if (to.id !== app.activeId) void app.openSession(to.id);
}

/** Previous / next row of the sidebar, across servers: a tab (a pane of a split tab), or a folded folder's first tab. */
function stepRow(step: 1 | -1) {
  goTo(stepRowTarget(stepBands(), app.sidebar.folded, (server, path) => app.dirFolded(server, path), { server: app.serverId, id: app.activeId }, step));
}

/** Previous / next workspace (a folder row in the sidebar: a plain folder or a worktree in a project), across servers: opens its first tab. */
function stepWorkspace(step: 1 | -1) {
  goTo(stepWorkspaceTarget(stepBands(), app.sidebar.folded, { server: app.serverId, id: app.activeId }, step));
}

/** Previous / next tab of the tab bar (the active workspace's tabs), wrapping. A split group counts as one tab per pane. */
function stepTab(step: 1 | -1) {
  const at = app.activeTab;
  if (!at || !app.activeId) return;
  const order = app.stripDirs.flatMap((d) => d.tabs.flatMap((x) => tabPanes(x))).filter((id) => app.shows(id));
  const id = stepFrom(order, app.activeId, step);
  if (id && id !== app.activeId) void app.openSession(id);
}

function lastSession() {
  const id = app.previousId;
  if (id && app.shows(id)) void app.openSession(id);
  else app.toast(t("돌아갈 이전 대화가 없습니다"), "error");
}

/** Jump to the conversation that most needs the user: asking first, then failed, then finished unseen. */
function nextAttention() {
  // the sidebar's own order (a project's folders together) within a state
  const order = [...new Set(app.dirs.flatMap((d) => d.tabs.flatMap((x) => tabPanes(x))))];
  const id = needsLook(order, { awaiting: app.awaiting, failed: app.failed, unread: app.unread }, app.activeId);
  if (id) void app.openSession(id);
  else app.toast(t("확인할 대화가 없습니다"), "error");
}

/** Focus the neighbouring pane of the open group, by screen direction. */
function focusToward(edge: Edge) {
  const g = app.activeGroup;
  if (!g || !app.activeId) return;
  const id = paneToward(g.layout, app.activeId, edge);
  if (id && app.shows(id)) {
    app.zoomId = null; // a zoomed pane covers its neighbours: shrink back so the newly selected one is visible
    void app.openSession(id);
  }
}

function cyclePane() {
  const g = app.activeGroup;
  if (!g || !app.activeId) return;
  const ids = panesOf(g.layout).filter((x) => app.shows(x));
  const id = stepFrom(ids, app.activeId, 1);
  if (id && id !== app.activeId) {
    app.zoomId = null;
    void app.openSession(id);
  }
}

/** Enlarge the focused pane to the whole group, or put it back. In full mode this leaves full mode. */
function zoomPane() {
  const g = app.activeGroup;
  const id = app.activeId;
  if (!g || !id) return void app.toast(t("그룹에 속한 대화가 아닙니다"), "error");
  if (app.isFull(g.id)) app.toggleFull(g.id);
  else app.zoomId = app.zoomId === id ? null : id;
}

function toggleFull() {
  const g = app.activeGroup;
  if (!g) return void app.toast(t("그룹에 속한 대화가 아닙니다"), "error");
  app.toggleFull(g.id);
}

/** The focused pane's scroll area (each pane has its own). */
function scroller(): HTMLElement | null {
  const pane = app.activeId ? document.querySelector(`[data-pane="${CSS.escape(app.activeId)}"]`) : null;
  return pane?.querySelector<HTMLElement>(".scroller") ?? null;
}

function scrollTo(where: "top" | "bottom") {
  const el = scroller();
  if (el) el.scrollTo({ top: where === "top" ? 0 : el.scrollHeight, behavior: "smooth" });
}

/** The desktop app switches its window; a browser uses the Fullscreen API. */
async function toggleFullscreen() {
  try {
    if (isTauri()) {
      const win = (await import("@tauri-apps/api/window")).getCurrentWindow();
      await win.setFullscreen(!(await win.isFullscreen()));
    } else if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    app.toast(t("전체 화면을 전환하지 못했습니다"), "error");
  }
}

const RUN: Record<ActionId, () => void | Promise<void>> = {
  toggleSidebar: () => {
    // Below the desktop breakpoint the sidebar is a drawer, not a collapsible rail
    if (matchMedia("(max-width: 860px)").matches)
      app.sidebar.open = !app.sidebar.open;
    else app.sidebar.toggleCollapsed();
  },
  newChat: () => app.newChatInPane(),
  clearChat: () => app.clearChatInPane(),
  closeSession: () => app.closeActive(),
  prevRow: () => stepRow(-1),
  nextRow: () => stepRow(1),
  prevWorkspace: () => stepWorkspace(-1),
  nextWorkspace: () => stepWorkspace(1),
  prevTab: () => stepTab(-1),
  nextTab: () => stepTab(1),
  tabOverview: () => {
    // Only where the tab-count button shows: a server, and a folder with at least one tab.
    if (app.tabOverview) app.tabOverview = false;
    else if (app.serverId && app.tabDir?.tabs.length) app.tabOverview = true;
  },
  lastSession,
  nextAttention,
  findChat: () => void findChat(),
  findInChat: () => void app.findTick++,
  forkSession: () => runCommand("fork", "last"),
  retry: () => runCommand("retry"),
  compact: () => runCommand("compact"),
  copyLast: () => runCommand("copy"),
  toggleWorkExpand: () => {
    const on = !app.prefs.expandWork;
    app.prefs.setExpandWork(on);
    app.toast(on ? t("작업 내역을 모두 펼칩니다") : t("작업 내역을 한 줄로 접습니다"));
  },
  scrollTop: () => scrollTo("top"),
  scrollBottom: () => scrollTo("bottom"),
  focusLeft: () => focusToward("left"),
  focusRight: () => focusToward("right"),
  focusUp: () => focusToward("top"),
  focusDown: () => focusToward("bottom"),
  cyclePane,
  ungroup: () => {
    if (app.activeId && app.activeGroup) return app.leaveGroup(app.activeId);
    app.toast(t("그룹에 속한 대화가 아닙니다"), "error");
  },
  newTerminal: () => void app.openTerminal(app.workdir),
  splitTerminal: () => app.splitTerminal("bottom"),
  splitTerminalRight: () => app.splitTerminal("right"),
  zoomPane,
  toggleFull,
  workdir: () => runCommand("cd"),
  skills: () => app.openSkills(),
  toggleSound: () => app.prefs.setSound(!app.prefs.soundOn),
  // A tap: start recording, or stop a recording the tap started. A longer press is the hold path below.
  voiceInput: () => {
    if (!voice.ready) return;
    if (voice.recording) voice.stop();
    else void voice.start(app.activeId ?? "");
  },
  modelPicker: () => void app.modelPickerTick++,
  cycleModel,
  cycleThinking,
  splitRight: () => app.splitActive("right"),
  splitDown: () => app.splitActive("bottom"),
  stop: () => {
    if (app.chat?.running) void app.abort();
  },
  steer: () => {}, // fixed to Enter: handled by the composer itself
  renameTab: () => {}, // fixed to F2: handled by whatever has focus (row, pane title, chip, header), see RENAME_KEY
  queueMessage: () => void app.queueSendTick++,
  cancelQueue: () => app.openQueue(),
  settings: () => {
    if (app.settingsOpen) app.settingsOpen = false;
    else app.openSettings();
  },
  openGraph: () => app.toggleGraph(),
  toggleTheme: () => app.prefs.setTheme(app.prefs.resolvedDark ? "light" : "dark"),
  zoomIn: () => app.prefs.stepUiScale(1),
  zoomOut: () => app.prefs.stepUiScale(-1),
  zoomReset: () => app.prefs.setUiScale(100),
  fullscreen: toggleFullscreen,
};

export function runAction(id: ActionId) {
  void RUN[id]();
}

/** Plain keys currently held, by physical code. Cleared on blur so a missed keyup cannot stick. */
const held = new Set<string>();
let fired = false;

const MODIFIER_CODE = /^(Control|Shift|Alt|Meta|OS|AltGraph|CapsLock|Fn)/;

function inTerminal(e: KeyboardEvent) {
  return !!(e.target as HTMLElement | null)?.closest?.("[data-terminal]");
}

function typingTarget(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return (
    !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
  );
}

/**
 * The element last pressed. F2 renames the place that was clicked (its sidebar row, tab, title or pane bar): a macOS
 * webview never focuses what it clicks, so the click is the only thing left to tell which one the user means.
 */
let pressed: Element | null = null;

export function notePress(e: PointerEvent) {
  pressed = e.target instanceof Element ? e.target : null;
}

/** Leave a half-typed shortcut (Ctrl+B pressed, waiting for the next key) without running anything. */
export function cancelChord() {
  disarmPrefixAction();
  chord.prefix = null;
}

/**
 * Ctrl+B is bound itself *and* starts longer shortcuts (Ctrl+B+B, Ctrl+B+\). Waiting forever would make plain Ctrl+B
 * dead, so when no next key comes within this time the shortcut runs its own action (like a prefix key in tmux).
 */
const PREFIX_WAIT_MS = 1500;
let prefixTimer: ReturnType<typeof setTimeout> | undefined;

function disarmPrefixAction() {
  clearTimeout(prefixTimer);
  prefixTimer = undefined;
}

function armPrefixAction(id: ActionId) {
  disarmPrefixAction();
  prefixTimer = setTimeout(() => {
    prefixTimer = undefined;
    if (!chord.prefix) return;
    chord.prefix = null;
    clearHeldKeys();
    if (!app.prefs.recordingKey && !topLayer()) runAction(id);
  }, PREFIX_WAIT_MS);
}

/**
 * Capture-phase handler. While a shortcut is waiting for its next key it owns the keyboard, so the key does not
 * reach the composer or anything else: Esc cancels, Enter runs what was typed so far (if bound), any other key
 * completes the shortcut or, when nothing is bound to it, ends the wait. There is no time limit.
 */
export function onShortcutCapture(e: KeyboardEvent) {
  const prefix = chord.prefix;
  if (!prefix || topLayer() || app.prefs.recordingKey || e.isComposing) return;
  if (MODIFIER_CODE.test(e.code)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  disarmPrefixAction();
  chord.prefix = null;
  clearHeldKeys();
  if (e.key === "Escape") return;
  fired = true;
  if (e.key === "Enter") {
    const id = actionFor(buildCombo(prefix, prefix.keys), app.prefs.bindings);
    if (id) runAction(id);
    return;
  }
  const step = nextChord(prefix, e, app.prefs.bindings);
  if (step.kind === "wait") {
    chord.prefix = step.prefix;
    const own = actionFor(buildCombo(step.prefix, step.prefix.keys), app.prefs.bindings);
    if (own) armPrefixAction(own);
  } else if (step.kind === "run") runAction(step.id);
}

/** Window-level key handler: runs the action bound to the keys held right now. */
export function onShortcut(e: KeyboardEvent) {
  if (e.defaultPrevented || app.prefs.recordingKey) return;
  // Focus can land on the body outside the top panel. Its shortcuts still belong to the modal layer.
  if (topLayer()) return;
  // A focused terminal gets its keys (Ctrl+B, Esc, Alt+N...): only Mod+Shift/Alt shortcuts and F-keys reach the app.
  const fromTerminal = inTerminal(e);
  if (fromTerminal && !appTakesKey(e, app.prefs.bindings, app.prefs.terminal.appKeysFirst)) return;
  // Esc stops the agent even while an IME composition is open (Korean/Japanese input leaves isComposing set). A
  // shortcut the app took from a terminal wins over the IME too: a half-composed Korean syllable must not eat it.
  if (e.isComposing && e.key !== "Escape" && !fromTerminal) return;
  if (MODIFIER_CODE.test(e.code)) return;
  // AltGr arrives as Ctrl+Alt on Windows and Linux: on a German layout AltGr+ß types "\", which must not run Ctrl+Alt+-.
  // Where text is typed, a key with AltGr down is a character, not a shortcut.
  if (e.getModifierState?.("AltGraph") && (fromTerminal || typingTarget(e))) return;
  // Esc is fixed to "stop the agent". It only acts when nothing else wants the key: an open dialog/menu keeps it
  // (it closes them), and so does a text field other than the composer. Handlers that already used the key
  // (e.g. the composer's slash menu) called preventDefault, which returned above.
  if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    // An open dialog or menu (a row's or chip's context menu) takes this Esc to close itself: it must not also shrink
    // the zoomed pane or stop the agent behind it.
    const overlayOpen = !!document.querySelector(OVERLAY_SELECTOR);
    // A zoomed pane shrinks back first; the next Esc is the usual "stop the agent". A rename field's Esc only cancels it.
    if (app.zoomId && escapeShouldUnzoom({ overlayOpen, target: e.target as HTMLElement | null })) {
      e.preventDefault();
      app.zoomId = null;
      return;
    }
    const chat = app.chat;
    const stop = escapeShouldStop({
      busy: !!chat && (chat.running || chat.compacting || !!(app.activeId && app.running[app.activeId])),
      overlayOpen,
      target: e.target as HTMLElement | null,
    });
    if (stop) {
      e.preventDefault();
      void app.abort();
    }
    return;
  }
  // F2 renames the open thing (a conversation, a terminal or a split tab). Whatever had focus and took the key itself
  // handled it already (preventDefault, returned above); this is the rest of the window: a click on a row leaves focus on
  // the body in a macOS webview (WebKit bug 22261), and a folded sidebar has no row to focus at all.
  if (e.key === RENAME_KEY) {
    const now = renameNow(pressed);
    if (
      now &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      renameShouldFallThrough({
        key: e.key,
        defaultPrevented: e.defaultPrevented,
        repeat: e.repeat,
        mod: false,
        target: e.target as HTMLElement | null,
        inTerminal: fromTerminal,
        overlayOpen: !!document.querySelector(OVERLAY_SELECTOR),
        recording: app.prefs.recordingKey,
        // an inline field that is already open keeps its own key (it has focus, so this is belt and braces)
        renaming: !!document.querySelector("input.rename"),
      })
    ) {
      e.preventDefault();
      now.place.start(now.target.id, now.target.title);
    }
    return;
  }
  // A shortcut the app took from a terminal is a fresh press: a keyup the terminal swallowed must not leave stale
  // held keys / "fired" state that makes it silently do nothing now and then.
  if (fromTerminal && !e.repeat) clearHeldKeys();
  if (!e.repeat) fired = false;
  const key = keyName(e.code);
  held.add(key);
  // A held key repeats: the extension hold that owns it also keeps the browser from typing a character (Alt+K on macOS) each time.
  if (e.repeat) {
    const heldCombo = extensions.heldShortcut ? extensions.shortcutCombo(extensions.heldShortcut) : null;
    if (heldCombo && heldCombo === buildCombo({ mod: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey }, [key])) e.preventDefault();
  }
  if (e.repeat || fired) return;
  const mods = { mod: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey };
  // Keys held together are one shortcut (J+K+L). Fall back to this key alone so a shortcut still works while
  // another plain key happens to be down.
  for (const keys of [[...held], [key]]) {
    if (!keys.length || keys.length > MAX_KEYS) continue;
    const combo = buildCombo(mods, keys);
    // Several keys down at once are one shortcut whatever order they went down in (K+J = J+K).
    const id = actionFor(combo, app.prefs.bindings, keys.length > 1);
    // The start of a longer shortcut waits for its next key even when nothing is bound to these keys alone
    // (Ctrl+B+B and Ctrl+B+C are bound, Ctrl+B is not).
    const starts = hasLongerBinding(combo, app.prefs.bindings);
    // A key the app does not use may belong to an extension (built-in shortcuts always win).
    if (!id && !starts && keys.length === 1) {
      const own = extensions.shortcutFor(combo);
      // An IME composition owns the key, also when a focused terminal let it through above.
      if (own && !composing(e)) {
        e.preventDefault();
        fired = true;
        extensions.pressShortcut(own).catch(extensionShortcutFailed);
        return;
      }
    }
    if (!id && !starts) continue;
    // Shift+Tab outside the composer moves focus backwards, as everywhere else.
    if (tabComboYieldsFocus(combo, e.target as HTMLElement | null)) return;
    // Keys without Ctrl/Alt are normal typing in a text field: leave them alone there.
    if (isBareCombo(combo) && typingTarget(e)) return;
    e.preventDefault();
    if (starts) {
      const prefix = { ...mods, keys };
      chord.prefix = prefix;
      if (id) armPrefixAction(id);
    } else {
      fired = true;
      // "both" mode: recording starts on the way down; the keyup tells a tap (keep) from a hold (stop)
      if (id === "voiceInput") {
        if (voice.ready || voice.busy) voiceKeyPress.down();
      } else runAction(id!);
    }
    return;
  }
}

function extensionShortcutFailed(cause: unknown) {
  app.toast(t("확장 실패: {error}", { error: errorText(cause) }), "error", app.activeId);
}

/** Why an extension hold is over, and what the app does about it. The extension gets exactly one `up`. */
export function endExtensionHold(reason: ShortcutUpReason) {
  extensions.releaseShortcut(reason).catch(extensionShortcutFailed);
}

/**
 * Capture-phase keyup: ends an extension hold when its key (or a modifier of its combo) comes up. Capture, so a focused
 * terminal or field that swallows the keyup cannot leave the extension holding (a microphone that never turns off).
 */
export function onShortcutUpCapture(e: KeyboardEvent) {
  // The voice shortcut's key came up: a tap keeps the recording it started, a hold stops it. Capture for the same
  // reason as below: a terminal that swallows the keyup must not leave the microphone open.
  if (voiceKeyPress.active && !MODIFIER_CODE.test(e.code)) voiceKeyPress.up();
  const held = extensions.heldShortcut;
  if (!held) return;
  // The working combo (the user may have changed it while the key was down), not the snapshot taken at registration.
  const combo = extensions.shortcutCombo(held);
  if (!combo) return;
  const { keys } = splitCombo(combo);
  if (releasedByKeyUp(combo, keys[0] ?? "", e)) endExtensionHold("release");
}

export function onShortcutUp(e: KeyboardEvent) {
  if (MODIFIER_CODE.test(e.code)) {
    // macOS sends no keyup for other keys while ⌘ is down, so letting go of ⌘ is the only chance to forget them.
    if (e.key === "Meta") held.clear();
    return;
  }
  held.delete(keyName(e.code));
  if (!held.size) fired = false;
}

/** The window lost focus: forget held keys and any half-typed shortcut. */
export function clearHeldKeys() {
  held.clear();
  fired = false;
}
/** The window lost the keyboard: the keyup of whatever was down will never arrive. */
export function resetKeyboard() {
  clearHeldKeys();
  cancelChord();
  endExtensionHold("blur");
  // The keyup of a held voice recording will not arrive either: stop it rather than leave the microphone open.
  voiceKeyPress.cancel();
}
