/**
 * Device preferences: theme, notification sound, keyboard shortcuts. Kept on this device only (localStorage + durable
 * mirror); a settings file or backup carries them through `capture` / `apply`.
 */
import { MAX_VOLUME, play, volumeGain, type Cue } from "./sound";
import { ACTIONS, DEFAULT_BINDINGS, isActionId, type ActionId } from "./keys";
import { extensions } from "./extensions/host.svelte";
import { syncSystemBars, syncWindowTheme } from "./native-push";
import { setDurableSetting } from "./durable-storage";
import { K, read, write } from "./persist";
import { applyUiScale, clampScale, stepScale } from "./ui-scale";
import { DEFAULT_TERMINAL, sanitizeTerminal, type TerminalPrefs } from "./terminal-prefs";

export type ThemePref = "system" | "dark" | "light";

/** Slider value, 0-MAX_VOLUME where 100 is the base loudness. */
function readVolume(): number {
  const v = read<number | null>(K.volume, null);
  return typeof v === "number" ? Math.min(MAX_VOLUME, Math.max(0, v)) : 100;
}

function readBindings(): Record<ActionId, string> {
  const raw = read<Record<string, unknown> | null>(K.keys, null);
  const out = { ...DEFAULT_BINDINGS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, combo] of Object.entries(raw))
      if (isActionId(id) && typeof combo === "string" && !ACTIONS.find((a) => a.id === id)?.fixed) out[id] = combo;
  }
  return out;
}

// Stored as a bare string because index.html reads it before the app boots.
function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(K.theme);
    return v === "dark" || v === "light" ? v : "system";
  } catch {
    return "system";
  }
}

export interface PreferenceValues {
  theme?: ThemePref;
  sound?: boolean;
  volume?: number;
}

export class Preferences {
  theme = $state<ThemePref>(readTheme());
  prefersDark = $state(typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  soundOn = $state(read<boolean>(K.sound, true));
  soundVolume = $state(readVolume());
  /** Whole-app zoom in percent (100 = normal). */
  uiScale = $state(clampScale(read<unknown>(K.uiScale, 100)));
  bindings = $state<Record<ActionId, string>>(readBindings());
  terminal = $state<TerminalPrefs>(sanitizeTerminal(read<unknown>(K.terminal, null)));
  /** The shortcut editor is capturing keys: global shortcuts stand down. */
  recordingKey = $state(false);

  /** Apply the theme now and follow the OS when it is "system". */
  init() {
    this.applyTheme();
    applyUiScale(this.uiScale);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      this.prefersDark = e.matches;
      if (this.theme === "system") this.applyTheme();
    });
  }

  /** Durable storage brought back what the WebView had lost: read everything again. */
  reload() {
    this.theme = readTheme();
    this.soundOn = read<boolean>(K.sound, true);
    this.soundVolume = readVolume();
    this.terminal = sanitizeTerminal(read<unknown>(K.terminal, null));
    this.uiScale = clampScale(read<unknown>(K.uiScale, 100));
    applyUiScale(this.uiScale);
    this.applyTheme();
  }

  /* ---------- theme ---------- */

  setTheme(t: ThemePref) {
    this.theme = t;
    try {
      localStorage.setItem(K.theme, t);
      void setDurableSetting(K.theme, JSON.stringify(t));
    } catch {
      /* storage unavailable */
    }
    this.applyTheme();
  }

  get resolvedDark(): boolean {
    return this.theme === "dark" || (this.theme === "system" && this.prefersDark);
  }

  private applyTheme() {
    const dark = this.resolvedDark;
    const root = document.documentElement;
    if (root.dataset.theme && root.dataset.theme !== (dark ? "dark" : "light")) {
      // Flip every colour in one frame (see `.theme-switching` in app.css).
      root.classList.add("theme-switching");
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
    }
    root.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#161616" : "#ffffff");
    extensions.applyThemes();
    // After the new colours are in force: the bars copy --bg as it is now.
    requestAnimationFrame(() => syncSystemBars());
    // The desktop window frame follows the choice made here (or the OS when it is "system"), not only the page inside it.
    syncWindowTheme(this.theme);
  }

  /* ---------- zoom ---------- */

  setUiScale(percent: number) {
    this.uiScale = clampScale(percent);
    write(K.uiScale, this.uiScale);
    applyUiScale(this.uiScale);
  }

  /** One step up (+1) or down (-1). */
  stepUiScale(dir: 1 | -1) {
    this.setUiScale(stepScale(this.uiScale, dir));
  }

  /* ---------- sound ---------- */

  /** Play a cue. It sounds even while the user is watching that very session; only the sound setting silences it. */
  cue(c: Cue) {
    if (!this.soundOn) return;
    play(c, volumeGain(this.soundVolume));
  }

  setSound(on: boolean) {
    this.soundOn = on;
    write(K.sound, on);
    if (on) play("done", volumeGain(this.soundVolume)); // preview, and unlocks audio from this very click
  }

  setSoundVolume(percent: number) {
    this.soundVolume = Math.min(MAX_VOLUME, Math.max(0, Math.round(percent)));
    write(K.volume, this.soundVolume);
  }

  /** Let the user hear the current volume (called when they let go of the slider) */
  previewSound() {
    play("done", volumeGain(this.soundVolume));
  }

  /* ---------- terminal ---------- */

  setTerminal(patch: Partial<TerminalPrefs>) {
    this.terminal = sanitizeTerminal({ ...this.terminal, ...patch });
    write(K.terminal, this.terminal);
  }

  resetTerminal() {
    this.terminal = { ...DEFAULT_TERMINAL };
    write(K.terminal, this.terminal);
  }

  /* ---------- shortcuts ---------- */

  /** Bind `combo` to `id`. A combo can only do one thing, so another action holding it is unbound and returned. */
  setBinding(id: ActionId, combo: string): ActionId | null {
    if (ACTIONS.find((a) => a.id === id)?.fixed) return null;
    let taken: ActionId | null = null;
    const next = { ...this.bindings, [id]: combo };
    if (combo) {
      for (const a of ACTIONS) {
        if (a.id !== id && next[a.id] === combo) {
          next[a.id] = "";
          taken = a.id;
        }
      }
    }
    this.bindings = next;
    this.saveBindings();
    return taken;
  }

  resetBindings(id?: ActionId) {
    if (id) return void this.setBinding(id, DEFAULT_BINDINGS[id]);
    this.bindings = { ...DEFAULT_BINDINGS };
    this.saveBindings();
  }

  private saveBindings() {
    write(K.keys, this.changedBindings());
  }

  /** Shortcuts that differ from the default: what a settings file carries, so a later default change still applies. */
  changedBindings(): Record<string, string> {
    const diff: Record<string, string> = {};
    for (const a of ACTIONS) if (!a.fixed && this.bindings[a.id] !== a.default) diff[a.id] = this.bindings[a.id];
    return diff;
  }

  /** Set shortcuts from a file. An action the file does not mention keeps what it has; a combo already used elsewhere frees that other action. */
  mergeBindings(keybindings: Record<string, string> | undefined) {
    if (!keybindings) return;
    const next = { ...this.bindings };
    for (const [id, combo] of Object.entries(keybindings)) {
      if (!isActionId(id)) continue;
      if (combo) for (const a of ACTIONS) if (a.id !== id && next[a.id] === combo && !(a.id in keybindings)) next[a.id] = "";
      next[id] = combo;
    }
    this.bindings = next;
    this.saveBindings();
  }

  /** Replace every shortcut (a backup restore): unnamed actions go back to their default. */
  replaceBindings(keybindings: Record<string, string>) {
    const back = { ...DEFAULT_BINDINGS };
    for (const [id, combo] of Object.entries(keybindings)) if (isActionId(id)) back[id] = combo;
    this.bindings = back;
    this.saveBindings();
  }

  /* ---------- settings files ---------- */

  capture(): Required<PreferenceValues> {
    return { theme: this.theme, sound: this.soundOn, volume: this.soundVolume };
  }

  apply(p: PreferenceValues) {
    if (p.theme !== undefined) this.setTheme(p.theme);
    if (p.sound !== undefined) {
      this.soundOn = p.sound;
      write(K.sound, p.sound);
    }
    if (p.volume !== undefined) this.setSoundVolume(p.volume);
  }
}
