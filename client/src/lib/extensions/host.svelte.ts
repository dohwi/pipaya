import { HttpReader } from "./http";
import { addLocalPack, LocalizedError, msg, removeLocalPacks, t } from "../i18n";
import { parseNotification, parseNotificationRule, type NotificationSpec, type NotificationResult, type NotificationRule, type NotificationStatus } from "../notification-contract";
import {
  ConfigurationManager, CONFIGURATION_GRANT, SETTINGS_SOURCE, applyWithBackup, parseConfiguration, planConfiguration, publicSettings, restoreBackup,
  type ConfigurationDocument, type ConfigurationPlan,
} from "./configuration";
import { canonical, configurationFingerprint, sha256 } from "./fingerprint";
import { JsonTransport } from "./transport";
import { NAVBAR_LIMITS, NAVBAR_NODE_TYPES, navbarId, parseNavbarItem, type NavbarItem, type NavbarItemSpec } from "./navbar";
import { Api, normalizeUrl, type Connection } from "../api";
import { describeSettingErrors, fillSettingDefaults, parsePackage, resolveSettings, type ExtensionPackage, type Permission } from "./schema";
import { ExtensionRuntime } from "./runtime";
import { parsePanelSpec, parseView, validateUIEvent, type UIPanelSpec, type UINode, type UIEvent, type UITone } from "./ui";

import type { ExtensionContext, ExtensionEvent, ServerExtensionEvent, ToolRenderInput } from "./sdk";
import { splitCombo } from "../keys";
import type { PaneAdapter } from "./panes";
import type { Edge } from "../layout";
export type { ExtensionContext } from "./sdk";
export interface HostAdapter {
  prefill(text: string): void;
  notify(text: string): void;
  systemNotifications?: {
    send(owner: string, spec: NotificationSpec): Promise<NotificationResult>;
    status(): Promise<NotificationStatus>;
    register(owner: string, id: string, rule: NotificationRule): Promise<void>;
    remove(owner: string, id: string): Promise<void>;
    revoke(owner: string): Promise<void>;
  };
  context(): ExtensionContext;
  /** Server-extension and session access for extensions that hold the `server` / `session` / `dialogs` permissions. */
  session?: {
    send(text: string, mode: "prompt" | "steer" | "follow_up"): Promise<void>;
    abort(): Promise<void>;
  };
  /** Orchestration of the panes (conversations and terminals) of the open group, for extensions with the `panes` permission. */
  panes?: PaneAdapter;
  /** Modal questions. Resolve to null when the user dismisses them. */
  dialog?(request: ExtensionDialogRequest): Promise<unknown>;
  dark(): boolean;
  reservedCommands(): string[];
  /** Authenticated connection of the open server; settings sync is skipped (local only) without one. */
  connection?(): Connection | null;
  /** Id of the open server: the installed list is kept per server */
  serverId?(): string | null;
  /** The list of installed packages changed; it is shared with every client of this server */
  listChanged?(): void;
  /** Which server extensions are switched on changed; the server keeps it so every device follows */
  statesChanged?(): void;
  configuration?: {
    capture(): Pick<ConfigurationDocument, "servers" | "preferences" | "keybindings">;
    apply(document: ConfigurationDocument): void;
    applyBackground?(document: ConfigurationDocument): void;
    backup(): unknown;
    restore(value: unknown): void;
    confirm(message: string): Promise<boolean>;
  };
}
/**
 * Where an extension is installed. "server": part of the open server's work, shared by every device connected to it;
 * "device": only on this device, kept whichever server is open, never sent to a server.
 */
export type ExtensionScope = "server" | "device";
export interface InstalledExtension {
  package: ExtensionPackage;
  scope: ExtensionScope;
  enabled: boolean;
  state: "disabled" | "starting" | "active" | "error";
  error?: string;
  settings: Record<string, unknown>;
  /** False until the user explicitly saved the settings of a newly installed package that declares a schema. */
  configured: boolean;
}
/** A stored entry this version cannot read. Kept untouched so a newer version can still read it. */
export interface UnreadableExtension { raw: unknown; id?: string; name?: string; reason: string; scope?: ExtensionScope }
export interface ExtensionCommand { owner: string; name: string; desc: string; args?: string; run(arg: string): Promise<void> }
export interface ComposerAction { owner: string; id: string; label: string; run(): Promise<void> }
export interface StatusItem { owner: string; id: string; text: string }
export interface ExtensionShortcut { owner: string; id: string; label: string; combo: string; run(): Promise<void> }
export interface SlotItem extends NavbarItemSpec { owner: string; id: string; slot: "header" | "footer" }
export interface MessageRenderer { owner: string; entryType: string; render(entry: EntryInput): Promise<UINode | null> }
export interface EntryInput { id: number; extension: string; type: string; data: unknown; createdAt: number }
export interface ComposerFilter { owner: string; run(text: string): Promise<string | { text: string } | { cancel: string } | null> }
/** A short label a extension puts on a session in the sidebar and the pane header (e.g. `@name`). */
export interface SessionLabel { text: string; title?: string }
/** One `@` completion an extension offers in the composer; `insert` is what lands in the text and what is highlighted. */
export interface MentionItem { insert: string; desc: string; group: string; keywords: string; except: string }
/** How a user message from another session starts: the first line matches `first` and group 1 is the sender. */
export interface SenderRule { owner: string; first: RegExp }
export interface ToolRenderer { owner: string; toolName: string; render(input: ToolRenderInput): Promise<UINode | null> }
export type ExtensionDialogRequest = { owner: string; ownerName: string } & (
  | { kind: "confirm"; title: string; message?: string; confirmLabel?: string }
  | { kind: "select"; title: string; message?: string; options: { value: string; label: string; description?: string }[] }
  | { kind: "input"; title: string; message?: string; placeholder?: string; value?: string; multiline?: boolean }
);
export interface ExtensionPanel extends Omit<UIPanelSpec, "view"> {
  owner: string;
  view: UINode;
  /** "danger" paints the launcher badge red; set by the extension through ui.update(id, view, {tone}). */
  tone?: UITone;
  revision: number;
  run(event: UIEvent): Promise<void>;
}
export interface ExtensionLog { owner: string; text: string; at: number }
const KEY = "pipaya.extensions.v1";
const SAFE = "pipaya.extensions.safe";
/** JSON array of the extension ids whose enable() is currently in flight. */
const BOOT = "pipaya.extensions.booting";
const KEPT = "pipaya.extensions.kept";
const CORRUPT = "pipaya.extensions.v1.corrupt";
/** The extensions installed on this device only (the server ones live under `KEY.<serverId>`). */
const DEVICE_KEY = "pipaya.extensions.device.v1";
const DEVICE_CORRUPT = "pipaya.extensions.device.v1.corrupt";
const MAX_ENTRIES = 50;
const STORE = "pipaya.extension.storage.";
const SYNC_FETCH_MS = 3000;
const SYNC_PUT_MS = 10000;
export const SYNC_SAVE_FAILED = msg("서버에 저장하지 못해 이 브라우저에만 저장됨");
export const CONFIG_REQUIRED = msg("먼저 설정을 저장해야 활성화할 수 있습니다");
export const BOOT_INTERRUPTED = msg("시작이 완료되지 않아 비활성화했습니다");
export const SYNC_LOAD_FAILED = msg("서버에서 설정을 불러오지 못해 이 브라우저에 저장된 설정을 사용합니다");

function string(value: unknown, max: number, label = msg("문자열")): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new LocalizedError(t("잘못된 {label}", { label: t(label) }));
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalizedError(t("객체가 필요합니다"));
  return value as Record<string, unknown>;
}
/** Run a request with a hard deadline, even if the fetch implementation ignores the abort signal. */
async function within<T>(ms: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new LocalizedError(t("시간 초과"))); }, ms); });
  try { return await Promise.race([task(controller.signal), deadline]); } finally { clearTimeout(timer); }
}
function plain(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/**
 * A plain-JSON copy. Deliberately JSON rather than structuredClone: extension settings come from extension code and must
 * stay JSON (undefined and functions dropped, the same shape the server stores), and a Svelte $state proxy cannot be
 * structured-cloned at all.
 */
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
/** Best-effort id/name of a stored entry that failed to parse. */
function identify(raw: unknown): { id?: string; name?: string } {
  const entry = plain(raw);
  const manifest = plain(plain(entry?.package)?.manifest) ?? plain(entry?.manifest);
  const out: { id?: string; name?: string } = {};
  if (typeof manifest?.id === "string" && manifest.id) out.id = manifest.id.slice(0, 80);
  if (typeof manifest?.name === "string" && manifest.name) out.name = manifest.name.slice(0, 80);
  return out;
}
function localId(value: unknown): string {
  const id = string(value, 40, "ID");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new LocalizedError(t("ID는 소문자·숫자·하이픈만 사용할 수 있습니다"));
  return id;
}

/** Shortcuts are the user's own: they go into a settings file, but an extension asking for the settings never gets them. */
function withoutKeybindings<T extends { keybindings?: unknown }>(doc: T, strip: boolean): Omit<T, "keybindings"> & Partial<Pick<T, "keybindings">> {
  if (!strip) return doc;
  const { keybindings: _omit, ...rest } = doc;
  return rest;
}

export class ExtensionHost {
  installed = $state<InstalledExtension[]>([]);
  commands = $state.raw<ExtensionCommand[]>([]);
  actions = $state.raw<ComposerAction[]>([]);
  statuses = $state<StatusItem[]>([]);
  navbar = $state.raw<NavbarItem[]>([]);
  shortcuts = $state.raw<ExtensionShortcut[]>([]);
  toolRenderers = $state.raw<ToolRenderer[]>([]);
  slots = $state.raw<SlotItem[]>([]);
  messageRenderers = $state.raw<MessageRenderer[]>([]);
  private composerFilters = new Map<string, ComposerFilter>();
  private labelSets = $state.raw<{ owner: string; labels: Record<string, SessionLabel> }[]>([]);
  private mentionSets = $state.raw<{ owner: string; items: MentionItem[] }[]>([]);
  private senderRules = $state.raw<SenderRule[]>([]);
  private serverSubscribed = new Set<string>();
  private sessionCalls = new Map<string, number[]>();
  private paneCalls = new Map<string, number[]>();
  private httpReader = new HttpReader();
  logs = $state<ExtensionLog[]>([]);
  panels = $state.raw<ExtensionPanel[]>([]);
  activePanel = $state<string | null>(null);
  panelOpen = $state(false);
  safeMode = $state(false);
  loadError = $state("");
  /** Stored entries this version cannot parse; written back unchanged by save(). */
  unreadable = $state<UnreadableExtension[]>([]);
  private adapter: HostAdapter | null = null;
  private runtimes = new Map<string, ExtensionRuntime>();
  private subscribed = new Set<string>();
  private pendingPanelOpens = new Map<string, string>();
  private themes = new Set<string>();
  private generations = new Map<string, number>();
  private initialized = false;
  private booting = new Map<string, number>();
  /** Raw storage text of a corrupt list; backed up once before the first write over it. */
  private corruptRaw: string | null = null;
  private deviceCorruptRaw: string | null = null;
  /** The shared list as last reported to the server sync, so a change to a device extension does not trigger an upload. */
  private lastShared: string | null = null;
  private notificationTimes = new Map<string, number[]>();
  /** Non-blocking message shown while settings exist only in this browser. */
  syncNotice = $state("");
  /** Ids whose latest settings have not reached the server yet (retried on the next save). */
  private unsynced = new Set<string>();
  private touched = new Set<string>();
  /** Last settings payload read from the server, used to restore settings of a reinstalled id. */
  private remote: Record<string, unknown> = {};
  private puts = new Map<string, Promise<void>>();
  private configurations = new Map<string, ConfigurationManager>();
  private transport = new JsonTransport();
  /** Settings go to the server only for a server extension whose manifest does not keep them local. */
  private sharesSettings(entry: InstalledExtension): boolean { return entry.scope === "server" && entry.package.manifest.settingsScope !== "local"; }
  private localSettings(): boolean { return localStorage.getItem(SETTINGS_SOURCE) === "local"; }

  /** Storage key of the open server's list (the device-wide list when no server is open) */
  private listKey(): string {
    const id = this.adapter?.serverId?.() ?? null;
    return id ? `${KEY}.${id}` : KEY;
  }
  /** The open server's list as stored on this device. */
  private storedList(): string | null {
    return localStorage.getItem(this.listKey());
  }
  private ready!: () => void;
  private readyPromise = new Promise<void>(resolve => { this.ready = resolve; });
  /** Resolves once init() has loaded the list of the server that was open at launch */
  whenReady(): Promise<void> { return this.readyPromise; }

  /** Parse one stored list into `installed` / `unreadable`. A device extension wins over a server one with the same id. */
  private readList(text: string | null, scope: ExtensionScope) {
    try {
      const raw: unknown = JSON.parse(text ?? "[]");
      if (!Array.isArray(raw) || raw.length > MAX_ENTRIES) throw new LocalizedError(t("잘못된 확장 목록"));
      for (const item of raw) {
        try {
          const entry = object(item);
          const pkg = parsePackage(entry.package);
          if (this.installed.some(e => e.package.manifest.id === pkg.manifest.id)) throw new LocalizedError(t("중복 확장 ID"));
          this.installed.push({ package: pkg, scope, enabled: entry.enabled === true, state: "disabled", configured: entry.configured !== false, settings: plain(entry.settings) ?? {} });
        } catch (e) { this.unreadable.push({ raw: item, scope, ...identify(item), reason: e instanceof Error ? e.message : String(e) }); }
      }
    } catch (e) {
      this.loadError = t("확장 설정을 읽지 못했습니다: {error}", { error: e instanceof Error ? e.message : String(e) });
      if (scope === "device") this.deviceCorruptRaw = text; else this.corruptRaw = text;
    }
  }

  /**
   * Read the installed lists and the recovery state. Called at launch (both lists) and whenever the open server
   * changes (only the server's list: the device's own extensions stay as they are).
   */
  private loadList(opts: { device: boolean } = { device: true }) {
    let booting: string[] = [];
    try {
      this.safeMode = localStorage.getItem(SAFE) === "1" || new URLSearchParams(location.search).get("extensions") === "off";
      booting = this.bootingIds();
    } catch { /* treat as normal mode */ }
    this.lastShared = null;
    // Device extensions first, so one that shares an id with a server extension is the one that stays.
    if (opts.device) this.readList(localStorage.getItem(DEVICE_KEY), "device");
    this.readList(this.storedList(), "server");
    // Only the extensions whose start never finished are switched off; everything else starts normally.
    if (booting.length) {
      let changed = false;
      for (const e of this.installed) {
        if (!booting.includes(e.package.manifest.id)) continue;
        e.enabled = false; e.state = "disabled"; e.error = t(BOOT_INTERRUPTED); changed = true;
      }
      this.writeBooting([]);
      if (changed) { try { this.save(); } catch { /* ignore */ } }
    }
  }

  init(adapter: HostAdapter) {
    this.adapter = adapter;
    if (this.initialized) return;
    this.initialized = true;
    this.loadList();
    this.ready();
    void this.boot();
  }

  /** Read this server's settings, then start every extension that is switched on, one at a time. */
  private async boot() {
    if (!this.adapter) return;
    const connection = this.adapter.connection?.() ?? null;
    // An extension that is already running (a device extension, across a server switch) is left alone.
    const enabled = this.safeMode ? [] : this.installed.filter(e => e.enabled && e.state !== "active" && e.state !== "starting");
    if (!connection && !enabled.length) return;
    await (async () => {
      // The server is the source of truth for settings: read it before any extension starts.
      if (connection && !this.localSettings()) await this.syncSettings(connection).catch(() => {});
      if (this.safeMode || !enabled.length) return;
      // Start sequentially, so recovery and the UI remain responsive.
      for (const e of enabled) {
        if (this.safeMode || !e.enabled) continue;
        const id = e.package.manifest.id;
        const problem = this.configRequired(id) ? t(CONFIG_REQUIRED) : this.settingsProblem(id);
        if (problem) { e.enabled = false; e.state = "disabled"; e.error = problem; try { this.save(); } catch { /* ignore */ } continue; }
        await this.enable(id).catch(() => {});
      }
    })();
  }

  private bootingIds(): string[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(BOOT) ?? "[]");
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    } catch { return []; }
  }
  private writeBooting(ids: string[]) {
    try { if (ids.length) localStorage.setItem(BOOT, JSON.stringify(ids)); else localStorage.removeItem(BOOT); } catch { /* ignore */ }
  }
  private markBooting(id: string) {
    const count = this.booting.get(id) ?? 0;
    this.booting.set(id, count + 1);
    const ids = this.bootingIds();
    if (!ids.includes(id)) this.writeBooting([...ids, id]);
  }
  private unmarkBooting(id: string) {
    const count = (this.booting.get(id) ?? 1) - 1;
    if (count > 0) { this.booting.set(id, count); return; }
    this.booting.delete(id);
    this.writeBooting(this.bootingIds().filter(other => other !== id));
  }

  /** True while a newly installed package with a settings schema still waits for its first explicit save. */
  configRequired(id: string): boolean {
    const entry = this.find(id);
    return !!entry.package.manifest.settings && !entry.configured;
  }

  /** Reason the extension cannot be enabled because of its settings schema, or "" when it can. */
  settingsProblem(id: string): string {
    const fields = this.find(id).package.manifest.settings;
    if (!fields) return "";
    const { ok, errors } = resolveSettings(fields, this.find(id).settings);
    return ok ? "" : t("필수 설정을 확인하세요 — {detail}", { detail: describeSettingErrors(fields, errors) });
  }
  /** Settings as the extension sees them: schema-resolved when declared, otherwise the raw object. */
  effectiveSettings(id: string): Record<string, unknown> {
    const entry = this.find(id);
    const fields = entry.package.manifest.settings;
    if (!fields) return clone(entry.settings);
    return { ...resolveSettings(fields, entry.settings).values };
  }

  private async syncSettings(connection: Connection) {
    const api = new Api(connection);
    let remote: Record<string, unknown>;
    try {
      const res = await within(SYNC_FETCH_MS, signal => api.extensionSettings(signal));
      if (!res || typeof res.settings !== "object" || !res.settings || Array.isArray(res.settings)) throw new LocalizedError(t("잘못된 응답"));
      remote = res.settings;
    } catch {
      this.syncNotice = SYNC_LOAD_FAILED;
      return;
    }
    if (this.localSettings()) return;
    this.remote = remote;
    let changed = false;
    for (const entry of this.installed) {
      const id = entry.package.manifest.id;
      if (this.touched.has(id) || !this.sharesSettings(entry)) continue;
      const value = Object.hasOwn(remote, id) ? remote[id] : undefined;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        entry.settings = clone(value as Record<string, unknown>); changed = true;
        if (entry.package.manifest.settings && !entry.configured) entry.configured = true; // the server already holds this id's settings
      } else if (value === undefined && Object.keys(entry.settings).length) {
        void this.push(id); // the server has nothing for this id yet: give it this device's copy
      }
    }
    if (changed) { try { this.save(); } catch { /* cache only */ } }
    if (this.syncNotice === SYNC_LOAD_FAILED) this.syncNotice = "";
  }
  /** Best-effort PUT of the current settings; failures are surfaced via syncNotice and retried on the next save. */
  private push(id: string): Promise<void> {
    const connection = this.adapter?.connection?.() ?? null;
    if (!connection || this.localSettings()) return Promise.resolve();
    const run = async () => {
      const entry = this.installed.find(e => e.package.manifest.id === id);
      if (!entry || this.localSettings() || !this.sharesSettings(entry)) return;
      try {
        await within(SYNC_PUT_MS, signal => new Api(connection).saveExtensionSettings(id, clone(entry.settings), signal));
        this.unsynced.delete(id); this.remote[id] = clone(entry.settings);
        if (!this.unsynced.size && this.syncNotice === SYNC_SAVE_FAILED) this.syncNotice = "";
      } catch {
        this.unsynced.add(id); this.syncNotice = SYNC_SAVE_FAILED;
      }
    };
    const next = (this.puts.get(id) ?? Promise.resolve()).then(run, run);
    this.puts.set(id, next);
    void next.finally(() => { if (this.puts.get(id) === next) this.puts.delete(id); });
    return next;
  }

  private save() {
    if (this.corruptRaw !== null) {
      // Never lose the unreadable list: back it up once, before the first write over it.
      localStorage.setItem(CORRUPT, this.corruptRaw);
      this.corruptRaw = null;
    }
    if (this.deviceCorruptRaw !== null) {
      localStorage.setItem(DEVICE_CORRUPT, this.deviceCorruptRaw);
      this.deviceCorruptRaw = null;
    }
    const stored = (scope: ExtensionScope) => [
      ...this.installed.filter(e => e.scope === scope).map(e => ({ package: e.package, enabled: e.enabled, settings: e.settings, configured: e.configured })),
      ...this.unreadable.filter(u => (u.scope ?? "server") === scope).map(u => u.raw),
    ];
    localStorage.setItem(this.listKey(), JSON.stringify(stored("server")));
    const device = stored("device");
    if (device.length) localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
    else localStorage.removeItem(DEVICE_KEY);
    // Only a change to the shared (server) list is worth telling the server about.
    const shared = JSON.stringify(this.packages() ?? null);
    if (shared === this.lastShared) return;
    this.lastShared = shared;
    if (!this.applyingRemote) this.adapter?.listChanged?.();
  }

  /* ---------- the list is per server ---------- */

  private applyingRemote = false;
  /** What the user chose per server extension (true = on). Shared with the server; a start that fails does not change it. */
  private wanted: Record<string, boolean> = {};

  /** On/off choices of this server's extensions, or undefined while none was ever made. */
  states(): Record<string, boolean> | undefined {
    const out: Record<string, boolean> = {};
    for (const e of this.installed) { const id = e.package.manifest.id; if (e.scope === "server" && Object.hasOwn(this.wanted, id)) out[id] = this.wanted[id]!; }
    return Object.keys(out).length ? out : undefined;
  }
  private choose(id: string, on: boolean) {
    const e = this.installed.find(x => x.package.manifest.id === id);
    if (!e || e.scope !== "server" || this.wanted[id] === on) return;
    this.wanted[id] = on;
    if (!this.applyingRemote) this.adapter?.statesChanged?.();
  }
  /** Take the server's on/off choices: switch extensions on or off here to match. Failures stay on this device. */
  applyStates(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    this.wanted = {};
    for (const [id, on] of Object.entries(value)) if (typeof on === "boolean" && /^[a-z][a-z0-9.-]*$/.test(id)) this.wanted[id] = on;
    this.followStates();
  }
  private followStates() {
    if (this.safeMode) return;
    this.applyingRemote = true;
    try {
      for (const e of [...this.installed]) {
        const id = e.package.manifest.id;
        if (e.scope !== "server" || !Object.hasOwn(this.wanted, id)) continue;
        if (this.wanted[id] && !e.enabled && e.state !== "starting") void this.enable(id).catch(() => {});
        else if (!this.wanted[id] && e.enabled) this.disable(id);
      }
    } finally { this.applyingRemote = false; }
  }

  /** Installed packages in a stable order: what is shared with the other clients of this server. Activation and consent stay on the device. */
  packages(): unknown[] | undefined {
    const shared = this.installed.filter(e => e.scope === "server");
    if (localStorage.getItem(this.listKey()) === null && !shared.length) return undefined;
    return shared.map(e => clone(e.package)).sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1));
  }

  /** Make this device's installed list match the server's: new packages arrive switched off, changed ones lose consent, removed ones go. */
  applyPackages(value: unknown) {
    if (!Array.isArray(value) || value.length > MAX_ENTRIES) return;
    const wanted = new Map<string, ExtensionPackage>();
    for (const item of value) { try { const pkg = parsePackage(item); wanted.set(pkg.manifest.id, pkg); } catch { /* a package this version cannot read stays out */ } }
    this.applyingRemote = true;
    try {
      for (const e of [...this.installed]) {
        const id = e.package.manifest.id;
        if (e.scope !== "server") continue; // this device's own extensions are not the server's to remove
        if (!wanted.has(id)) { try { this.remove(id, { keepSettings: true }); } catch { /* keep what is there */ } }
      }
      for (const [id, pkg] of wanted) {
        const old = this.installed.find(e => e.package.manifest.id === id);
        if (old && old.scope !== "server") continue; // a device extension with this id stays as it is
        if (old && canonical(old.package) === canonical(pkg)) continue;
        try { this.install(pkg, "server"); } catch { /* over the limit: leave it out */ }
      }
    } finally { this.applyingRemote = false; }
    try { this.save(); } catch { /* cache only */ }
    this.followStates();
  }

  /** The open server changed: put that server's extensions in place of the previous one's. */
  async switchServer() {
    if (!this.initialized) return;
    this.booting.clear(); this.writeBooting([]);
    for (const e of this.installed) if (e.scope === "server") this.cleanup(e.package.manifest.id);
    this.installed = this.installed.filter(e => e.scope === "device");
    this.unreadable = this.unreadable.filter(u => u.scope === "device");
    this.remote = {}; this.wanted = {}; this.touched.clear(); this.unsynced.clear();
    this.loadError = ""; this.syncNotice = ""; this.corruptRaw = null; this.panelOpen = false; this.activePanel = null;
    this.loadList({ device: false });
    this.applyThemes();
    await this.boot();
  }

  private keptMap(): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    try {
      const stored = plain(JSON.parse(localStorage.getItem(KEPT) ?? "{}"));
      for (const [id, value] of Object.entries(stored ?? {})) { const v = plain(value); if (v) out.set(id, v); }
    } catch { /* treat as empty */ }
    return out;
  }
  private writeKept(map: Map<string, Record<string, unknown>>) {
    try { if (map.size) localStorage.setItem(KEPT, JSON.stringify(Object.fromEntries(map))); else localStorage.removeItem(KEPT); } catch { /* best effort */ }
  }
  private keepLocal(id: string, settings: Record<string, unknown>) {
    const map = this.keptMap();
    map.delete(id); map.set(id, clone(settings));
    for (const key of [...map.keys()]) { if (map.size <= MAX_ENTRIES) break; map.delete(key); }
    this.writeKept(map);
  }
  private dropKept(id: string) {
    const map = this.keptMap();
    if (map.delete(id)) this.writeKept(map);
  }
  /** Delete the server copy (best effort), the local kept copy and the remote cache of an id. */
  private discardSettings(id: string, local = false) {
    this.dropKept(id); delete this.remote[id];
    const connection = this.adapter?.connection?.() ?? null;
    if (connection && !this.localSettings() && !local) void within(SYNC_PUT_MS, signal => new Api(connection).deleteExtension(id, signal)).catch(() => {});
  }
  find(id: string) { const e = this.installed.find(e => e.package.manifest.id === id); if (!e) throw new LocalizedError(t("확장을 찾을 수 없습니다")); return e; }
  /**
   * True when `next` may replace the running same-id extension without asking for consent again:
   * the installed one is enabled, safe mode is off, and `next` requests no permission the installed version lacks.
   * Call this BEFORE `install`, which always drops activation.
   */
  canResume(next: ExtensionPackage): boolean {
    const old = this.installed.find(e => e.package.manifest.id === next.manifest.id);
    if (!old || !old.enabled || this.safeMode) return false;
    return next.manifest.permissions.every(p => old.package.manifest.permissions.includes(p));
  }
  install(input: unknown, scope: ExtensionScope = "server") {
    const pkg = parsePackage(input);
    const id = pkg.manifest.id;
    const old = this.installed.find(e => e.package.manifest.id === id);
    // Every replacement loses activation consent, including code-only changes. Other extensions are never touched.
    const fields = pkg.manifest.settings;
    if (old) {
      this.disable(id); old.package = pkg; old.error = undefined;
      if (fields) old.settings = fillSettingDefaults(fields, old.settings);
    } else {
      const takeover = this.unreadable.findIndex(u => u.id === id);
      if (takeover < 0 && this.installed.length + this.unreadable.length >= MAX_ENTRIES) throw new LocalizedError(t("확장은 최대 50개까지 설치할 수 있습니다"));
      // A reinstalled id gets back what it had: the unreadable entry's own settings, else the server's, else the kept copy.
      const rawEntry = takeover >= 0 ? plain(this.unreadable[takeover]!.raw) : undefined;
      const stored = plain(rawEntry?.settings);
      const remote = scope === "server" && pkg.manifest.settingsScope !== "local" && !this.localSettings() && Object.hasOwn(this.remote, id) ? plain(this.remote[id]) : undefined;
      const kept = this.keptMap().get(id);
      const known = (stored && Object.keys(stored).length ? stored : undefined) ?? remote ?? kept;
      const fromLocalOnly = known !== undefined && known !== remote;
      const base: Record<string, unknown> = known ? clone(known) : {};
      const configured = !fields || (takeover >= 0 ? rawEntry?.configured !== false : known !== undefined);
      if (takeover >= 0) this.unreadable = this.unreadable.filter((_, i) => i !== takeover);
      this.installed.push({ package: pkg, scope, enabled: false, state: "disabled", configured, settings: fields ? fillSettingDefaults(fields, base) : base });
      this.dropKept(id);
      if (fromLocalOnly && Object.keys(base).length) void this.push(id); // the server does not have these yet
    }
    this.save();
    return id;
  }
  async enable(id: string) {
    if (!this.adapter) throw new LocalizedError(t("확장 호스트가 준비되지 않았습니다"));
    if (this.safeMode) throw new LocalizedError(t("안전 모드를 먼저 해제하세요"));
    this.find(id);
    if (this.configRequired(id)) throw new LocalizedError(t(CONFIG_REQUIRED));
    const problem = this.settingsProblem(id);
    if (problem) throw new Error(problem);
    // Only this id is marked while it starts; a page reload in the middle disables just this extension.
    this.markBooting(id);
    try { await this.start(id); } finally { this.unmarkBooting(id); }
    this.choose(id, true);
  }
  private async start(id: string) {
    const entry = this.find(id);
    this.cleanup(id);
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    entry.enabled = true; entry.state = "starting"; entry.error = undefined;
    const pkg = entry.package;
    const current = () => this.generations.get(id) === generation && entry.enabled;
    try {
      this.installLocales(id, pkg);
      for (const c of pkg.commands ?? []) this.registerCommand(id, c.name, c.description, "[input]", async arg => { if (!current()) throw new LocalizedError(t("비활성화된 확장입니다")); this.adapter!.prefill(c.template.split("{{args}}").join(arg)); });
      if (pkg.code) {
        const runtime: ExtensionRuntime = new ExtensionRuntime({
          request: (method, args) => { if (!current()) throw new LocalizedError(t("비활성화된 확장입니다")); return this.request(id, method, args, runtime); },
          failed: error => { if (current()) this.failure(id, error); },
        });
        this.runtimes.set(id, runtime);
        await runtime.start(pkg);
      }
      if (!current()) return;
      entry.state = "active";
      const openId = this.pendingPanelOpens.get(id);
      this.pendingPanelOpens.delete(id);
      if (openId && !this.panelOpen && this.panels.some(p => p.owner === id && p.id === openId)) {
        this.activePanel = `${id}:${openId}`; this.panelOpen = true;
      }
      this.applyThemes(); this.save(); this.log(id, t("활성화됨"));
    } catch (e) {
      if (current()) this.failure(id, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
  private failure(id: string, error: string) {
    this.revokeNotifications(id);
    const entry = this.find(id);
    entry.enabled = false; entry.state = "error"; entry.error = error.slice(0, 500);
    this.cleanup(id); this.applyThemes();
    try { this.save(); } catch { /* still tear down on persistence failure */ }
    this.log(id, error); this.adapter?.notify(t("확장 중지: {name} · {error}", { name: entry.package.manifest.name, error: error.slice(0, 120) }));
  }
  /**
   * Language packs of an extension: usable at once on this device, and published to the server so every other client
   * gets them too. Publishing is best effort (offline, or a server from before language packs) and never blocks start.
   */
  private installLocales(id: string, pkg: ExtensionPackage) {
    if (!pkg.locales?.length || !pkg.manifest.permissions.includes("locales")) return;
    for (const pack of pkg.locales) addLocalPack(id, pack);
    const connection = this.adapter?.connection?.() ?? null;
    if (!connection) return;
    const api = new Api(connection);
    for (const pack of pkg.locales) {
      void within(SYNC_PUT_MS, signal => api.saveLocale(pack.tag, { name: pack.name, messages: pack.messages, owner: id }, signal))
        .catch(() => this.log(id, t("언어팩 {tag}을(를) 서버에 올리지 못했습니다", { tag: pack.tag })));
    }
  }
  private cleanup(id: string) {
    removeLocalPacks(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.runtimes.get(id)?.stop(); this.runtimes.delete(id);
    this.httpReader.cleanup(id);
    this.configurations.get(id)?.cleanup(); this.configurations.delete(id);
    this.transport.cleanup(id);
    this.navbar = this.navbar.filter(item => item.owner !== id);
    this.pendingPanelOpens.delete(id);
    this.subscribed.delete(id); this.notificationTimes.delete(id);
    this.serverSubscribed.delete(id); this.sessionCalls.delete(id); this.paneCalls.delete(id);
    this.shortcuts = this.shortcuts.filter(s => s.owner !== id);
    this.toolRenderers = this.toolRenderers.filter(r => r.owner !== id);
    this.slots = this.slots.filter(s => s.owner !== id);
    this.messageRenderers = this.messageRenderers.filter(r => r.owner !== id);
    this.composerFilters.delete(id);
    this.labelSets = this.labelSets.filter(x => x.owner !== id);
    this.mentionSets = this.mentionSets.filter(x => x.owner !== id);
    this.senderRules = this.senderRules.filter(x => x.owner !== id);
    this.commands = this.commands.filter(c => c.owner !== id);
    this.actions = this.actions.filter(c => c.owner !== id);
    this.statuses = this.statuses.filter(c => c.owner !== id);
    this.panels = this.panels.filter(p => p.owner !== id);
    if (this.activePanel?.startsWith(id + ":")) { this.activePanel = null; this.panelOpen = false; }
  }
  private revokeNotifications(id: string) {
    if (!this.find(id).package.manifest.permissions.includes("system-notifications")) return;
    void this.adapter?.systemNotifications?.revoke(id).catch(() => this.adapter?.notify(t("서버 알림 규칙을 해제하지 못했습니다. 서버에 연결한 뒤 다시 비활성화해 주세요.")));
  }
  disable(id: string) {
    this.revokeNotifications(id);
    const e = this.find(id); e.enabled = false; e.state = "disabled"; e.error = undefined;
    this.cleanup(id); this.applyThemes(); this.save();
    this.choose(id, false);
  }
  /** Removes the package, its private storage and stops it. `keepSettings` decides what happens to the settings. */
  remove(id: string, opts: { keepSettings: boolean }) {
    const keep = opts?.keepSettings !== false;
    const removed = this.find(id);
    const settings = removed.settings;
    this.unpublishLocales(removed.package);
    this.disable(id); this.installed = this.installed.filter(e => e.package.manifest.id !== id);
    if (Object.hasOwn(this.wanted, id)) { delete this.wanted[id]; if (!this.applyingRemote) this.adapter?.statesChanged?.(); }
    localStorage.removeItem(STORE + id); localStorage.removeItem(CONFIGURATION_GRANT + id); this.save();
    if (keep) {
      // Offline fallback; an unsynced local value is newer than the cached server copy.
      if (this.unsynced.has(id)) delete this.remote[id];
      if (removed.configured) this.keepLocal(id, settings);
    } else this.discardSettings(id, !this.sharesSettings(removed));
    this.unsynced.delete(id); this.touched.delete(id);
  }
  /** Removing an extension takes down the language packs it published (only its own; best effort). */
  private unpublishLocales(pkg: ExtensionPackage) {
    const connection = this.adapter?.connection?.() ?? null;
    if (!connection || !pkg.locales?.length) return;
    const api = new Api(connection);
    for (const pack of pkg.locales) void within(SYNC_PUT_MS, signal => api.deleteLocale(pack.tag, pkg.manifest.id, signal)).catch(() => {});
  }
  /** Deletes a stored entry this version cannot read (see `unreadable`). */
  removeUnreadable(index: number, opts: { keepSettings: boolean }) {
    const item = this.unreadable[index];
    if (!item) throw new LocalizedError(t("확장을 찾을 수 없습니다"));
    const settings = plain(plain(item.raw)?.settings);
    this.unreadable = this.unreadable.filter((_, i) => i !== index);
    this.save();
    const id = item.id;
    if (!id || this.installed.some(e => e.package.manifest.id === id)) return;
    try { localStorage.removeItem(STORE + id); localStorage.removeItem(CONFIGURATION_GRANT + id); } catch { /* ignore */ }
    if (opts?.keepSettings !== false) { if (settings && Object.keys(settings).length) this.keepLocal(id, settings); }
    else this.discardSettings(id);
  }
  setSafeMode(on: boolean) {
    // Persist the recovery switch before doing anything else.
    localStorage.setItem(SAFE, on ? "1" : "0"); this.safeMode = on;
    for (const e of this.installed) {
      this.revokeNotifications(e.package.manifest.id);
      this.cleanup(e.package.manifest.id); e.state = "disabled"; e.enabled = false;
    }
    this.applyThemes(); this.save();
    // Leaving safe mode intentionally requires explicit reactivation, even after restart.
  }
  stop() {
    // A deliberate teardown (e.g. HMR) is not a crash: do not leave in-flight start markers behind.
    this.booting.clear(); this.writeBooting([]);
    for (const e of this.installed) this.cleanup(e.package.manifest.id);
  }
  /** Validates and stores settings locally at once, then mirrors them to the server (never rejects). */
  setSettings(id: string, input: unknown): Promise<void> {
    const settings = object(input);
    if (JSON.stringify(settings).length > 16000) throw new LocalizedError(t("설정은 최대 16KB입니다"));
    const entry = this.find(id);
    let next: Record<string, unknown> = clone(settings);
    const fields = entry.package.manifest.settings;
    if (fields) {
      const { values, errors, ok } = resolveSettings(fields, next);
      if (!ok) throw new LocalizedError(t("설정이 올바르지 않습니다 — {detail}", { detail: describeSettingErrors(fields, errors) }));
      next = { ...values };
    }
    entry.settings = next; entry.configured = true; this.save();
    this.touched.add(id);
    // A successful save also retries earlier saves that never reached the server.
    const pending = [id, ...[...this.unsynced].filter(other => other !== id && this.installed.some(e => e.package.manifest.id === other))];
    return Promise.all(pending.map(other => this.push(other))).then(() => {});
  }
  applyThemes() {
    if (typeof document === "undefined") return;
    for (const key of this.themes) document.documentElement.style.removeProperty(key);
    this.themes.clear();
    if (this.safeMode) return;
    for (const e of this.installed) if (e.state === "active") {
      const tokens = this.adapter?.dark() ? e.package.theme?.dark : e.package.theme?.light;
      for (const [key, value] of Object.entries(tokens ?? {})) { document.documentElement.style.setProperty(key, value); this.themes.add(key); }
    }
  }
  log(owner: string, text: string) { this.logs = [...this.logs.slice(-99), { owner, text: text.slice(0, 1000), at: Date.now() }]; }
  private require(id: string, permission: Permission) {
    if (!this.find(id).package.manifest.permissions.includes(permission)) throw new LocalizedError(t("권한 없음: {permission}", { permission }));
  }
  private registerCommand(owner: string, name: string, desc: string, args: string | undefined, run: (arg: string) => Promise<void>) {
    name = localId(name);
    if (this.adapter!.reservedCommands().includes(name) || this.commands.some(c => c.name === name)) throw new LocalizedError(t("명령 이름 충돌: /{name}", { name }));
    if (this.commands.filter(c => c.owner === owner).length >= 20) throw new LocalizedError(t("명령은 확장당 최대 20개입니다"));
    this.commands = [...this.commands, { owner, name, desc, args, run }];
  }
  openPanel(owner: string, id: string) {
    const panel = this.panels.find(p => p.owner === owner && p.id === id && p.placement !== "composer");
    if (!panel || this.find(owner).state !== "active") throw new LocalizedError(t("활성 패널을 찾을 수 없습니다"));
    this.activePanel = `${owner}:${id}`; this.panelOpen = true;
  }
  closePanel() { this.panelOpen = false; }
  /** The four operations of a configuration transfer. `id` is the extension asking (left out of it); "" for the user. */
  private configIO(id: string): {
    capture(): ConfigurationDocument; backup(): unknown; apply(document: ConfigurationDocument): void; restore(value: unknown): void;
  } {
    const adapter = this.adapter?.configuration;
    if (!adapter) throw new LocalizedError(t("이 클라이언트는 설정 내보내기를 지원하지 않습니다"));
    return {
      capture: () => ({ schemaVersion: 1 as const, ...withoutKeybindings(adapter.capture(), id !== ""), extensions: this.installed.filter(e => e.package.manifest.id !== id).map(e => ({ package: clone(e.package), enabled: e.enabled, settings: publicSettings(e.settings, e.package.manifest.settings ?? []) })) }),
      backup: () => ({ app: adapter.backup(), entries: clone(this.installed.filter(e => e.package.manifest.id !== id).map(e => ({ package: e.package, scope: e.scope, enabled: e.enabled, settings: e.settings, configured: e.configured }))), unreadable: clone(this.unreadable), localSettings: this.localSettings() }),
      apply: document => {
        const newCount = document.extensions.filter(e => !this.installed.some(old => old.package.manifest.id === e.package.manifest.id) && !this.unreadable.some(old => old.id === e.package.manifest.id)).length;
        if (this.installed.length + this.unreadable.length + newCount > MAX_ENTRIES) throw new LocalizedError(t("확장 최대 50개 한도를 초과합니다"));
        localStorage.setItem(SETTINGS_SOURCE, "local");
        for (const entry of document.extensions) {
          // A file carries this device's extensions, so they come back as device extensions. One that already exists
          // keeps the place it has (replacing a server extension from a file must not move it off the server).
          const target = this.install(entry.package, this.installed.find(e => e.package.manifest.id === entry.package.manifest.id)?.scope ?? "device");
          const installed = this.find(target);
          // Preserve local secrets / schema-less values. Only public settings are replaced.
          installed.settings = { ...installed.settings, ...clone(entry.settings) };
          installed.configured = false;
          this.touched.add(target);
        }
        this.save(); adapter.apply(document);
        this.syncNotice = msg("가져온 로컬 설정을 사용합니다");
      },
      restore: value => {
        const raw = object(value);
        if (!Array.isArray(raw.entries) || !Array.isArray(raw.unreadable)) throw new LocalizedError(t("잘못된 로컬 백업"));
        const entries = raw.entries.map(item => { const e = object(item); return { package: parsePackage(e.package), scope: (e.scope === "device" ? "device" : "server") as ExtensionScope, enabled: false, state: "disabled" as const, settings: clone(object(e.settings)), configured: e.configured !== false }; });
        const kept = this.installed.filter(e => e.package.manifest.id === id);
        if (entries.some(e => e.package.manifest.id === id) || entries.length + raw.unreadable.length + kept.length > MAX_ENTRIES) throw new LocalizedError(t("잘못된 로컬 백업"));
        for (const e of this.installed) if (e.package.manifest.id !== id) this.cleanup(e.package.manifest.id);
        this.installed = [...this.installed.filter(e => e.package.manifest.id === id), ...entries];
        this.unreadable = clone(raw.unreadable) as UnreadableExtension[];
        localStorage.setItem(SETTINGS_SOURCE, raw.localSettings === true ? "local" : "server");
        this.save(); this.applyThemes(); adapter.restore(raw.app);
      },
    };
  }
  private configuration(id: string): ConfigurationManager {
    const existing = this.configurations.get(id);
    if (existing) return existing;
    const adapter = this.adapter?.configuration;
    if (!adapter) throw new LocalizedError(t("이 클라이언트는 설정 내보내기를 지원하지 않습니다"));
    const approvalKey = () => this.grantKey(id);
    let approvedKey = "";
    const client = new ConfigurationManager({
      ...this.configIO(id),
      authorize: () => { if (approvedKey !== approvalKey()) throw new LocalizedError(t("설정이 변경되어 다시 승인이 필요합니다")); localStorage.setItem(CONFIGURATION_GRANT + id, approvedKey); },
      confirm: async message => {
        approvedKey = approvalKey();
        const approved = await adapter.confirm(`[${this.find(id).package.manifest.name}]\n${message}`);
        if (this.configurations.get(id) !== client || !this.find(id).enabled) return false;
        return approved;
      },
    });
    this.configurations.set(id, client); return client;
  }
  private grantKey(id: string): string { return sha256(canonical({ package: this.find(id).package, settings: this.effectiveSettings(id) })); }
  private granted(id: string): boolean { return localStorage.getItem(CONFIGURATION_GRANT + id) === this.grantKey(id); }
  private requireGrant(id: string) { this.require(id, "configuration-background"); if (!this.granted(id)) throw new LocalizedError(t("자동 설정 접근 승인이 필요합니다")); }
  /** Settings-only background apply; new code/activation always needs explicit consent. */
  private applyBackground(id: string, input: unknown, expected: unknown) {
    this.requireGrant(id);
    const document = parseConfiguration(input, id), io = this.configIO(id), before = parseConfiguration(io.capture(), id);
    if (typeof expected !== "string" || configurationFingerprint(before) !== expected) throw new LocalizedError(t("로컬 설정 충돌: 다시 읽으세요"));
    const packages = (doc: ConfigurationDocument) => canonical(doc.extensions.map(e => ({ package: e.package, enabled: e.enabled })).sort((a,b) => a.package.manifest.id.localeCompare(b.package.manifest.id)));
    if (packages(document) !== packages(before)) throw new LocalizedError(t("확장 코드·설치·활성 상태 변경은 수동 가져오기로 승인해야 합니다"));
    applyWithBackup({ ...io, apply: doc => {
      localStorage.setItem(SETTINGS_SOURCE, "local");
      for (const entry of doc.extensions) {
        const installed = this.find(entry.package.manifest.id);
        if (canonical(publicSettings(installed.settings, installed.package.manifest.settings ?? [])) !== canonical(entry.settings)) {
          const settings = { ...installed.settings };
          for (const key of Object.keys(publicSettings(settings, installed.package.manifest.settings ?? []))) delete settings[key];
          installed.settings = { ...settings, ...clone(entry.settings) }; this.touched.add(installed.package.manifest.id);
        }
      }
      this.save(); const app = this.adapter!.configuration!; (app.applyBackground ?? app.apply)(doc);
    } }, document);
    const applied = parseConfiguration(io.capture(), id), fingerprint = configurationFingerprint(applied);
    for (const e of applied.extensions) {
      const old = before.extensions.find(b => b.package.manifest.id === e.package.manifest.id)!;
      if (e.enabled && canonical(old.settings) !== canonical(e.settings)) void this.start(e.package.manifest.id).catch(() => {});
    }
    return { document: applied, fingerprint };
  }
  /* ---------- settings transfer driven by the user (the same engine as the SDK, with no extension in between) ---------- */

  /** The settings as a document, limited to the parts the user ticked. */
  exportConfiguration(parts: { servers: boolean; extensions: boolean; preferences: boolean; keybindings?: boolean }): ConfigurationDocument {
    const doc = this.configIO("").capture();
    // Only what belongs to this device goes into the file. Server extensions are the server's: a device that connects
    // to that server gets them from it, so they are left out here.
    const device = new Set(this.installed.filter(e => e.scope === "device").map(e => e.package.manifest.id));
    const { keybindings, ...rest } = doc;
    return parseConfiguration({
      ...rest,
      servers: parts.servers ? doc.servers : [],
      extensions: parts.extensions ? doc.extensions.filter(e => device.has(e.package.manifest.id)) : [],
      preferences: parts.preferences ? doc.preferences : {},
      ...(parts.keybindings !== false && keybindings ? { keybindings } : {}),
    });
  }
  /** What importing `doc` would change, without changing anything. */
  planImport(doc: ConfigurationDocument): ConfigurationPlan {
    const app = this.adapter?.configuration?.capture();
    if (!app) throw new LocalizedError(t("이 클라이언트는 설정 가져오기를 지원하지 않습니다"));
    return planConfiguration(doc, {
      servers: app.servers.map(s => ({ name: s.name, baseUrl: normalizeUrl(s.baseUrl) })),
      extensions: this.installed.map(e => ({ id: e.package.manifest.id, name: e.package.manifest.name, version: e.package.manifest.version })),
      unreadable: this.unreadable,
      preferences: app.preferences,
      keybindings: app.keybindings,
    });
  }
  /** Back up, then apply. Extensions come in disabled; a failure puts everything back. */
  importConfiguration(doc: ConfigurationDocument) { applyWithBackup(this.configIO(""), parseConfiguration(doc)); }
  /** Back to the state saved before the last import. */
  restoreConfiguration() { restoreBackup(this.configIO("")); }

  private request(id: string, method: string, args: unknown[], runtime: ExtensionRuntime): unknown {
    const execute = (token: string, arg = ""): Promise<unknown> => runtime.execute(token, arg);
    switch (method) {
      case "configuration.authorize": {
        this.require(id, "configuration-background"); if (args.length) throw new LocalizedError(t("인자를 받지 않습니다"));
        return this.configuration(id).start("authorize", id);
      }
      case "configuration.revoke": {
        this.require(id, "configuration-background"); if (args.length) throw new LocalizedError(t("인자를 받지 않습니다"));
        localStorage.removeItem(CONFIGURATION_GRANT + id); this.configurations.get(id)?.cleanup(); return;
      }
      case "configuration.access": {
        this.require(id, "configuration-background"); if (args.length) throw new LocalizedError(t("인자를 받지 않습니다")); return { authorized: this.granted(id) };
      }
      case "configuration.read": {
        this.requireGrant(id); if (args.length) throw new LocalizedError(t("인자를 받지 않습니다"));
        const document = parseConfiguration(this.configIO(id).capture(), id); return { document, fingerprint: configurationFingerprint(document) };
      }
      case "configuration.applyBackground": {
        this.requireGrant(id); if (args.length !== 2) throw new LocalizedError(t("document와 fingerprint가 필요합니다")); return this.applyBackground(id, args[0], args[1]);
      }
      case "configuration.export":
      case "configuration.apply":
      case "configuration.restore":
      case "configuration.status": {
        this.require(id, "configuration");
        if (args.length !== (method === "configuration.apply" ? 1 : 0)) throw new LocalizedError(t("잘못된 configuration 인자"));
        const manager = this.configuration(id);
        if (method === "configuration.status") return manager.status();
        return manager.start(method === "configuration.export" ? "export" : method === "configuration.apply" ? "apply" : "restore", id, args[0]);
      }
      case "http.requestJson": {
        this.require(id, "http-write");
        if (args.length !== 1) throw new LocalizedError(t("requestJson은 요청 객체 하나가 필요합니다"));
        const generation = this.generations.get(id);
        return this.transport.request(id, this.effectiveSettings(id), args[0], () => this.generations.get(id) === generation && this.find(id).enabled);
      }
      case "ui.registerPanel": {
        this.require(id, "ui"); const spec = parsePanelSpec(args[0]); const token = string(args[1], 40);
        if (this.panels.some(p => p.owner === id && p.id === spec.id)) throw new LocalizedError(t("중복 패널 ID"));
        if (this.panels.filter(p => p.owner === id).length >= 5) throw new LocalizedError(t("확장당 패널은 최대 5개입니다"));
        const generation = this.generations.get(id);
        const panel: ExtensionPanel = { ...spec, owner: id, revision: 0, run: async event => {
          const current = this.panels.find(p => p.owner === id && p.id === spec.id);
          if (this.generations.get(id) !== generation || !current || current.run !== panel.run || this.find(id).state !== "active") throw new LocalizedError(t("비활성화된 패널입니다"));
          await runtime.execute(token, validateUIEvent(current.view, event));
        } };
        this.panels = [...this.panels, panel]; return;
      }
      case "ui.update": {
        this.require(id, "ui"); const panelId = localId(args[0]); const view = parseView(args[1]);
        const opts = args[2] === undefined ? {} : object(args[2]);
        if (opts.tone !== undefined && !["neutral", "info", "success", "warning", "danger"].includes(opts.tone as string)) throw new LocalizedError(t("잘못된 tone"));
        const tone = opts.tone as UITone | undefined;
        const index = this.panels.findIndex(p => p.owner === id && p.id === panelId);
        if (index < 0) throw new LocalizedError(t("패널을 찾을 수 없습니다"));
        this.panels = this.panels.map((p, i) => i === index ? { ...p, view, tone, revision: p.revision + 1 } : p); return;
      }
      case "ui.open": {
        this.require(id, "ui"); const panelId = localId(args[0]);
        const panel = this.panels.find(p => p.owner === id && p.id === panelId);
        if (!panel || panel.placement === "composer") throw new LocalizedError(t("별도 패널을 찾을 수 없습니다"));
        // Do not destroy another active panel's draft during asynchronous boot.
        if (this.find(id).state === "starting" && this.panelOpen) {
          this.pendingPanelOpens.set(id, panelId); return;
        }
        this.activePanel = `${id}:${panelId}`; this.panelOpen = true; return;
      }
      case "ui.close": {
        this.require(id, "ui"); const panelId = localId(args[0]);
        if (!this.panels.some(p => p.owner === id && p.id === panelId)) throw new LocalizedError(t("패널을 찾을 수 없습니다"));
        if (this.pendingPanelOpens.get(id) === panelId) this.pendingPanelOpens.delete(id);
        if (this.activePanel === `${id}:${panelId}`) this.panelOpen = false; return;
      }
      case "ui.remove": {
        this.require(id, "ui"); const panelId = localId(args[0]);
        this.panels = this.panels.filter(p => p.owner !== id || p.id !== panelId);
        if (this.pendingPanelOpens.get(id) === panelId) this.pendingPanelOpens.delete(id);
        if (this.activePanel === `${id}:${panelId}`) { this.activePanel = null; this.panelOpen = false; } return;
      }
      case "commands.register": {
        this.require(id, "commands"); const s = object(args[0]); const token = string(args[1], 40);
        this.registerCommand(id, localId(s.name), string(s.description, 200), s.args === undefined ? undefined : string(s.args, 80), arg => execute(token, arg).then(() => {})); return;
      }
      case "composer.registerAction": {
        this.require(id, "composer"); const s = object(args[0]); const token = string(args[1], 40); const actionId = localId(s.id);
        if (this.actions.filter(a => a.owner === id).length >= 10 || this.actions.some(a => a.owner === id && a.id === actionId)) throw new LocalizedError(t("입력창 액션 제한 또는 중복 ID"));
        this.actions = [...this.actions, { owner: id, id: actionId, label: string(s.label, 40), run: () => execute(token).then(() => {}) }]; return;
      }
      case "composer.setText": this.require(id, "composer"); this.adapter!.prefill(string(args[0], 16000)); return;
      case "navbar.set": {
        this.require(id, "navbar");
        if (args.length !== 2) throw new LocalizedError(t("navbar.set은 ID와 spec 두 인자가 필요합니다"));
        const itemId = navbarId(args[0]); const spec = parseNavbarItem(args[1]);
        const mine = this.navbar.filter(item => item.owner === id);
        if (!mine.some(item => item.id === itemId) && mine.length >= NAVBAR_LIMITS.items) throw new LocalizedError(t("navbar 항목은 확장당 최대 {n}개입니다", { n: NAVBAR_LIMITS.items }));
        const next: NavbarItem = { owner: id, id: itemId, ...spec };
        this.navbar = mine.some(item => item.id === itemId)
          ? this.navbar.map(item => item.owner === id && item.id === itemId ? next : item)
          : [...this.navbar, next];
        return;
      }
      case "navbar.remove": {
        this.require(id, "navbar");
        if (args.length !== 1) throw new LocalizedError(t("navbar.remove는 ID 한 개가 필요합니다"));
        const itemId = navbarId(args[0]);
        this.navbar = this.navbar.filter(item => item.owner !== id || item.id !== itemId); return;
      }
      case "http.getJson": {
        this.require(id, "http");
        if (args.length !== 1) throw new LocalizedError(t("http.getJson은 경로 한 개가 필요합니다"));
        const generation = this.generations.get(id);
        return this.httpReader.getJson(id, this.effectiveSettings(id).httpOrigin, args[0],
          () => this.generations.get(id) === generation && this.find(id).enabled);
      }
      case "status.set": {
        this.require(id, "status"); const itemId = localId(args[0]); const text = string(args[1], 120);
        const existing = this.statuses.find(s => s.owner === id && s.id === itemId);
        if (existing) existing.text = text;
        else { if (this.statuses.filter(s => s.owner === id).length >= 10) throw new LocalizedError(t("상태 항목은 최대 10개입니다")); this.statuses.push({ owner: id, id: itemId, text }); } return;
      }
      case "status.remove": this.require(id, "status"); this.statuses = this.statuses.filter(s => s.owner !== id || s.id !== localId(args[0])); return;
      case "context.get": {
        this.require(id, "context");
        const c = this.adapter!.context();
        return { sessionId: c.sessionId, model: c.model, provider: c.provider, running: c.running, online: c.online };
      }
      case "events.subscribe": this.require(id, "events"); this.subscribed.add(id); return;
      case "server.subscribe": this.require(id, "server"); this.serverSubscribed.add(id); return;
      case "server.call": {
        this.require(id, "server");
        const connection = this.adapter?.connection?.() ?? null;
        if (!connection) throw new LocalizedError(t("서버에 연결해 주세요"));
        const extension = string(args[0], 80), method = string(args[1], 80);
        if (!/^[A-Za-z0-9_./-]+$/.test(extension) || !/^[A-Za-z0-9_-]+$/.test(method)) throw new LocalizedError(t("잘못된 서버 확장 이름"));
        const sessionId = args[3] === null || args[3] === undefined ? null : string(args[3], 80);
        const generation = this.generations.get(id);
        return within(15000, async signal => {
          const result = await new Api(connection).callServerExtension(extension, method, args[2] ?? null, sessionId, signal);
          if (this.generations.get(id) !== generation) throw new LocalizedError(t("비활성화된 확장입니다"));
          return result;
        });
      }
      case "server.entries": {
        this.require(id, "server");
        const connection = this.adapter?.connection?.() ?? null;
        if (!connection) throw new LocalizedError(t("서버에 연결해 주세요"));
        const o = args[0] === undefined ? {} : object(args[0]);
        const sessionId = typeof o.sessionId === "string" ? o.sessionId : this.adapter!.context().sessionId;
        if (!sessionId) throw new LocalizedError(t("열려 있는 대화가 없습니다"));
        return within(15000, signal => new Api(connection).serverExtensionEntries(sessionId, typeof o.extension === "string" ? o.extension : undefined, typeof o.type === "string" ? o.type : undefined, signal));
      }
      case "server.list": {
        this.require(id, "server");
        const connection = this.adapter?.connection?.() ?? null;
        if (!connection) throw new LocalizedError(t("서버에 연결해 주세요"));
        return within(15000, signal => new Api(connection).serverExtensions(signal));
      }
      case "shortcuts.register": {
        this.require(id, "shortcuts"); const s = object(args[0]); const token = string(args[1], 40); const shortcutId = localId(s.id);
        const combo = string(s.combo, 40, "combo");
        const { mods, keys } = splitCombo(combo);
        if ((!mods.includes("Mod") && !mods.includes("Alt")) || keys.length !== 1) throw new LocalizedError(t("단축키는 Ctrl/⌘ 또는 Alt와 키 하나로 구성해야 합니다 (예: Mod+Shift+K)"));
        if (this.shortcuts.filter(x => x.owner === id).length >= 10 || this.shortcuts.some(x => x.owner === id && x.id === shortcutId)) throw new LocalizedError(t("단축키 제한 또는 중복 ID"));
        if (this.shortcuts.some(x => x.combo === combo)) throw new LocalizedError(t("이미 다른 확장이 쓰는 단축키입니다: {combo}", { combo }));
        this.shortcuts = [...this.shortcuts, { owner: id, id: shortcutId, label: string(s.label, 60), combo, run: () => execute(token).then(() => {}) }]; return;
      }
      case "shortcuts.remove": this.require(id, "shortcuts"); this.shortcuts = this.shortcuts.filter(x => x.owner !== id || x.id !== localId(args[0])); return;
      case "dialog.confirm":
      case "dialog.select":
      case "dialog.input": {
        this.require(id, "dialogs");
        const ask = this.adapter?.dialog;
        if (!ask) throw new LocalizedError(t("이 클라이언트는 대화상자를 지원하지 않습니다"));
        const s = object(args[0]); const kind = method.slice("dialog.".length) as "confirm" | "select" | "input";
        const base = { owner: id, ownerName: this.find(id).package.manifest.name, title: string(s.title, 120), ...(s.message === undefined ? {} : { message: string(s.message, 2000) }) };
        let request: ExtensionDialogRequest;
        if (kind === "confirm") request = { ...base, kind, ...(s.confirmLabel === undefined ? {} : { confirmLabel: string(s.confirmLabel, 40) }) };
        else if (kind === "select") {
          if (!Array.isArray(s.options) || !s.options.length || s.options.length > 50) throw new LocalizedError(t("선택지는 1~50개여야 합니다"));
          request = { ...base, kind, options: s.options.map(o => { const x = object(o); return { value: string(x.value, 200), label: string(x.label, 120), ...(x.description === undefined ? {} : { description: string(x.description, 300) }) }; }) };
        } else request = { ...base, kind, ...(s.placeholder === undefined ? {} : { placeholder: string(s.placeholder, 120) }), ...(s.value === undefined ? {} : { value: string(s.value, 4000) }), multiline: s.multiline === true };
        const generation = this.generations.get(id);
        return ask(request).then(v => this.generations.get(id) === generation ? v : (kind === "confirm" ? false : null));
      }
      case "session.send": {
        this.require(id, "session");
        const adapter = this.adapter?.session;
        if (!adapter) throw new LocalizedError(t("이 클라이언트는 대화 제어를 지원하지 않습니다"));
        const mode = args[1] === "steer" || args[1] === "follow_up" ? args[1] : "prompt";
        this.limitSession(id);
        return adapter.send(string(args[0], 16000), mode);
      }
      case "session.abort": {
        this.require(id, "session");
        const adapter = this.adapter?.session;
        if (!adapter) throw new LocalizedError(t("이 클라이언트는 대화 제어를 지원하지 않습니다"));
        this.limitSession(id);
        return adapter.abort();
      }
      case "panes.list": case "panes.group": case "panes.read": case "panes.focus": case "panes.send": case "panes.abort": case "panes.split":
      case "panes.models": case "panes.configure": case "panes.compact": case "panes.move": case "panes.swap": case "panes.resize": case "panes.leave": case "panes.close": case "panes.zoom": {
        this.require(id, "panes");
        const panes = this.adapter?.panes;
        if (!panes) throw new LocalizedError(t("이 클라이언트는 패널 제어를 지원하지 않습니다"));
        const pid = (v: unknown) => string(v, 80, "pane id");
        const edge = (v: unknown): Edge => { if (v === "left" || v === "right" || v === "top" || v === "bottom") return v; throw new LocalizedError(t("방향은 left, right, top, bottom 중 하나여야 합니다")); };
        const generation = this.generations.get(id);
        const alive = <T,>(v: T): T => { if (this.generations.get(id) !== generation) throw new LocalizedError(t("비활성화된 확장입니다")); return v; };
        if (method === "panes.list") return clone(panes.list());
        if (method === "panes.models") return clone(panes.models());
        if (method === "panes.group") return clone(panes.group());
        if (method === "panes.read") {
          const o = args[1] === undefined || args[1] === null ? {} : object(args[1]);
          const limit = o.limit === undefined ? 20 : Number(o.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new LocalizedError(t("limit은 1~100이어야 합니다"));
          return panes.read(pid(args[0]), limit).then(alive).then(clone);
        }
        this.limitPanes(id);
        switch (method) {
          case "panes.focus": return panes.focus(pid(args[0])).then(() => {});
          case "panes.send": {
            const mode = args[2] === undefined || args[2] === null ? "prompt" : args[2];
            if (mode !== "prompt" && mode !== "steer" && mode !== "follow_up") throw new LocalizedError(t("잘못된 전송 방식"));
            return panes.send(pid(args[0]), string(args[1], 16000), mode).then(() => {});
          }
          case "panes.configure": {
            const o = object(args[1]); const out: Record<string, string> = {};
            for (const key of Object.keys(o)) if (!["title", "provider", "model", "thinkingLevel"].includes(key)) throw new LocalizedError(t("알 수 없는 설정: {key}", { key }));
            if (o.title !== undefined) out.title = string(o.title, 200);
            if (o.provider !== undefined) out.provider = string(o.provider, 80);
            if (o.model !== undefined) out.model = string(o.model, 200);
            if (o.thinkingLevel !== undefined) { if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(o.thinkingLevel as string)) throw new LocalizedError(t("잘못된 추론 강도")); out.thinkingLevel = o.thinkingLevel as string; }
            if (!Object.keys(out).length) throw new LocalizedError(t("바꿀 설정이 없습니다"));
            return panes.configure(pid(args[0]), out).then(() => {});
          }
          case "panes.compact": return panes.compact(pid(args[0]), args[1] === undefined || args[1] === null ? undefined : string(args[1], 4000)).then(() => {});
          case "panes.abort": return panes.abort(pid(args[0])).then(() => {});
          case "panes.split": {
            const o = args[2] === undefined || args[2] === null ? {} : object(args[2]);
            if (o.kind !== undefined && o.kind !== "session" && o.kind !== "terminal") throw new LocalizedError(t("kind는 session 또는 terminal이어야 합니다"));
            return panes.split(pid(args[0]), edge(args[1]), o.kind === "terminal" ? "terminal" : "session", o.focus === true).then(alive).then(newId => ({ id: newId }));
          }
          case "panes.move": return panes.move(pid(args[0]), pid(args[1]), edge(args[2])).then(() => {});
          case "panes.swap": return panes.swap(pid(args[0]), pid(args[1])).then(() => {});
          case "panes.resize": {
            const ratio = Number(args[1]);
            if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) throw new LocalizedError(t("비율은 0.1~0.9여야 합니다"));
            return panes.resize(pid(args[0]), ratio).then(() => {});
          }
          case "panes.leave": return panes.leave(pid(args[0])).then(() => {});
          case "panes.close": return panes.close(pid(args[0])).then(() => {});
          default: return panes.zoom(args[0] === null || args[0] === undefined ? null : pid(args[0])).then(() => {});
        }
      }
      case "tools.registerRenderer": {
        this.require(id, "tools"); const toolName = string(args[0], 64); const token = string(args[1], 40);
        if (!/^[A-Za-z0-9_-]+$/.test(toolName)) throw new LocalizedError(t("잘못된 도구 이름"));
        if (this.toolRenderers.filter(r => r.owner === id).length >= 20) throw new LocalizedError(t("렌더러는 확장당 최대 20개입니다"));
        const generation = this.generations.get(id);
        this.toolRenderers = [...this.toolRenderers.filter(r => !(r.owner === id && r.toolName === toolName)), { owner: id, toolName, render: async input => {
          if (this.generations.get(id) !== generation || this.find(id).state !== "active") return null;
          const value = await runtime.execute(token, input);
          return value === null || value === undefined ? null : parseView(value, { maxNodes: 80, maxDepth: 5, maxBytes: 24 * 1024 });
        } }]; return;
      }
      case "messages.registerRenderer": {
        this.require(id, "messages"); const entryType = string(args[0], 64); const token = string(args[1], 40);
        if (!/^[A-Za-z0-9_-]+$/.test(entryType)) throw new LocalizedError(t("잘못된 기록 종류"));
        if (this.messageRenderers.filter(r => r.owner === id).length >= 20) throw new LocalizedError(t("렌더러는 확장당 최대 20개입니다"));
        const generation = this.generations.get(id);
        this.messageRenderers = [...this.messageRenderers.filter(r => !(r.owner === id && r.entryType === entryType)), { owner: id, entryType, render: async entry => {
          if (this.generations.get(id) !== generation || this.find(id).state !== "active") return null;
          const value = await runtime.execute(token, entry);
          return value === null || value === undefined ? null : parseView(value, { maxNodes: 80, maxDepth: 5, maxBytes: 24 * 1024, allowed: NAVBAR_NODE_TYPES });
        } }]; return;
      }
      case "messages.removeRenderer": this.require(id, "messages"); this.messageRenderers = this.messageRenderers.filter(r => r.owner !== id || r.entryType !== string(args[0], 64)); return;
      case "slots.set": {
        this.require(id, "slots");
        if (args.length !== 3) throw new LocalizedError(t("slots.set은 위치, ID, spec 세 인자가 필요합니다"));
        const slot = args[0] === "header" || args[0] === "footer" ? args[0] : null;
        if (!slot) throw new LocalizedError(t("슬롯은 header 또는 footer입니다"));
        const itemId = navbarId(args[1]); const spec = parseNavbarItem(args[2]);
        const mine = this.slots.filter(s => s.owner === id);
        const exists = mine.some(s => s.slot === slot && s.id === itemId);
        if (!exists && mine.length >= 2) throw new LocalizedError(t("슬롯 항목은 확장당 최대 2개입니다"));
        const next: SlotItem = { owner: id, id: itemId, slot, ...spec };
        this.slots = exists ? this.slots.map(s => s.owner === id && s.slot === slot && s.id === itemId ? next : s) : [...this.slots, next]; return;
      }
      case "slots.remove": {
        this.require(id, "slots");
        const slot = args[0], itemId = navbarId(args[1]);
        this.slots = this.slots.filter(s => s.owner !== id || s.slot !== slot || s.id !== itemId); return;
      }
      case "composerFilter.set": {
        this.require(id, "composer-filter"); const token = string(args[1], 40);
        const generation = this.generations.get(id);
        this.composerFilters.set(id, { owner: id, run: async text => {
          if (this.generations.get(id) !== generation || this.find(id).state !== "active") return null;
          const value = await Promise.race([runtime.execute(token, text), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))]);
          if (typeof value === "string") return value.slice(0, 64000);
          if (value && typeof value === "object") {
            const o = value as Record<string, unknown>;
            if (typeof o.text === "string") return { text: o.text.slice(0, 64000) };
            if (typeof o.cancel === "string") return { cancel: o.cancel.slice(0, 300) };
          }
          return null;
        } }); return;
      }
      case "sessionLabels.set": {
        this.require(id, "session-labels");
        const raw = args[0];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LocalizedError(t("라벨은 객체여야 합니다"));
        const entries = Object.entries(raw as Record<string, unknown>);
        if (entries.length > 1000) throw new LocalizedError(t("라벨은 최대 1000개입니다"));
        const labels: Record<string, SessionLabel> = Object.create(null);
        for (const [sid, v] of entries) {
          if (!v || typeof v !== "object") continue;
          const o = v as Record<string, unknown>;
          if (typeof o.text !== "string" || !o.text.trim()) continue;
          labels[sid.slice(0, 80)] = { text: o.text.slice(0, 40), ...(typeof o.title === "string" ? { title: o.title.slice(0, 200) } : {}) };
        }
        this.labelSets = [...this.labelSets.filter(x => x.owner !== id), { owner: id, labels }]; return;
      }
      case "mentions.set": {
        this.require(id, "composer-mentions");
        if (!Array.isArray(args[0])) throw new LocalizedError(t("멘션 목록은 배열이어야 합니다"));
        if (args[0].length > 500) throw new LocalizedError(t("멘션은 최대 500개입니다"));
        const items: MentionItem[] = [];
        for (const v of args[0] as unknown[]) {
          if (!v || typeof v !== "object") continue;
          const o = v as Record<string, unknown>;
          if (typeof o.insert !== "string" || !/^@[^\s@]{1,60}$/.test(o.insert)) continue;
          const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
          items.push({ insert: o.insert, desc: str(o.desc, 200), group: str(o.group, 20), keywords: str(o.keywords, 200), except: str(o.except, 80) });
        }
        this.mentionSets = [...this.mentionSets.filter(x => x.owner !== id), { owner: id, items }]; return;
      }
      case "messages.setSender": {
        this.require(id, "messages");
        const source = string(args[0], 400);
        let first: RegExp;
        try { first = new RegExp(source); } catch { throw new LocalizedError(t("잘못된 패턴")); }
        this.senderRules = [...this.senderRules.filter(x => x.owner !== id), { owner: id, first }]; return;
      }
      case "messages.clearSender": this.require(id, "messages"); this.senderRules = this.senderRules.filter(x => x.owner !== id); return;
      case "composerFilter.clear": this.require(id, "composer-filter"); this.composerFilters.delete(id); return;
      case "tools.removeRenderer": this.require(id, "tools"); this.toolRenderers = this.toolRenderers.filter(r => r.owner !== id || r.toolName !== string(args[0], 64)); return;
      case "notifications.send":
      case "notifications.status":
      case "notifications.register":
      case "notifications.remove": {
        this.require(id, "system-notifications");
        const adapter = this.adapter?.systemNotifications;
        if (!adapter) throw new LocalizedError(t("이 클라이언트는 시스템 알림을 지원하지 않습니다"));
        const count = method === "notifications.status" ? 0 : method === "notifications.register" ? 2 : 1;
        if (args.length !== count) throw new LocalizedError(t("잘못된 알림 인자"));
        if (method === "notifications.status") return adapter.status();
        if (method === "notifications.remove") return adapter.remove(id, localId(args[0]));
        if (method === "notifications.register") return adapter.register(id, localId(args[0]), parseNotificationRule(args[1]));
        const spec = parseNotification(args[0]);
        return adapter.send(id, { ...spec, title: `[${this.find(id).package.manifest.name}] ${spec.title}` });
      }
      case "notifications.show": {
        this.require(id, "notifications"); const text = string(args[0], 300);
        const recent = (this.notificationTimes.get(id) ?? []).filter(at => Date.now() - at < 10000);
        if (recent.length >= 5) throw new LocalizedError(t("확장 알림은 10초에 최대 5개입니다"));
        this.notificationTimes.set(id, [...recent, Date.now()]);
        this.adapter!.notify(`[${this.find(id).package.manifest.name}] ${text}`); return;
      }
      case "settings.get": return this.effectiveSettings(id);
      case "storage.get": { this.require(id, "storage"); const key = string(args[0], 80); const data = object(JSON.parse(localStorage.getItem(STORE + id) ?? "{}")); return Object.hasOwn(data, key) ? data[key] : null; }
      case "storage.set": {
        this.require(id, "storage"); const key = string(args[0], 80);
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new LocalizedError(t("사용할 수 없는 저장소 키"));
        const data = object(JSON.parse(localStorage.getItem(STORE + id) ?? "{}"));
        data[key] = args[1] ?? null; const json = JSON.stringify(data);
        if (json.length > 32000) throw new LocalizedError(t("확장 저장소는 최대 32KB입니다")); localStorage.setItem(STORE + id, json); return;
      }
      case "log": this.log(id, string(args[0], 1000)); return;
      default: throw new LocalizedError(t("지원하지 않는 SDK 메서드: {method}", { method }));
    }
  }
  private limitSession(id: string) {
    const recent = (this.sessionCalls.get(id) ?? []).filter(at => Date.now() - at < 10000);
    if (recent.length >= 5) throw new LocalizedError(t("대화 제어는 10초에 최대 5번입니다"));
    this.sessionCalls.set(id, [...recent, Date.now()]);
  }
  /** Pane control moves real UI and starts real work: 30 changes per 10 seconds per extension. */
  private limitPanes(id: string) {
    const recent = (this.paneCalls.get(id) ?? []).filter(at => Date.now() - at < 10000);
    if (recent.length >= 30) throw new LocalizedError(t("패널 제어는 10초에 최대 30번입니다"));
    this.paneCalls.set(id, [...recent, Date.now()]);
  }
  /** Hands an event from a server extension to every extension that subscribed with `sdk.server.on`. */
  emitServer(event: ServerExtensionEvent) {
    if (this.safeMode) return;
    for (const id of this.serverSubscribed) this.runtimes.get(id)?.serverEvent(event);
  }
  /** The shortcut an extension registered for this key combo, if any. Only active extensions count. */
  shortcutFor(combo: string): ExtensionShortcut | undefined {
    if (this.safeMode) return undefined;
    return this.shortcuts.find(s => s.combo === combo && this.installed.some(e => e.package.manifest.id === s.owner && e.state === "active"));
  }
  /**
   * Runs the active extensions' composer filters in install order on a message about to be sent. A filter that fails or
   * times out is skipped (the text goes out unchanged); one that cancels stops the send with its reason.
   */
  async filterComposer(text: string): Promise<{ text: string } | { cancel: string }> {
    if (this.safeMode) return { text };
    let current = text;
    for (const e of this.installed) {
      const filter = e.state === "active" ? this.composerFilters.get(e.package.manifest.id) : undefined;
      if (!filter) continue;
      try {
        const out = await filter.run(current);
        if (out && typeof out === "object" && "cancel" in out) return { cancel: `[${e.package.manifest.name}] ${out.cancel}` };
        if (typeof out === "string") current = out; else if (out) current = out.text;
      } catch { /* a broken filter must never keep the user from sending */ }
    }
    return { text: current };
  }
  private activeOwner(owner: string): boolean {
    return !this.safeMode && this.installed.some(e => e.package.manifest.id === owner && e.state === "active");
  }
  /** The label an active extension put on a session, if any. */
  labelOf(sessionId: string): SessionLabel | undefined {
    for (const set of this.labelSets) if (this.activeOwner(set.owner) && set.labels[sessionId]) return set.labels[sessionId];
    return undefined;
  }
  /** Every `@` completion the active extensions offer. */
  mentions(): MentionItem[] {
    return this.mentionSets.filter(x => this.activeOwner(x.owner)).flatMap(x => x.items);
  }
  /** The sender of a message another session sent, when an active extension recognises its first line. */
  senderOf(text: string): { from: string; body: string } | null {
    if (!this.senderRules.length) return null;
    const nl = text.indexOf("\n");
    const first = (nl < 0 ? text : text.slice(0, nl)).slice(0, 500);
    for (const rule of this.senderRules) {
      if (!this.activeOwner(rule.owner)) continue;
      const m = rule.first.exec(first);
      if (m?.[1]) return { from: m[1].trim(), body: nl < 0 ? "" : text.slice(nl + 1) };
    }
    return null;
  }
  messageRendererFor(entryType: string): MessageRenderer | undefined {
    if (this.safeMode) return undefined;
    return this.messageRenderers.find(r => r.entryType === entryType && this.installed.some(e => e.package.manifest.id === r.owner && e.state === "active"));
  }
  /** The renderer an extension registered for a tool, if any. */
  rendererFor(toolName: string): ToolRenderer | undefined {
    if (this.safeMode) return undefined;
    return this.toolRenderers.find(r => r.toolName === toolName && this.installed.some(e => e.package.manifest.id === r.owner && e.state === "active"));
  }
  emit(event: ExtensionEvent) {
    if (this.safeMode) return;
    const safe = { type: event.type, sessionId: event.sessionId, at: event.at, ...(event.status === undefined ? {} : { status: event.status }), ...(event.toolName === undefined ? {} : { toolName: event.toolName, isError: event.isError === true }) };
    for (const id of this.subscribed) this.runtimes.get(id)?.event(safe);
  }
}
export const extensions = new ExtensionHost();
