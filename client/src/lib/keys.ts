/**
 * Keyboard shortcuts: the catalogue of bindable actions, and the combo format.
 *
 * A combo is a string like "Mod+B", "Alt+Shift+M", "J+K+L" or "Mod+B+V": modifiers in the fixed order Mod, Alt,
 * Shift, then up to three keys in the order they were pressed. Ctrl+B then V is "Mod+B+V" and only B starts it. Keys come from `KeyboardEvent.code`,
 * so they do not depend on the layout or on what Alt turns a letter into on macOS. `Mod` means Ctrl or ⌘.
 */

import { msg } from "./i18n";

export type ActionId =
  | "toggleSidebar"
  | "newChat"
  | "closeSession"
  | "archiveSession"
  | "prevSession"
  | "nextSession"
  | "prevWorkspace"
  | "nextWorkspace"
  | "prevTab"
  | "nextTab"
  | "lastSession"
  | "nextFinished"
  | "focusSearch"
  | "findInChat"
  | "resume"
  | "forkSession"
  | "retry"
  | "compact"
  | "copyLast"
  | "scrollTop"
  | "scrollBottom"
  | "focusLeft"
  | "focusRight"
  | "focusUp"
  | "focusDown"
  | "cyclePane"
  | "ungroup"
  | "zoomPane"
  | "restorePane"
  | "toggleFull"
  | "newTerminal"
  | "splitTerminal"
  | "splitTerminalRight"
  | "workdir"
  | "skills"
  | "cycleServer"
  | "toggleSound"
  | "modelPicker"
  | "cycleModel"
  | "cycleThinking"
  | "splitRight"
  | "splitDown"
  | "splitLeft"
  | "splitUp"
  | "stop"
  | "steer"
  | "queueMessage"
  | "cancelQueue"
  | "settings"
  | "toggleTheme"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "fullscreen";

export interface ActionDef {
  id: ActionId;
  label: string;
  hint: string;
  /** "" = not bound by default */
  default: string;
  /** Cannot be rebound: always `default` (shown, but not editable, in Settings) */
  fixed?: boolean;
  group: "general" | "chat" | "model" | "layout" | "pane";
}

const BASE: Omit<ActionDef, "group">[] = [
  {
    id: "toggleSidebar",
    label: msg("사이드바 접기 / 펼치기"),
    hint: msg("좁은 화면에서는 사이드바 서랍을 열고 닫습니다"),
    default: "Mod+B+B",
  },
  {
    id: "newChat",
    label: msg("새 대화"),
    hint: msg("빈 새 대화를 엽니다. 그룹에서는 선택한 창만 바뀝니다"),
    default: "Mod+N",
  },
  {
    id: "closeSession",
    label: msg("현재 대화 닫기"),
    hint: msg("사이드바에서 치웁니다. 기록은 남아 다시 열 수 있습니다"),
    default: "Mod+D",
  },
  {
    id: "archiveSession",
    label: msg("현재 대화 보관"),
    hint: msg("닫지 않고 보관함에 넣습니다. 새 메시지가 오면 목록으로 돌아옵니다"),
    default: "Mod+W",
  },
  {
    id: "prevSession",
    label: msg("이전 대화로 이동"),
    hint: msg("사이드바에서 한 칸 위 대화로"),
    default: "Alt+ArrowUp",
  },
  {
    id: "nextSession",
    label: msg("다음 대화로 이동"),
    hint: msg("사이드바에서 한 칸 아래 대화로"),
    default: "Alt+ArrowDown",
  },
  {
    id: "prevWorkspace",
    label: msg("이전 워크스페이스로 이동"),
    hint: msg("한 칸 위 폴더의 첫 탭으로"),
    default: "Alt+Shift+ArrowUp",
  },
  {
    id: "nextWorkspace",
    label: msg("다음 워크스페이스로 이동"),
    hint: msg("한 칸 아래 폴더의 첫 탭으로"),
    default: "Alt+Shift+ArrowDown",
  },
  {
    id: "prevTab",
    label: msg("이전 탭으로 이동"),
    hint: msg("탭 바에서 왼쪽 탭으로"),
    default: "Alt+ArrowLeft",
  },
  {
    id: "nextTab",
    label: msg("다음 탭으로 이동"),
    hint: msg("탭 바에서 오른쪽 탭으로"),
    default: "Alt+ArrowRight",
  },
  {
    id: "lastSession",
    label: msg("직전에 보던 대화로 돌아가기"),
    hint: msg("두 대화를 오갈 때 씁니다"),
    default: "",
  },
  {
    id: "nextFinished",
    label: msg("작업이 끝난 대화로 이동"),
    hint: msg("끝났지만 아직 보지 않은 대화를 차례로 엽니다"),
    default: "",
  },
  {
    id: "focusSearch",
    label: msg("대화 검색"),
    hint: msg("사이드바를 펼치고 검색창으로 포커스를 옮깁니다"),
    default: "",
  },
  {
    id: "findInChat",
    label: msg("대화 안에서 찾기"),
    hint: msg("Enter 다음 · Shift+Enter 이전"),
    default: "Mod+F",
  },
  {
    id: "resume",
    label: msg("대화 열기"),
    hint: msg("닫은 대화를 포함해 목록에서 골라 열기"),
    default: "",
  },
  {
    id: "modelPicker",
    label: msg("모델 선택창 열기"),
    hint: msg("모델과 추론 강도를 고르는 창"),
    default: "Mod+M",
  },
  {
    id: "cycleModel",
    label: msg("즐겨찾기 모델 순환"),
    hint: msg("별표한 모델만 순서대로 넘깁니다"),
    default: "Mod+P",
  },
  {
    id: "cycleThinking",
    label: msg("추론 단계 변경"),
    hint: msg("minimal → … → max, 끝에서 처음으로 돌아갑니다"),
    default: "Shift+Tab",
  },
  {
    id: "forkSession",
    label: msg("대화 분기"),
    hint: msg("지금까지의 내용을 복사한 새 대화로 갈라집니다"),
    default: "",
  },
  {
    id: "retry",
    label: msg("응답 다시 시도"),
    hint: msg("마지막 응답을 다시 생성합니다 (/retry)"),
    default: "",
  },
  {
    id: "compact",
    label: msg("컨텍스트 압축"),
    hint: msg("긴 대화를 요약해 줄입니다. 요약 호출 비용이 발생합니다 (/compact)"),
    default: "",
  },
  {
    id: "copyLast",
    label: msg("마지막 답변 복사"),
    hint: msg("에이전트의 마지막 답변 텍스트를 클립보드에 복사합니다 (/copy)"),
    default: "",
  },
  {
    id: "scrollTop",
    label: msg("대화 맨 위로"),
    hint: msg("대화의 처음으로 스크롤합니다"),
    default: "",
  },
  {
    id: "scrollBottom",
    label: msg("대화 맨 아래로"),
    hint: msg("끝으로 스크롤하고 자동 따라가기를 켭니다"),
    default: "",
  },
  {
    id: "stop",
    label: msg("작업 중지"),
    hint: msg("실행 중인 에이전트를 멈춥니다"),
    default: "Escape",
    fixed: true,
  },
  {
    id: "steer",
    label: msg("끼워 넣기 (작업 중 메시지 보내기)"),
    hint: msg("진행 중인 작업에 바로 전달합니다"),
    default: "Enter",
    fixed: true,
  },
  {
    id: "queueMessage",
    label: msg("대기열에 추가 (작업 중 메시지 보내기)"),
    hint: msg("작업이 끝난 뒤 보내도록 대기열에 넣습니다"),
    default: "Alt+Enter",
  },
  {
    id: "cancelQueue",
    label: msg("대기열 / 끼워 넣기 취소"),
    hint: msg("전달 대기 중인 메시지 목록을 열어 하나씩 뺍니다"),
    default: "Mod+Backslash",
  },
  {
    id: "splitRight",
    label: msg("오른쪽으로 분할 (좌우)"),
    hint: msg("선택한 창 오른쪽에 새 대화를 엽니다"),
    default: "Mod+B+V",
  },
  {
    id: "newTerminal",
    label: msg("새 터미널"),
    hint: msg("지금 작업 폴더에서 서버의 셸을 엽니다"),
    default: "Mod+Alt+N",
  },
  {
    id: "splitTerminal",
    label: msg("아래에 터미널 열기"),
    hint: msg("선택한 창 아래에 터미널을 엽니다"),
    default: "",
  },
  {
    id: "splitTerminalRight",
    label: msg("오른쪽에 터미널 열기"),
    hint: msg("선택한 창 오른쪽에 터미널을 엽니다"),
    default: "Mod+Alt+Shift+Backquote",
  },
  {
    id: "splitDown",
    label: msg("아래로 분할 (상하)"),
    hint: msg("선택한 창 아래에 새 대화를 엽니다"),
    default: "Mod+B+Minus",
  },
  {
    id: "splitLeft",
    label: msg("왼쪽으로 분할"),
    hint: msg("지금 선택한 창 왼쪽에 새 대화를 만듭니다"),
    default: "",
  },
  {
    id: "splitUp",
    label: msg("위로 분할"),
    hint: msg("지금 선택한 창 위에 새 대화를 만듭니다"),
    default: "",
  },
  {
    id: "focusLeft",
    label: msg("왼쪽 창으로 포커스"),
    hint: msg("그룹 안에서 화면상 왼쪽에 있는 창을 선택합니다"),
    default: "",
  },
  {
    id: "focusRight",
    label: msg("오른쪽 창으로 포커스"),
    hint: msg("그룹 안에서 화면상 오른쪽에 있는 창을 선택합니다"),
    default: "",
  },
  {
    id: "focusUp",
    label: msg("위쪽 창으로 포커스"),
    hint: msg("그룹 안에서 화면상 위에 있는 창을 선택합니다"),
    default: "",
  },
  {
    id: "focusDown",
    label: msg("아래쪽 창으로 포커스"),
    hint: msg("그룹 안에서 화면상 아래에 있는 창을 선택합니다"),
    default: "",
  },
  {
    id: "cyclePane",
    label: msg("다음 창으로 포커스"),
    hint: msg("그룹 안의 창을 순서대로 돌아가며 선택합니다"),
    default: "",
  },
  {
    id: "ungroup",
    label: msg("현재 창을 그룹에서 빼기"),
    hint: msg("선택한 창만 그룹에서 떼어 냅니다. 대화는 닫히지 않습니다"),
    default: "",
  },
  {
    id: "zoomPane",
    label: msg("현재 창 크게 / 작게 보기"),
    hint: msg("선택한 창을 그룹 전체 크기로 키우거나 되돌립니다"),
    default: "Mod+Alt+ArrowUp",
  },
  {
    id: "restorePane",
    label: msg("창 크기 원래대로"),
    hint: msg("분할 화면으로 되돌립니다"),
    default: "",
  },
  {
    id: "toggleFull",
    label: msg("그룹 전체 보기 전환"),
    hint: msg("한 창을 가득 채우고 위 띠로 창을 고릅니다"),
    default: "",
  },
  {
    id: "workdir",
    label: msg("작업 폴더 변경"),
    hint: msg("새 대화가 시작할 작업 폴더를 고르는 창을 엽니다 (/cd)"),
    default: "",
  },
  {
    id: "skills",
    label: msg("스킬 열기"),
    hint: msg("지금 대화(또는 새 대화)의 스킬 목록을 엽니다"),
    default: "",
  },
  {
    id: "cycleServer",
    label: msg("다음 서버로 전환"),
    hint: msg("등록한 서버를 차례로 넘깁니다"),
    default: "Mod+Backquote",
  },
  { id: "toggleSound", label: msg("알림음 켜기 / 끄기"), hint: "", default: "" },
  { id: "settings", label: msg("설정 열기"), hint: "", default: "Mod+Comma" },
  { id: "toggleTheme", label: msg("라이트 / 다크 전환"), hint: "", default: "" },
  { id: "zoomIn", label: msg("화면 배율 키우기"), hint: msg("앱 전체를 10%씩 확대합니다 (최대 200%)"), default: "Mod+Equal" },
  { id: "zoomOut", label: msg("화면 배율 줄이기"), hint: msg("앱 전체를 10%씩 축소합니다 (최소 50%)"), default: "Mod+Minus" },
  { id: "zoomReset", label: msg("화면 배율 100%로"), hint: "", default: "Mod+0" },
  { id: "fullscreen", label: msg("전체 화면 전환"), hint: msg("창을 전체 화면으로 바꾸거나 되돌립니다"), default: "F11" },
];

const GROUP: Partial<Record<ActionId, ActionDef["group"]>> = {
  modelPicker: "model",
  cycleModel: "model",
  cycleThinking: "model",
  splitRight: "layout",
  splitDown: "layout",
  splitLeft: "layout",
  splitUp: "layout",
  focusLeft: "pane",
  focusRight: "pane",
  focusUp: "pane",
  focusDown: "pane",
  cyclePane: "pane",
  ungroup: "pane",
  zoomPane: "pane",
  restorePane: "pane",
  toggleFull: "pane",
  newTerminal: "layout",
  splitTerminal: "layout",
  splitTerminalRight: "layout",
  forkSession: "chat",
  retry: "chat",
  compact: "chat",
  copyLast: "chat",
  findInChat: "chat",
  scrollTop: "chat",
  scrollBottom: "chat",
  stop: "chat",
  steer: "chat",
  queueMessage: "chat",
  cancelQueue: "chat",
};

export const ACTIONS: ActionDef[] = BASE.map(
  (a) => ({ ...a, group: GROUP[a.id] ?? "general" }) as ActionDef,
);

export const DEFAULT_BINDINGS = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.default]),
) as Record<ActionId, string>;

export const isActionId = (v: string): v is ActionId =>
  ACTIONS.some((a) => a.id === v);

/** The most plain keys one shortcut can hold at once. Modifiers (Ctrl/⌘, Alt, Shift) do not count against it. */
export const MAX_KEYS = 3;

const MOD_ORDER = ["Mod", "Alt", "Shift"];

/** "KeyA" -> "A", "Digit1" -> "1", everything else is kept as is */
export const keyName = (code: string) =>
  code.startsWith("Key")
    ? code.slice(3)
    : code.startsWith("Digit")
      ? code.slice(5)
      : code;

/** Build the canonical combo string from the modifiers and the plain keys held at once. */
export function buildCombo(
  mods: { mod: boolean; alt: boolean; shift: boolean },
  keys: Iterable<string>,
): string {
  const parts: string[] = [];
  if (mods.mod) parts.push("Mod");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  // The order the keys were pressed in is kept: Ctrl+B then V is "Mod+B+V", and only B starts it (Ctrl+V alone is not
  // the start of anything). A key can appear twice (Ctrl+B+B: B pressed, let go, pressed again).
  parts.push(...keys);
  return parts.join("+");
}

/** The same combo with its plain keys sorted, to compare keys held together where the order does not matter. */
export function canonCombo(combo: string): string {
  if (!combo) return "";
  const { mods, keys } = splitCombo(combo);
  return [...mods, ...[...keys].sort()].join("+");
}

/** Whether `big` starts with exactly the keys of `small`, in order (B,V starts with B, but not with V). */
function startsWith(big: string[], small: string[]): boolean {
  return small.every((k, i) => big[i] === k);
}

/**
 * Whether some other bound shortcut starts with this one (same modifiers, more keys). Such a combo is not run
 * at once: it puts the app in a waiting state (see `nextChord`) until the next key, Enter or Esc.
 */
export function hasLongerBinding(combo: string, bindings: Record<string, string>): boolean {
  const me = splitCombo(combo);
  return Object.values(bindings).some((b) => {
    if (!b || b === combo) return false;
    const o = splitCombo(b);
    return (
      o.keys.length > me.keys.length &&
      o.mods.join() === me.mods.join() &&
      startsWith(o.keys, me.keys)
    );
  });
}

/** The action bound to exactly this combo (`fixed` ones such as Esc are handled elsewhere). */
export function actionFor(combo: string, bindings: Record<string, string>, anyOrder = false): ActionId | undefined {
  if (!combo) return undefined;
  const want = anyOrder ? canonCombo(combo) : combo;
  return ACTIONS.find((a) => !a.fixed && (anyOrder ? canonCombo(bindings[a.id] ?? "") : bindings[a.id]) === want)?.id;
}

export type ChordStep =
  | { kind: "wait"; prefix: Recording }
  | { kind: "run"; id: ActionId }
  | { kind: "none"; combo: string };

/**
 * One more key while a chord is waiting (Ctrl+B pressed, then C). The modifiers of the first press stay latched, so
 * it does not matter whether Ctrl is still held. There is no time limit: the chord ends by completing, by a key
 * that leads nowhere, or by Esc.
 */
export function nextChord(prefix: Recording, e: KeyLike, bindings: Record<string, string>): ChordStep {
  const mods = { mod: prefix.mod || e.ctrlKey || e.metaKey, alt: prefix.alt || e.altKey, shift: prefix.shift || e.shiftKey };
  const name = keyName(e.code);
  // Every key while waiting is a new press, so the same key twice (Ctrl+B, then B) is Ctrl+B+B.
  const keys = [...prefix.keys, name];
  const combo = buildCombo(mods, keys);
  if (keys.length > MAX_KEYS) return { kind: "none", combo };
  if (hasLongerBinding(combo, bindings)) return { kind: "wait", prefix: { ...mods, keys } };
  const id = actionFor(combo, bindings);
  return id ? { kind: "run", id } : { kind: "none", combo };
}

/** What can still be pressed after a waiting chord: the remaining keys of each longer shortcut, with its action. */
export function chordNext(prefix: Recording, bindings: Record<string, string>): { id: ActionId; rest: string }[] {
  const mods = [prefix.mod && "Mod", prefix.alt && "Alt", prefix.shift && "Shift"].filter(Boolean).join();
  const out: { id: ActionId; rest: string }[] = [];
  for (const a of ACTIONS) {
    const b = a.fixed ? "" : bindings[a.id];
    if (!b) continue;
    const o = splitCombo(b);
    if (o.mods.join() !== mods || o.keys.length <= prefix.keys.length || !startsWith(o.keys, prefix.keys)) continue;
    out.push({ id: a.id, rest: formatCombo(o.keys.slice(prefix.keys.length).join("+")) });
  }
  return out;
}

export const isModifierCode = (code: string) =>
  /^(Control|Shift|Alt|Meta|OS|AltGraph|CapsLock|Fn)/.test(code);

/** A shortcut being recorded: keys pile up as they are pressed, until the user confirms. */
export interface Recording {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  /** Plain keys in the order they were pressed */
  keys: string[];
}
export const emptyRecording = (): Recording => ({ mod: false, alt: false, shift: false, keys: [] });

type KeyLike = { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** Adds a pressed key. `rejected` is true when it would be a fourth plain key (the same key twice counts as two). */
export function recordKey(r: Recording, e: KeyLike): { next: Recording; rejected: boolean } {
  const next: Recording = { ...r, keys: [...r.keys] };
  if (/^(Control|Meta|OS)/.test(e.code)) next.mod = true;
  else if (/^Alt(?!Graph)/.test(e.code)) next.alt = true;
  else if (e.code.startsWith("Shift")) next.shift = true;
  if (isModifierCode(e.code)) return { next, rejected: false };
  next.mod ||= e.ctrlKey || e.metaKey;
  next.alt ||= e.altKey;
  next.shift ||= e.shiftKey;
  const name = keyName(e.code);
  // A key that is still held only repeats (the caller skips those); a fresh press of the same key counts again.
  if (next.keys.length >= MAX_KEYS) return { next: r, rejected: true };
  next.keys.push(name);
  return { next, rejected: false };
}

/** Backspace while recording: drops the last key, then the modifiers. */
export function undoRecording(r: Recording): Recording {
  if (r.keys.length) return { ...r, keys: r.keys.slice(0, -1) };
  return emptyRecording();
}

export const recordingIsEmpty = (r: Recording) => !r.mod && !r.alt && !r.shift && !r.keys.length;

/** The saved form (keys sorted so A+B equals B+A) */
export const recordingCombo = (r: Recording) => buildCombo(r, r.keys);

/** What is shown while recording: keys in the order they were pressed */
export function recordingLabel(r: Recording): string {
  const parts = [r.mod && "Mod", r.alt && "Alt", r.shift && "Shift", ...r.keys].filter((p): p is string => !!p);
  return formatCombo(parts.join("+"));
}

/** The modifiers and plain keys of a combo */
export function splitCombo(combo: string) {
  const parts = combo ? combo.split("+") : [];
  return {
    mods: parts.filter((p) => MOD_ORDER.includes(p)),
    keys: parts.filter((p) => !MOD_ORDER.includes(p)),
  };
}

/** Number of plain (non-modifier) keys in a combo */
export const keyCount = (combo: string) => splitCombo(combo).keys.length;

/**
 * Whether a bare Esc should stop the running agent. Esc already closes dialogs, menus and inline editors, so it
 * only stops the agent when none of those is open and focus is not in a text field other than the composer.
 */
export function escapeShouldStop(o: {
  busy: boolean;
  overlayOpen: boolean;
  target: { tagName?: string; isContentEditable?: boolean; dataset?: { composer?: string } } | null;
}): boolean {
  if (!o.busy || o.overlayOpen) return false;
  const t = o.target;
  if (!t) return true;
  if (t.isContentEditable) return false;
  const tag = t.tagName ?? "";
  if (tag === "INPUT" || tag === "SELECT") return false;
  if (tag === "TEXTAREA") return t.dataset?.composer !== undefined;
  return true;
}

/** True when the combo fires on keys alone, so it must not trigger while typing in a text field. */
export function isBareCombo(combo: string): boolean {
  const { mods, keys } = splitCombo(combo);
  // Function keys type nothing, so they are safe to fire from a text field
  if (keys.length === 1 && /^F\d{1,2}$/.test(keys[0]!)) return false;
  // Shift+Tab types nothing either; if the user bound it, it must fire from the composer instead of moving focus
  if (keys.length === 1 && keys[0] === "Tab" && mods.includes("Shift")) return false;
  return !mods.includes("Mod") && !mods.includes("Alt");
}

export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const KEY_NAMES: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
};

/** "Mod+Shift+Comma" -> "Ctrl+Shift+," (or "⌘⇧," on a Mac); "J+K+L" stays "J+K+L" */
export function formatCombo(combo: string): string {
  if (!combo) return "";
  const { mods, keys } = splitCombo(combo);
  const names: string[] = mods.map((p) =>
    p === "Mod"
      ? isMac
        ? "⌘"
        : "Ctrl"
      : p === "Alt"
        ? isMac
          ? "⌥"
          : "Alt"
        : isMac
          ? "⇧"
          : "Shift",
  );
  names.push(...keys.map((k) => KEY_NAMES[k] ?? k));
  return names.join(
    isMac && !keys.length
      ? ""
      : isMac && mods.length && keys.length === 1
        ? ""
        : "+",
  );
}
