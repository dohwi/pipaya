import { tick } from "svelte";
import { app } from "./store.svelte";
import { isTauri } from "./tauri";
import { resume, runCommand } from "./commands";
import { paneToward, panesOf, type Edge } from "./layout";
import { firstUnseen, sessionOrder, stepDir, stepFrom } from "./nav";
import { appTakesKey } from "./terminal";
import {
  actionFor,
  buildCombo,
  escapeShouldStop,
  hasLongerBinding,
  isBareCombo,
  keyName,
  MAX_KEYS,
  nextChord,
  type ActionId,
} from "./keys";
import { chord } from "./chord.svelte";
import { extensions } from "./extensions/host.svelte";
import type { ApprovalMode, ThinkingLevel } from "./types";
import { approvalMode } from "./store-model";
import { msg, t, tc } from "./i18n";

const APPROVAL_LABEL: Record<ApprovalMode, string> = { ask: msg("프로젝트 밖만 확인", "approval"), auto: msg("자동", "approval") };

const LEVELS: ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
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
  const starred = app.favModelList.filter((m) => m.configured);
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
  if (m) await app.configure({ provider: m.provider, model: m.id });
}

async function cycleThinking() {
  const model = app.effectiveModel;
  if (!model?.reasoning)
    return void app.toast(t("이 모델은 추론 단계를 지원하지 않습니다"), "error", app.activeId);
  // Only the strengths this model accepts (older servers do not say: then all of them).
  const own = model.thinkingLevels?.length ? LEVELS.filter((x) => model.thinkingLevels!.includes(x)) : LEVELS;
  const l = next(own, (x) => x === app.effective.thinkingLevel);
  if (l) await app.configure({ thinkingLevel: l });
}

async function cycleApproval() {
  const a: ApprovalMode = approvalMode(app.effective.approval) === "auto" ? "ask" : "auto";
  if (await app.setApprovalMode(a))
    app.toast(t("승인 방식: {name}", { name: tc("approval", APPROVAL_LABEL[a]) }), "ok", app.activeId);
}

/** Previous / next conversation in sidebar order. */
function stepSession(step: 1 | -1) {
  const id = stepFrom(sessionOrder(app.sessions, app.groups, app.currentDirOrder, app.currentTabOrder, app.terminals), app.activeId, step);
  if (id && id !== app.activeId) void app.openSession(id);
}

/** Previous / next workspace (folder block in the sidebar): opens its first tab. */
function stepWorkspace(step: 1 | -1) {
  const id = stepDir(app.dirs, app.activeId, step);
  if (id && id !== app.activeId) void app.openSession(id);
}

function lastSession() {
  const id = app.previousId;
  if (id && app.shows(id)) void app.openSession(id);
  else app.toast(t("돌아갈 이전 대화가 없습니다"), "error");
}

/** Jump to the topmost conversation that finished while nobody was looking. */
function nextFinished() {
  const id = firstUnseen(sessionOrder(app.sessions, app.groups, app.currentDirOrder, app.currentTabOrder), (x) => !!(app.unread[x] || app.failed[x]), app.activeId);
  if (id) void app.openSession(id);
  else app.toast(t("확인하지 않은 완료된 대화가 없습니다"), "error");
}

async function focusSearch() {
  // The desktop sidebar can be folded and the mobile one is a drawer: show it before looking for the field.
  if (matchMedia("(max-width: 860px)").matches) app.sidebar.open = true;
  else if (app.sidebar.collapsed) app.sidebar.toggleCollapsed();
  await tick();
  const input = document.querySelector<HTMLInputElement>("[data-sidebar-search]");
  input?.focus();
  input?.select();
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

/** Undo every enlarging of the open group: the zoomed pane and the full mode. */
function restorePane() {
  const g = app.activeGroup;
  if (g && app.isFull(g.id)) app.toggleFull(g.id);
  app.zoomId = null;
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

/** Allow or refuse every tool call of the open chat that is waiting for an answer. */
async function decideAll(approved: boolean) {
  const chat = app.chat;
  if (!chat) return;
  const ids = Object.entries(chat.tools)
    .filter(([, tool]) => tool.state === "awaiting_approval" && !tool.question)
    .map(([id]) => id);
  if (!ids.length) return void app.toast(t("승인을 기다리는 도구가 없습니다"), "error", app.activeId);
  await Promise.all(ids.map((id) => app.decide(id, approved)));
}

function cycleServer() {
  const list = app.servers;
  if (list.length < 2) return void app.toast(t("전환할 다른 서버가 없습니다"), "error");
  const i = list.findIndex((s) => s.id === app.serverId);
  const to = list[(i + 1) % list.length];
  if (to) app.openServer(to.id);
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
  closeSession: () => app.closeActive(),
  prevSession: () => stepSession(-1),
  nextSession: () => stepSession(1),
  prevWorkspace: () => stepWorkspace(-1),
  nextWorkspace: () => stepWorkspace(1),
  lastSession,
  nextFinished,
  focusSearch,
  findInChat: () => void app.findTick++,
  forkSession: () => runCommand("fork", "last"),
  retry: () => runCommand("retry"),
  compact: () => runCommand("compact"),
  copyLast: () => runCommand("copy"),
  scrollTop: () => scrollTo("top"),
  scrollBottom: () => scrollTo("bottom"),
  cycleApproval,
  approveTool: () => decideAll(true),
  denyTool: () => decideAll(false),
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
  zoomPane,
  restorePane,
  toggleFull,
  workdir: () => runCommand("cd"),
  skills: () => app.openSkills(),
  cycleServer,
  toggleSound: () => app.prefs.setSound(!app.prefs.soundOn),
  resume: () => resume(),
  modelPicker: () => void app.modelPickerTick++,
  cycleModel,
  cycleThinking,
  splitRight: () => app.splitActive("right"),
  splitDown: () => app.splitActive("bottom"),
  splitLeft: () => app.splitActive("left"),
  splitUp: () => app.splitActive("top"),
  stop: () => {
    if (app.chat?.running) void app.abort();
  },
  steer: () => {}, // fixed to Enter: handled by the composer itself
  queueMessage: () => void app.queueSendTick++,
  cancelQueue: () => app.openQueue(),
  settings: () => {
    if (app.settingsOpen) app.settingsOpen = false;
    else app.openSettings();
  },
  toggleTheme: () => app.prefs.setTheme(app.prefs.resolvedDark ? "light" : "dark"),
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

/** Leave a half-typed shortcut (Ctrl+B pressed, waiting for the next key) without running anything. */
export function cancelChord() {
  disarmPrefixAction();
  chord.prefix = null;
}

/**
 * Ctrl+B is bound itself *and* starts longer shortcuts (Ctrl+B+B, Ctrl+B+V). Waiting forever would make plain Ctrl+B
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
    if (!app.prefs.recordingKey) runAction(id);
  }, PREFIX_WAIT_MS);
}

/**
 * Capture-phase handler. While a shortcut is waiting for its next key it owns the keyboard, so the key does not
 * reach the composer or anything else: Esc cancels, Enter runs what was typed so far (if bound), any other key
 * completes the shortcut or, when nothing is bound to it, ends the wait. There is no time limit.
 */
export function onShortcutCapture(e: KeyboardEvent) {
  const prefix = chord.prefix;
  if (!prefix || app.prefs.recordingKey || e.isComposing) return;
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
  // A focused terminal gets its keys (Ctrl+B, Esc, Alt+N...): only Mod+Shift/Alt shortcuts and F-keys reach the app.
  const fromTerminal = inTerminal(e);
  if (fromTerminal && !appTakesKey(e, app.prefs.bindings)) return;
  // Esc stops the agent even while an IME composition is open (Korean/Japanese input leaves isComposing set). A
  // shortcut the app took from a terminal wins over the IME too: a half-composed Korean syllable must not eat it.
  if (e.isComposing && e.key !== "Escape" && !fromTerminal) return;
  if (MODIFIER_CODE.test(e.code)) return;
  // Esc is fixed to "stop the agent". It only acts when nothing else wants the key: an open dialog/menu keeps it
  // (it closes them), and so does a text field other than the composer. Handlers that already used the key
  // (e.g. the composer's slash menu) called preventDefault, which returned above.
  if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    // A zoomed pane shrinks back first; the next Esc is the usual "stop the agent".
    if (app.zoomId && !document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]')) {
      e.preventDefault();
      app.zoomId = null;
      return;
    }
    const chat = app.chat;
    const stop = escapeShouldStop({
      busy: !!chat && (chat.running || chat.compacting || !!(app.activeId && app.running[app.activeId])),
      overlayOpen: !!document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]'),
      target: e.target as HTMLElement | null,
    });
    if (stop) {
      e.preventDefault();
      void app.abort();
    }
    return;
  }
  // A shortcut the app took from a terminal is a fresh press: a keyup the terminal swallowed must not leave stale
  // held keys / "fired" state that makes it silently do nothing now and then.
  if (fromTerminal && !e.repeat) clearHeldKeys();
  if (!e.repeat) fired = false;
  const key = keyName(e.code);
  held.add(key);
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
      if (own) {
        e.preventDefault();
        fired = true;
        own.run().catch((cause) => app.toast(t("확장 실패: {error}", { error: cause instanceof Error ? cause.message : String(cause) }), "error", app.activeId));
        return;
      }
    }
    if (!id && !starts) continue;
    // Keys without Ctrl/Alt are normal typing in a text field: leave them alone there.
    if (isBareCombo(combo) && typingTarget(e)) return;
    e.preventDefault();
    if (starts) {
      const prefix = { ...mods, keys };
      chord.prefix = prefix;
      if (id) armPrefixAction(id);
    } else {
      fired = true;
      runAction(id!);
    }
    return;
  }
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
export function resetKeyboard() {
  clearHeldKeys();
  cancelChord();
}
