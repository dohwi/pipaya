import {
  Api,
  ApiError,
  describeConnectError,
  errorText,
  isUnsupportedRoute,
  normalizeUrl,
  verifyServer,
} from "./api";
import { expandHome } from "./workdir-path";
import { isTauri } from "./tauri";
import { compat, type Compat, type ServerVersions } from "./protocol";
import { serverUpdater } from "./server-update.svelte";
import { hostOf, uid } from "./format";
import { ChatState } from "./chat.svelte";
import { ServerLink, type NetState as LinkNet } from "./server-link.svelte";
import { applyLinkEvent } from "./server-link-model";
import { viewport } from "./viewport.svelte";
import { sessionOrder, sidebarDirs, tabOf, tabPanes, type DirBlock, type Tab } from "./nav";
import { MAX_PANES, append, has as layoutHas, pair, panesOf, place, remove as layoutRemove, replaceSession, worthKeeping, type Layout, type Zone } from "./layout";
import { extensions } from "./extensions/host.svelte";
import { DEFAULT_ESCALATE, ESCALATE_CHOICES, deviceIdentity, notifications } from "./notifications";
import { ServerSettingsSync } from "./server-settings";
import { PairingError, redeemPairing, type PairingLink } from "./pairing";
import { getLang, LocalizedError, onLangChange, remotePack, remotePackVersions, setRemotePacks, t } from "./i18n";
import { parseConfiguration, parseKeybindings, type ConfigurationDocument } from "./extensions/configuration";
import { rehydrateSettingsFromDurable } from "./durable-storage";
import { K, read, write } from "./persist";
import { Preferences } from "./prefs.svelte";
import { Feedback, type Toast } from "./feedback.svelte";
import { SidebarState, reorder } from "./sidebar.svelte";
import { isBrowserId, type BrowserSupport, type BrowserTabInfo } from "./browser";
import { isTerminalId, type TerminalInfo, type TerminalSupport } from "./terminal";
import type {
  Group,
  DefaultModelSelection,
  PipayaEvent,
  FileRef,
  ImageBlock,
  ModelInfo,
  ProviderInfo,
  SendMode,
  Session,
  ToolInfo,
  UploadFile,
  WorkspaceInfo,
  WorkdirInfo,
  ToolsInfo,
} from "./types";

export type NetState = LinkNet;
/** What a closed server reads as: shared and empty, so a getter never hands out something to write into. */
const NONE: never[] = [];
const NONE_MAP: Record<string, never> = {};
export type { ThemePref } from "./prefs.svelte";
export type { Toast, Notice } from "./feedback.svelte";
export { NOTICE_MS, NOTICE_MAX } from "./feedback.svelte";
export { SIDEBAR_W } from "./sidebar.svelte";
export type { PaletteItem, PaletteSpec, Draft, Server } from "./store-model";
export { defaultServerUrl } from "./store-model";
import { draftFromDefault, loadServers, normalizeThinking, readDraft } from "./store-model";
import type { Draft, PaletteSpec, Server } from "./store-model";

class AppStore {
  servers = $state<Server[]>(loadServers());
  serverId = $state<string | null>(null);
  /** Add-server / edit-server dialog: `null` = closed, `"new"` = add, otherwise the id being edited. */
  serverForm = $state<string | "new" | null>(null);
  /** Every saved server, kept live (lists, models, activity) by its own event stream; the open one is only the one in view. */
  links = $state<Record<string, ServerLink>>({});
  /** The link of the server in view. */
  get link(): ServerLink | null {
    return (this.serverId && this.links[this.serverId]) || null;
  }
  /* What the open server holds is read from its link (every server is kept live, see ServerLink); these are the open one's. */
  get net(): NetState {
    return this.link?.net ?? "idle";
  }
  /** What the open server said about its version on connect (`/health`), or null before that. */
  get serverVersions(): ServerVersions | null {
    return this.link?.versions ?? null;
  }
  /** The open server needs a newer app (`update-app`) or is older than this app (`update-server`). */
  get compat(): Compat {
    return this.net === "incompatible" ? "update-app" : compat(this.serverVersions);
  }
  get netError(): string {
    return this.link?.netError ?? "";
  }

  /** Active (not closed) sessions only. Closed ones are fetched on demand by /resume and /tree. */
  get sessions(): Session[] {
    return this.link?.data.sessions ?? NONE;
  }
  set sessions(v: Session[]) {
    if (this.link) this.link.data.sessions = v;
  }
  /** Archived sessions: open (not closed) but tucked into the sidebar's archive. A new message on the server brings one back. */
  get archived(): Session[] {
    return this.link?.data.archived ?? NONE;
  }
  set archived(v: Session[]) {
    if (this.link) this.link.data.archived = v;
  }
  /** The server whose conversation list (manage / archive / delete) is open, or null. */
  sessionsDialog = $state<string | null>(null);
  /** Workspace root on the server; every session lives in a working directory under it. */
  get workspace(): WorkspaceInfo | null {
    return this.link?.workspace ?? null;
  }
  set workspace(v: WorkspaceInfo | null) {
    if (this.link) this.link.workspace = v;
  }
  /** Working directory (relative to the root, "." = root) where the next new chat starts. */
  /** Directory the next new chat starts in: "." = the server's default, else a path relative to it or absolute */
  workdir = $state(".");
  /** The server's default working directory setting (null on servers from before it existed) */
  get workdirInfo(): WorkdirInfo | null {
    return this.link?.workdirInfo ?? null;
  }
  set workdirInfo(v: WorkdirInfo | null) {
    if (this.link) this.link.workdirInfo = v;
  }
  /** Agent tools the user can switch off / always-on ones / the ones switched off; saved on the server */
  get toolsInfo(): ToolsInfo | null {
    return this.link?.toolsInfo ?? null;
  }
  set toolsInfo(v: ToolsInfo | null) {
    if (this.link) this.link.toolsInfo = v;
  }
  /** Open the directory picker */
  dirPicker = $state(false);
  /** Images open in the full-screen viewer (null = closed) */
  viewer = $state<{
    images: { src: string; mimeType: string }[];
    index: number;
  } | null>(null);

  openImage(images: { src: string; mimeType: string }[], index = 0) {
    if (images.length) this.viewer = { images, index };
  }
  /** Starred sessions and models. Kept in this browser, like the layout; not part of the server's data. */
  /** Starred models of the open server (server scope: shared with every client of that server). */
  favModels = $state<string[]>([]);
  /** Starred working directories (absolute paths) of the open server, shown in the directory picker */
  favDirs = $state<string[]>([]);
  /** Minutes an unread PC notification waits before the phone is pushed too (server scope: the server acts on it) */
  escalateMinutes = $state<number>(DEFAULT_ESCALATE);

  setEscalateMinutes(minutes: number) {
    if (!(ESCALATE_CHOICES as readonly number[]).includes(minutes) || minutes === this.escalateMinutes) return;
    this.escalateMinutes = minutes;
    if (this.serverId) write(`${K.escalate}.${this.serverId}`, minutes);
    this.settingsSync?.changed("notificationPolicy");
  }
  /** Picker overlay opened by a slash command. */
  palette = $state.raw<PaletteSpec | null>(null);
  /** Bumped by /model to open the model picker. */
  modelPickerTick = $state(0);
  /** Bumped by the "queue message" shortcut: the focused composer queues its input. */
  queueSendTick = $state(0);
  /** Bumped by the "find in chat" shortcut; the focused pane opens its search bar. */
  findTick = $state(0);
  /** Bumped when the open server reports a model-connection change (any client) */
  configTick = $state(0);
  /** Model new chats start with on this server (saved default, else the server's startup default) */
  get serverDefault(): DefaultModelSelection | null {
    return this.link?.serverDefault ?? null;
  }
  set serverDefault(v: DefaultModelSelection | null) {
    if (this.link) this.link.serverDefault = v;
  }
  get sessionsLoaded(): boolean {
    return this.link?.loaded ?? false;
  }
  /** The focused session: what commands, shortcuts and the header act on. null = a new chat that has no session yet. */
  activeId = $state<string | null>(null);
  /** The session that had the focus before this one: the target of "back to the previous conversation". */
  previousId: string | null = null;
  /** Transcripts of every session on screen: the focused one, plus all panes of the open group. */
  chats = $state.raw<Record<string, ChatState>>({});
  /** Session groups of the open server: named split-window layouts, stored on the server. */
  get groups(): Group[] {
    return this.link?.data.groups ?? NONE;
  }
  set groups(v: Group[]) {
    if (this.link) this.link.data.groups = v;
  }
  /** Terminals open on the server (shells on its own OS), and what it supports; null support = not known (yet) */
  get terminals(): TerminalInfo[] {
    return this.link?.data.terminals ?? NONE;
  }
  set terminals(v: TerminalInfo[]) {
    if (this.link) this.link.data.terminals = v;
  }
  get terminalSupport(): TerminalSupport | null {
    return this.link?.terminalSupport ?? null;
  }
  /** Browser tabs open on the server (pages in its Chromium), and whether it can run one; null support = not known (yet) */
  get browsers(): BrowserTabInfo[] {
    return this.link?.data.browsers ?? NONE;
  }
  set browsers(v: BrowserTabInfo[]) {
    if (this.link) this.link.data.browsers = v;
  }
  get browserSupport(): BrowserSupport | null {
    return this.link?.browserSupport ?? null;
  }

  get models(): ModelInfo[] {
    return this.link?.models ?? NONE;
  }
  get providers(): ProviderInfo[] {
    return this.link?.providers ?? NONE;
  }
  get tools(): ToolInfo[] {
    return this.link?.tools ?? NONE;
  }

  get running(): Record<string, boolean> {
    return this.link?.data.running ?? NONE_MAP;
  }
  /** The grouped session shown full-size in its group for a moment (Esc returns to the grid) */
  zoomId = $state<string | null>(null);
  /** Groups in "full" mode (kept on this device): one pane fills the group and a strip under the header picks the pane. */
  fullGroups = $state<string[]>(read<string[]>(K.fullGroups, []));
  get awaiting(): Record<string, number> {
    return this.link?.data.awaiting ?? NONE_MAP;
  }
  get unread(): Record<string, boolean> {
    return this.link?.data.unread ?? NONE_MAP;
  }
  /** Sessions whose last run ended in an error and have not been looked at yet */
  get failed(): Record<string, boolean> {
    return this.link?.data.failed ?? NONE_MAP;
  }

  draft = $state<Draft>(readDraft());

  /** Theme, sound and shortcuts of this device. */
  readonly prefs = new Preferences();
  /** Toasts and done-notices. */
  readonly feedback = new Feedback();
  /** Drawer, width, folded nodes, dragged order. */
  readonly sidebar = new SidebarState();

  /** Text the composer should pick up once (edit-and-branch). */
  prefill = $state<string | null>(null);
  /** Message the next prompt answers (the Reply button); the composer shows it as a badge and quotes it on send. */
  replyTo = $state<{ text: string; who?: string } | null>(null);
  settingsOpen = $state(false);
  /** Skills dialog (opened from the footer badge). cwd decides which project's skills; sessionId marks the ones that conversation already uses. */
  skillsDialog = $state<{ cwd: string; sessionId: string | null } | null>(null);
  /** Bumped when any client changes a skill, so footers and dialogs re-read it. */
  skillsTick = $state(0);
  openSkills(sessionId: string | null = this.activeId) {
    if (!this.api) return;
    this.skillsDialog = { cwd: this.session(sessionId)?.cwd ?? this.workdirAbs, sessionId };
  }
  /** Extension commands dialog (`/prefix:name`, opened from the footer badge). cwd decides which folder's commands are listed. */
  commandsDialog = $state<{ cwd: string } | null>(null);
  openCommands(sessionId: string | null = this.activeId) {
    if (!this.api) return;
    this.commandsDialog = { cwd: this.session(sessionId)?.cwd ?? this.workdirAbs };
  }
  settingsTab = $state<"general" | "servers" | "keys" | "extensions" | "backup" | "agent">("general");
  /** The server whose detail page the settings window opens on (`"new"` for the add form), or null for the list. */
  settingsServer = $state<string | "new" | null>(null);
  openSettings(
    tab: "general" | "servers" | "keys" | "extensions" | "backup" | "agent" = "general",
    server: string | "new" | null = null,
  ) {
    this.settingsTab = tab;
    this.settingsServer = tab === "servers" ? server : null;
    this.settingsOpen = true;
  }
  sending = $state(false);

  /** The open server's connection. */
  get api(): Api | null {
    return this.link?.api ?? null;
  }
  private attachToken = 0;
  private hiddenAt = 0;

  /* ---------- derived ---------- */

  get server(): Server | undefined {
    return this.servers.find((s) => s.id === this.serverId);
  }

  /** Connection of the open server (kept as `conn` for components that only need url/token). */
  /** Reconnect the open server now (its stream is dropped and everything is read again). */
  async sync(): Promise<void> {
    await this.link?.sync();
  }

  get conn(): { baseUrl: string; token: string } | null {
    const s = this.server;
    return s ? { baseUrl: s.baseUrl, token: s.token } : null;
  }

  get current(): Session | undefined {
    return this.session(this.activeId);
  }

  terminal(id: string | null | undefined): TerminalInfo | undefined {
    return isTerminalId(id) ? this.terminals.find((x) => x.id === id) : undefined;
  }

  browser(id: string | null | undefined): BrowserTabInfo | undefined {
    return isBrowserId(id) ? this.browsers.find((x) => x.id === id) : undefined;
  }

  /** A session, terminal or browser tab that is open: something a pane can show. */
  shows(id: string | null | undefined): boolean {
    return !!this.session(id) || !!this.terminal(id) || !!this.browser(id);
  }

  session(id: string | null | undefined): Session | undefined {
    return id ? this.sessions.find((s) => s.id === id) : undefined;
  }

  /** Transcript of the focused session. */
  get chat(): ChatState | null {
    return this.chatOf(this.activeId);
  }

  chatOf(id: string | null | undefined): ChatState | null {
    return (id && this.chats[id]) || null;
  }

  /** The group of the focused session: opening any of its sessions shows the whole group. */
  get activeGroup(): Group | undefined {
    return this.activeId ? this.groupOf(this.activeId) : undefined;
  }

  /** The focused session when it is a chat (what the server counts as read while this window is in front). */
  get readableId(): string | null {
    return this.activeId && !isTerminalId(this.activeId) && !isBrowserId(this.activeId) ? this.activeId : null;
  }

  /** Sessions whose transcripts must be loaded: the focused one, and every pane of the group on a wide screen. */
  get visibleIds(): string[] {
    const out = new Set<string>();
    if (this.activeId && !isTerminalId(this.activeId) && !isBrowserId(this.activeId)) out.add(this.activeId);
    const g = this.activeGroup;
    if (g && !viewport.narrow)
      for (const id of panesOf(g.layout)) if (this.session(id)) out.add(id);
    return [...out];
  }

  private dropFull(groupId: string) {
    if (!this.fullGroups.includes(groupId)) return;
    this.fullGroups = this.fullGroups.filter((x) => x !== groupId);
    write(K.fullGroups, this.fullGroups);
  }

  isFull(groupId: string | undefined): boolean {
    return !!groupId && this.fullGroups.includes(groupId);
  }

  toggleFull(groupId: string) {
    this.fullGroups = this.isFull(groupId) ? this.fullGroups.filter((x) => x !== groupId) : [...this.fullGroups, groupId];
    this.zoomId = null;
    write(K.fullGroups, this.fullGroups);
  }

  /** Every pane on screen, terminals included (toasts land in whichever of them they are about). */
  get shownIds(): string[] {
    const g = this.activeGroup;
    const out = new Set<string>(this.activeId ? [this.activeId] : []);
    if (g && !viewport.narrow) for (const id of panesOf(g.layout)) if (this.shows(id)) out.add(id);
    return [...out];
  }

  groupOf(sessionId: string): Group | undefined {
    return this.groups.find((g) => layoutHas(g.layout, sessionId));
  }

  /** Is this session in front of the user right now? (a group shows all its panes, except on a narrow screen) */
  private isShown(id: string): boolean {
    if (id === this.activeId) return true;
    const g = this.activeGroup;
    return !viewport.narrow && !!g && layoutHas(g.layout, id);
  }

  /** The model and thinking level shown in the UI: the session's, or the draft's for a new chat. */
  get effective(): Draft {
    return this.effectiveOf(this.activeId);
  }

  effectiveOf(id: string | null): Draft {
    const s = this.session(id);
    return s
      ? {
          provider: s.provider,
          model: s.model,
          thinkingLevel: normalizeThinking(s.thinkingLevel),
        }
      : this.draft;
  }

  get effectiveModel(): ModelInfo | undefined {
    return this.effectiveModelOf(this.activeId);
  }

  effectiveModelOf(id: string | null): ModelInfo | undefined {
    const e = this.effectiveOf(id);
    return this.models.find(
      (m) => m.provider === e.provider && m.id === e.model,
    );
  }

  /** Sessions with work in progress (a run or a compaction); closing the window would cut these off. */
  busyIds(): string[] {
    const ids = new Set(Object.keys(this.running).filter((id) => this.running[id]));
    for (const id of this.visibleIds) if (this.chatOf(id)?.compacting) ids.add(id);
    return [...ids];
  }

  /** Window close asked while work is running: shows the confirmation. `confirm` stops the work, then closes. */
  closeConfirm = $state<{ count: number; confirm(): void; cancel(): void } | null>(null);
  /** Resolves true when the window may close now (nothing running, or the user confirmed and the work was stopped). */
  async requestClose(): Promise<boolean> {
    if (this.closeConfirm) return false;
    // Only the "This PC" server dies with the window. Other servers keep running in the background, so their work is left alone.
    const local = this.servers.find((s) => s.local);
    if (!local) return true;
    let api: Api;
    let ids: string[];
    if (local.id === this.serverId) {
      if (!this.api) return true;
      api = this.api;
      ids = this.busyIds();
    } else {
      // Another server is open: ask the local one directly what it is running.
      api = new Api({ baseUrl: local.baseUrl, token: local.token });
      try {
        ids = (await api.activity()).sessions.filter((a) => a.running).map((a) => a.sessionId);
      } catch {
        return true; // local server not reachable: nothing to cut off
      }
    }
    if (!ids.length) return true;
    return new Promise((resolve) => {
      const done = (ok: boolean) => { this.closeConfirm = null; resolve(ok); };
      this.closeConfirm = {
        count: ids.length,
        cancel: () => done(false),
        confirm: () => {
          const targets = local.id === this.serverId ? this.busyIds() : ids;
          void Promise.allSettled(targets.map((id) => api.abort(id))).then(() => done(true));
        },
      };
    });
  }

  get runningHere(): boolean {
    return !!this.chat?.running;
  }

  /* ---------- boot / connection ---------- */

  init() {
    void rehydrateSettingsFromDurable().then((restored) => {
      if (restored) {
        if (this.servers.length === 0) {
          this.servers = loadServers();
        }
        this.prefs.reload();
        const saved = read<string | null>(K.currentServer, null);
        const first = this.servers.find((s) => s.id === saved) ?? this.servers[0];
        if (first && !this.serverId) this.openServer(first.id);
      }
    });
    this.prefs.init();
    // Session @names follow the UI language (민수 <-> Minsu); the server renames, and session_updated events refresh the list.
    // Client extensions hear the change too (they may keep text in it).
    let language = getLang();
    onLangChange(() => {
      if (getLang() === language) return;
      const wasKorean = /^ko(?:-|$)/i.test(language);
      language = getLang();
      if (wasKorean !== /^ko(?:-|$)/i.test(language)) void this.api?.localizeNames(language).catch(() => {}); // offline: names just stay
      extensions.emit({ type: "language_changed", sessionId: null, at: Date.now() });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.hiddenAt = Date.now();
      } else {
        // Mobile OSes silently kill background sockets; resync instead of trusting the streams.
        this.resyncLinks(Date.now() - this.hiddenAt <= 20_000);
      }
    });
    window.addEventListener(
      "online",
      () => this.resyncLinks(true),
    );
    const saved = read<string | null>(K.currentServer, null);
    const first = this.servers.find((s) => s.id === saved) ?? this.servers[0];
    this.syncLinks(); // every saved server goes live at once; `first` is only the one in view
    if (first) this.openServer(first.id);
    void this.ensureLocalServer();
  }

  /**
   * Desktop app: start the bundled server (loopback only) and keep it in the list, so a PC works with no separate install.
   * It becomes the open server only when nothing else is open; existing remote servers are left as they are.
   */
  async ensureLocalServer() {
    try {
      await this.startLocalServer();
    } finally {
      this.localChecked = true;
    }
  }

  /** False until the desktop app has tried to start its bundled server (so the empty-list screen does not flash). */
  localChecked = $state(false);

  /** Where the bundled server listens now (desktop only); null when this build has none. */
  async localBind(): Promise<{ host: string; port: number } | null> {
    if (!isTauri()) return null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<{ host: string; port: number }>("local_server_bind");
    } catch {
      return null;
    }
  }

  /** Change where the bundled server listens ("" = this PC only) and restart it there. Throws the reason on failure. */
  async setLocalBind(host: string, port: number) {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{ baseUrl: string; token: string }>("set_local_server_bind", { host, port });
    await this.applyLocalInfo(info);
  }

  private async startLocalServer() {
    if (!isTauri()) return;
    let info: { baseUrl: string; token: string };
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      info = await invoke("local_server");
    } catch {
      return; // mobile, or the bundled server is missing (dev build): the manual flow still works
    }
    await this.applyLocalInfo(info);
  }

  private async applyLocalInfo(info: { baseUrl: string; token: string }) {
    const baseUrl = normalizeUrl(info.baseUrl);
    const cur = this.servers.find((s) => s.local);
    if (cur) {
      if (cur.baseUrl !== baseUrl || cur.token !== info.token) {
        const i = this.servers.findIndex((s) => s.id === cur.id);
        this.servers[i] = { ...cur, baseUrl, token: info.token };
        this.saveServers();
        this.syncLinks();
        if (cur.id === this.serverId) this.openServer(cur.id, true);
      }
    } else {
      const server: Server = { id: uid(), name: t("로컬"), baseUrl, token: info.token, local: true };
      this.servers.push(server);
      this.saveServers();
      this.syncLinks();
    }
    const local = this.servers.find((s) => s.local)!;
    if (!this.serverId || !this.servers.some((s) => s.id === this.serverId)) this.openServer(local.id);
  }

  /* ---------- servers ---------- */

  private saveServers() {
    write(K.servers, this.servers);
  }

  /** Display name: the user's label, else the host. */
  serverLabel(s: Server): string {
    return s.name.trim() || hostOf(s.baseUrl);
  }

  /** Add a (already verified) server and switch to it. */
  addServer(input: { name: string; baseUrl: string; token: string }): Server {
    const baseUrl = normalizeUrl(input.baseUrl);
    const dup = this.servers.find((s) => s.baseUrl === baseUrl);
    if (dup) {
      // Same address again: treat it as editing (e.g. a rotated token) instead of listing it twice.
      this.updateServer(dup.id, { ...input, baseUrl });
      this.openServer(dup.id, true);
      return dup;
    }
    const server: Server = {
      id: uid(),
      name: input.name.trim(),
      baseUrl,
      token: input.token.trim(),
    };
    this.servers.push(server);
    this.saveServers();
    this.openServer(server.id);
    return server;
  }

  /** Progress of a connection made from a link or QR; drives the card shown over the whole app */
  linking = $state<{ name: string; baseUrl: string; state: "confirm" | "working" | "done" | "failed"; error?: string } | null>(null);
  private linkSeen = new Set<string>();
  private pendingLink: PairingLink | null = null;

  /**
   * A link that reaches the app (camera, message, command line) only asks first: anyone can craft one that points at
   * their own server, so nothing is redeemed or added until the user confirms the address shown on the card.
   */
  connectByLink(link: PairingLink) {
    if (this.linkSeen.has(link.code)) return;
    this.linkSeen.add(link.code);
    this.pendingLink = link;
    this.linking = { name: link.name || hostOf(link.baseUrl), baseUrl: link.baseUrl, state: "confirm" };
  }

  /** The user approved the address on the confirmation card: trade the one-time code for the token and add the server. */
  async confirmLinking() {
    const link = this.pendingLink;
    if (!link || this.linking?.state !== "confirm") return;
    this.pendingLink = null;
    const name = link.name || hostOf(link.baseUrl);
    this.linking = { name, baseUrl: link.baseUrl, state: "working" };
    try {
      const token = await redeemPairing(link, (await deviceIdentity().catch(() => null))?.name);
      await verifyServer(link.baseUrl, token);
      const before = this.servers.length;
      this.addServer({ name: link.name, baseUrl: link.baseUrl, token });
      this.linking = { name, baseUrl: link.baseUrl, state: "done" };
      this.toast(this.servers.length > before ? t("서버를 추가했습니다") : t("이미 등록된 주소라 정보를 갱신했습니다"), "ok");
    } catch (e) {
      const why: Record<string, string> = {
        expired: t("연결 코드가 만료됐거나 이미 사용됐습니다. PC에서 새 QR을 만들어 주세요."),
        throttled: t("잘못된 코드가 너무 많이 시도됐습니다. 잠시 뒤 다시 시도해 주세요."),
        unsupported: t("이 서버는 QR 연결을 지원하지 않습니다. 서버를 최신 버전으로 업데이트해 주세요."),
        timeout: t("서버 응답 시간이 초과되었습니다."),
        unreachable: t("{url}에 연결할 수 없습니다. 주소와 서버 실행 여부를 확인하세요.", { url: link.baseUrl }),
        failed: t("연결하지 못했습니다."),
      };
      const error = e instanceof PairingError ? (why[e.reason] ?? why.failed!) : describeConnectError(e, link.baseUrl);
      this.linking = { name, baseUrl: link.baseUrl, state: "failed", error };
    }
  }
  closeLinking() {
    // declining a link frees its code, so scanning the same QR again still works
    if (this.pendingLink) this.linkSeen.delete(this.pendingLink.code);
    this.pendingLink = null;
    this.linking = null;
  }

  updateServer(
    id: string,
    patch: Partial<Pick<Server, "name" | "baseUrl" | "token">>,
  ) {
    const i = this.servers.findIndex((s) => s.id === id);
    if (i < 0) return;
    const cur = this.servers[i]!;
    const next: Server = {
      ...cur,
      name: patch.name !== undefined ? patch.name.trim() : cur.name,
      baseUrl:
        patch.baseUrl !== undefined ? normalizeUrl(patch.baseUrl) : cur.baseUrl,
      token: patch.token !== undefined ? patch.token.trim() : cur.token,
    };
    this.servers[i] = next;
    this.saveServers();
    const connChanged =
      next.baseUrl !== cur.baseUrl || next.token !== cur.token;
    if (id === this.serverId && connChanged) this.openServer(id, true);
    if (connChanged) this.syncLinks();
  }

  /** Put server `id` before/after `target` in the list (the order the sidebar and the rail show) and remember it. */
  moveServer(id: string, target: string, after: boolean) {
    const ids = reorder(this.servers.map((s) => s.id), id, target, after);
    if (!ids) return;
    this.servers = ids.map((i) => this.servers.find((s) => s.id === i)!);
    this.saveServers();
  }

  removeServer(id: string) {
    const wasOpen = id === this.serverId;
    this.servers = this.servers.filter((s) => s.id !== id);
    this.saveServers();
    this.syncLinks();
    try {
      localStorage.removeItem(`${K.active}.${id}`);
      localStorage.removeItem(`${K.favModels}.${id}`);
      localStorage.removeItem(`${K.favDirs}.${id}`);
      localStorage.removeItem(`${K.escalate}.${id}`);
      localStorage.removeItem(`pipaya.settings-sync.${id}`);
    } catch {
      /* ignore */
    }
    if (!wasOpen) return;
    const next = this.servers[0];
    if (next) this.openServer(next.id);
    else this.closeServer();
  }

  /** Make `links` match the saved servers: a link for each, rebuilt when its address or token changed, dropped when it is gone. */
  private syncLinks() {
    const next: Record<string, ServerLink> = {};
    let changed = false;
    for (const s of this.servers) {
      const old = this.links[s.id];
      if (old && old.server.baseUrl === s.baseUrl && old.server.token === s.token) {
        next[s.id] = old;
        continue;
      }
      old?.stop();
      const link = new ServerLink(s, {
        event: (l, e) => this.onLinkEvent(l, e),
        ready: (l) => void this.attach(l),
      });
      next[s.id] = link;
      changed = true;
      link.start();
    }
    for (const id of Object.keys(this.links)) if (!next[id]) {
      this.links[id]!.stop();
      changed = true;
    }
    if (changed) this.links = next;
    notifications.track(Object.values(next).map((l) => l.api));
  }

  /** The id of the saved server behind `api`. */
  serverIdOfApi(api: unknown): string | null {
    return Object.values(this.links).find((l) => l.api === api)?.id ?? null;
  }

  /** Put a server in view: its conversations open here, and its lists (already live) are shown at once. */
  openServer(id: string, force = false) {
    const target = this.servers.find((s) => s.id === id);
    if (!target) return;
    if (!force && this.serverId === id && this.net !== "idle") return;
    this.syncLinks();
    this.attachToken++;
    // The extension host reads the open server's list once at launch (init); only a later switch has to swap it.
    const changing = this.openedFor !== null && this.openedFor !== id;
    this.serverId = id;
    this.openedFor = id;
    write(K.currentServer, id);
    this.settingsSync?.dispose();
    this.settingsSync = null;
    this.favModels = this.loadFavModels(id);
    this.favDirs = this.loadFavDirs(id);
    this.escalateMinutes = this.loadEscalate(id);
    if (changing) void extensions.switchServer();
    notifications.connect(null);
    serverUpdater.reset();
    this.workdir = read<string>(`${K.workdir}.${id}`, ".");
    this.palette = null;
    this.skillsDialog = null;
    this.commandsDialog = null;
    this.queueDialog = null;
    this.activeId = null;
    this.chats = {};
    this.sidebar.open = false;
    const link = this.links[id];
    if (!link) return;
    if (link.online && link.loaded) void this.attach(link);
    else void link.sync(); // not reachable yet (or refused earlier): try now instead of waiting for the next retry
  }

  private closeServer() {
    this.attachToken++;
    this.serverId = null;
    this.settingsSync?.dispose();
    this.settingsSync = null;
    this.favModels = [];
    this.favDirs = [];
    this.escalateMinutes = DEFAULT_ESCALATE;
    notifications.connect(null);
    this.activeId = null;
    this.chats = {};
    try {
      localStorage.removeItem(K.currentServer);
    } catch {
      /* ignore */
    }
  }

  /** Go to a server and open one of its sessions, or start a new chat in one of its working directories. */
  openIn(serverId: string, to: { session?: string; workdir?: string; terminal?: boolean; browser?: boolean; profile?: string }) {
    if (serverId !== this.serverId || this.net === "idle") {
      // A terminal asked for on another server opens once that server is connected (see sync).
      this.pendingTerminal = to.terminal ? (to.workdir ?? ".") : null;
      this.pendingBrowser = to.browser ? (to.workdir ?? ".") : null;
      this.pendingBrowserProfile = to.browser ? to.profile : undefined;
      this.pendingChat = !to.session && !to.terminal && !to.browser;
      if (to.workdir !== undefined)
        write(`${K.workdir}.${serverId}`, to.workdir);
      if (to.session) write(`${K.active}.${serverId}`, to.session);
      else
        try {
          localStorage.removeItem(`${K.active}.${serverId}`);
        } catch {
          /* ignore */
        }
      this.openServer(serverId, true);
      return;
    }
    if (to.session) void this.openSession(to.session);
    else if (to.terminal) void this.openTerminal(to.workdir);
    else if (to.browser) void this.openBrowser(undefined, undefined, to.workdir, to.profile);
    else {
      if (to.workdir !== undefined) this.setWorkdir(to.workdir);
      void this.startChat();
    }
  }

  /** Working directory of a terminal to open as soon as the server being switched to is connected */
  private pendingTerminal: string | null = null;

  /** Folder of a browser tab to open as soon as the server being switched to is connected */
  private pendingBrowser: string | null = null;
  private pendingBrowserProfile: string | undefined;

  /** A new chat to start as soon as the server being switched to is connected */
  private pendingChat = false;

  private get activeKey(): string {
    return `${K.active}.${this.serverId}`;
  }

  /** Reconnect every server that is not live (the window was away, or the network came back). */
  private resyncLinks(onlyDown: boolean) {
    for (const l of Object.values(this.links)) if (!onlyDown || !l.online) void l.sync();
  }

  /** A server's event arrived: the one in view reacts in full, the others just keep their lists and activity current. */
  private onLinkEvent(link: ServerLink, e: PipayaEvent) {
    if (link.id === this.serverId) return this.handle(e);
    // Notices of a server not in view still reach this device.
    if (e.type === "notification") {
      const data = e.data as { deviceId: string; notification: import("./notification-contract").NotificationSpec & { id: string; at: number } };
      void notifications.receive(data.deviceId, data.notification, link.api).catch(() => {});
    } else if (e.type === "device_revoked") notifications.revoked((e.data as { deviceId: string }).deviceId, link.api);
    applyLinkEvent(link.data, e);
    if (e.type === "provider_updated" || e.type === "configuration_updated") {
      void link.refreshCatalog();
      if (e.type === "configuration_updated") void link.refreshWorkspace();
    }
  }

  /** The server in view is loaded and streaming: restore its open conversation and start what belongs to the open server. */
  private async attach(link: ServerLink): Promise<void> {
    if (link.id !== this.serverId) return;
    const token = ++this.attachToken;
    const api = link.api;
    void this.refreshServerExtensions();
    void this.syncLocales(); // language packs: never blocks connecting, and a server without them just has none
    this.ensureDraftModel();
    this.startSettingsSync(api, link.id);
    // Restore (or refresh) the open conversation.
    const want = this.activeId ?? read<string | null>(this.activeKey, null);
    const had = Object.keys(this.chats);
    if (want && this.shows(want)) await this.openSession(want, true);
    else if (this.activeId) this.newChat();
    if (token !== this.attachToken) return;
    if (this.pendingTerminal !== null) {
      const dir = this.pendingTerminal;
      this.pendingTerminal = null;
      void this.openTerminal(dir);
    }
    if (this.pendingBrowser !== null) {
      const dir = this.pendingBrowser;
      this.pendingBrowser = null;
      const profile = this.pendingBrowserProfile;
      this.pendingBrowserProfile = undefined;
      void this.openBrowser(undefined, undefined, dir, profile);
    }
    if (this.pendingChat) {
      this.pendingChat = false;
      void this.startChat();
    }
    // Panes of the open group missed events while we were away: reload them too.
    for (const id of this.visibleIds) if (id !== this.activeId && had.includes(id)) void this.ensureChat(id, true);
    notifications.connect(api);
    void serverUpdater.check(api, link.id);
  }

  /** The user is looking at this window right now (so a sound or badge would only be noise). */
  private attended(): boolean {
    return (
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      document.hasFocus()
    );
  }

  private ensureDraftModel() {
    const usable = (p: string, id: string) =>
      this.models.some((m) => m.provider === p && m.id === id && m.configured && m.available !== false);
    if (usable(this.draft.provider, this.draft.model)) return;
    const d = this.serverDefault;
    if (d && usable(d.provider, d.model))
      return void this.updateDraft(draftFromDefault(d));
    const pick = this.models.find((m) => m.configured && m.available !== false) ?? this.models.find((m) => m.configured) ?? this.models[0];
    if (pick) this.updateDraft({ provider: pick.provider, model: pick.id });
  }

  updateDraft(patch: Partial<Draft>) {
    this.draft = { ...this.draft, ...patch };
    write(K.draft, this.draft);
  }

  /* ---------- events ---------- */

  private handle(e: PipayaEvent) {
    const sid = e.sessionId;
    // Only metadata is forwarded, never event data, messages, tool args or credentials.
    if (e.type === "run_started" || e.type === "run_finished" || e.type === "session_created" || e.type === "session_updated" || e.type === "session_deleted" || e.type === "compaction_finished" || e.type === "question_requested" || e.type === "question_resolved") {
      extensions.emit({ type: e.type, sessionId: sid, at: e.ts, ...(e.type === "run_finished" && typeof e.data.status === "string" ? { status: e.data.status } : {}) });
    }
    if (e.type === "group_created" || e.type === "group_updated" || e.type === "group_deleted") extensions.emit({ type: e.type, sessionId: null, at: e.ts, groupId: String((e.data as { id?: unknown }).id ?? "") });
    else if (e.type === "extensions_updated") extensions.emit({ type: "extensions_updated", sessionId: null, at: e.ts });
    if (e.type === "turn_end") extensions.emit({ type: "turn_end", sessionId: sid, at: e.ts });
    else if (e.type === "tool_execution_end") extensions.emit({ type: "tool_execution_end", sessionId: sid, at: e.ts, toolName: String((e.data as { toolName?: unknown }).toolName ?? ""), isError: (e.data as { isError?: unknown }).isError === true });
    // What server extensions publish is meant for client extensions, so it is forwarded as is.
    if (e.type === "extension_event") {
      const d = e.data as { extension: string; type: string; data: unknown };
      extensions.emitServer({ kind: "event", extension: d.extension, type: d.type, sessionId: sid, data: d.data });
    } else if (e.type === "extension_entry") {
      const d = e.data as { id: number; extension: string; type: string; data: unknown; createdAt?: number };
      if (sid) this.chats[sid]?.addEntry(d);
      extensions.emitServer({ kind: "entry", extension: d.extension, type: d.type, sessionId: sid, data: d.data, id: d.id });
    } else if (e.type === "extensions_updated") {
      this.serverExtensionsTick++;
      void this.refreshServerExtensions();
    }
    switch (e.type) {
      case "notification": {
        const data = e.data as { deviceId: string; notification: import("./notification-contract").NotificationSpec & { id: string; at: number } };
        void notifications.receive(data.deviceId, data.notification).catch(() => {});
        break;
      }
      case "session_unread": {
        const u = e.data as { sessionId: string; kind: "done" | "failed" | null };
        delete this.unread[u.sessionId];
        delete this.failed[u.sessionId];
        if (u.kind === "done") this.unread[u.sessionId] = true;
        else if (u.kind === "failed") this.failed[u.sessionId] = true;
        break;
      }
      case "device_revoked": {
        notifications.revoked((e.data as { deviceId: string }).deviceId);
        break;
      }
      case "session_created": {
        const s = e.data as Session;
        if (!s.closed && s.archived) {
          if (!this.archived.some((x) => x.id === s.id)) this.archived.unshift(s);
        } else if (!s.closed && !this.sessions.some((x) => x.id === s.id)) this.sessions.unshift(s);
        void this.refreshWorkspace();
        break;
      }
      case "session_updated": {
        const s = e.data as Session;
        const hide = s.closed || s.archived;
        const next = hide ? this.neighbourOf(s.id) : undefined;
        if (hide) this.forgetInGroups(s.id);
        const i = this.sessions.findIndex((x) => x.id === s.id);
        if (i >= 0) this.sessions.splice(i, 1);
        this.archived = this.archived.filter((x) => x.id !== s.id);
        if (s.archived && !s.closed) {
          // Archived sessions leave the tabs but stay open (a run goes on); the archive holds them until a message or a restore.
          this.archived.unshift(s);
          if (this.activeId === s.id) this.leave(next);
          break;
        }
        if (s.closed) {
          // Closed sessions leave the sidebar; only /resume brings them back.
          this.running[s.id] = false;
          this.awaiting[s.id] = 0;
          delete this.unread[s.id];
          delete this.failed[s.id];
          if (this.activeId === s.id) this.leave(next);
          break;
        }
        this.sessions.unshift(s);
        break;
      }
      case "group_created":
      case "group_updated": {
        const g = e.data as Group;
        const i = this.groups.findIndex((x) => x.id === g.id);
        if (i >= 0) this.groups[i] = g;
        else this.groups.push(g);
        break;
      }
      case "group_deleted":
        this.groups = this.groups.filter((x) => x.id !== (e.data as { id: string }).id);
        this.dropFull((e.data as { id: string }).id);
        break;
      case "terminal_created":
      case "terminal_updated": {
        const x = e.data as TerminalInfo;
        const i = this.terminals.findIndex((y) => y.id === x.id);
        if (i >= 0) this.terminals[i] = x;
        else this.terminals.push(x);
        break;
      }
      case "terminal_closed":
        this.dropTerminal((e.data as { id: string }).id);
        break;
      case "browser_created":
      case "browser_updated": {
        const x = e.data as BrowserTabInfo;
        const i = this.browsers.findIndex((y) => y.id === x.id);
        if (i >= 0) this.browsers[i] = x;
        else this.browsers.push(x);
        break;
      }
      case "browser_closed":
        this.dropBrowser((e.data as { id: string }).id);
        break;
      case "session_deleted": {
        const id = e.data.id as string;
        const next = this.neighbourOf(id);
        this.forgetInGroups(id);
        this.sessions = this.sessions.filter((x) => x.id !== id);
        this.archived = this.archived.filter((x) => x.id !== id);
        delete this.running[id];
        delete this.awaiting[id];
        delete this.unread[id];
        delete this.failed[id];
        if (this.activeId === id) this.leave(next);
        break;
      }
      case "compaction_started":
        if (sid) this.running[sid] = true;
        break;
      case "compaction_finished":
      case "compaction_failed":
        if (sid && !this.chats[sid]?.running) this.running[sid] = false;
        break;
      case "run_started":
        if (sid) {
          this.running[sid] = true;
          delete this.failed[sid];
          const i = this.sessions.findIndex((x) => x.id === sid);
          if (i > 0) {
            const [s] = this.sessions.splice(i, 1);
            this.sessions.unshift({ ...s!, updatedAt: e.ts });
          }
        }
        break;
      case "run_finished":
        if (sid) {
          this.running[sid] = false;
          this.awaiting[sid] = 0;
          const bad = e.data.status === "error";
          // The unread mark itself comes from the server (`session_unread`), so every device agrees on it.
          // A stopped run is the user's own doing: no sound
          if (e.data.status !== "aborted")
            this.prefs.cue(bad ? "failed" : "done");
          // Say it when the user is on another session (a phone shows only one) or on another pane of the group
          if (sid !== this.activeId && (viewport.narrow || this.isShown(sid)) && e.data.status !== "aborted")
            this.feedback.announce(sid, bad ? "failed" : "done");
        }
        break;
      case "question_requested":
        if (sid) {
          const first = !this.awaiting[sid];
          this.awaiting[sid] = (this.awaiting[sid] ?? 0) + 1;
          if (first) this.prefs.cue("ask");
        }
        break;
      case "question_resolved":
        if (sid)
          this.awaiting[sid] = Math.max(0, (this.awaiting[sid] ?? 0) - 1);
        break;
      case "provider_updated":
        void this.refreshProviders();
        break;
      case "skills_updated":
        this.skillsTick++;
        break;
      case "locales_updated":
        void this.syncLocales();
        break;
      case "client_settings_updated":
        void this.settingsSync?.onEvent(e.data as { key?: unknown; updatedAt?: unknown; origin?: unknown });
        break;
      case "configuration_updated":
        this.configTick++;
        void this.refreshProviders();
        if ((e.data as { scope?: string } | undefined)?.scope === "tools") {
          this.toolsInfo = e.data as ToolsInfo;
        }
        if ((e.data as { scope?: string } | undefined)?.scope === "workdir") {
          this.workdirInfo = {
            saved: (e.data as WorkdirInfo).saved,
            effective: (e.data as WorkdirInfo).effective,
            fallback: (e.data as WorkdirInfo).fallback,
          };
          void this.refreshWorkspace();
        }
        break;
    }
    const chat = sid ? this.chats[sid] : undefined;
    if (chat) {
      chat.apply(e);
      if (e.type === "run_finished" || e.type === "compaction_finished") {
        void this.refreshUsage(chat);
        void chat.refreshContext();
      }
      if (e.type === "session_updated") void chat.refreshContext();
      if (e.type === "compaction_finished" || e.type === "compaction_failed") void this.flushHeld(chat);
    }
  }

  /**
   * UI language packs published on the server. Only packs that changed since the last sync are downloaded; a failed
   * download keeps the copy already held (or none), and a server from before language packs leaves the cache untouched.
   */
  async syncLocales(): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const list = await api.locales();
      if (api !== this.api) return;
      const have = remotePackVersions();
      const packs = await Promise.all(
        list.map(async (info) => {
          const cached = remotePack(info.tag);
          if (cached && have[info.tag] === info.updatedAt) return cached;
          try {
            return await api.locale(info.tag);
          } catch {
            return cached; // keep what we have
          }
        }),
      );
      if (api !== this.api) return;
      setRemotePacks(packs.filter((p) => p !== undefined));
    } catch {
      /* offline: keep the cached packs */
    }
  }

  async refreshProviders() {
    const link = this.link;
    if (!link) return;
    const before = this.serverDefault;
    if (!(await link.refreshCatalog()) || link !== this.link) return;
    const now = this.serverDefault;
    // The default was changed (here or from another client): new chats follow it, model and strength together.
    if (
      now &&
      (now.provider !== before?.provider || now.model !== before?.model || now.thinkingLevel !== before?.thinkingLevel) &&
      this.models.some((m) => m.provider === now.provider && m.id === now.model && m.configured && m.available !== false)
    ) {
      this.updateDraft(draftFromDefault(now));
    }
    this.ensureDraftModel();
  }

  async refreshUsage(chat: ChatState | null = this.chat) {
    if (!chat || !this.api) return;
    try {
      const u = await this.api.usage(chat.id);
      if (this.chats[chat.id] === chat) chat.usage = u;
    } catch {
      /* non-critical */
    }
  }

  /* ---------- workspace / workdir ---------- */

  /** `/home/x/workspace/proj/a` -> `proj/a`; the root itself is ".". */
  relPath(cwd: string): string {
    const root = this.workspace?.root;
    if (root) {
      if (cwd === root) return ".";
      if (cwd.startsWith(`${root}/`)) return cwd.slice(root.length + 1);
    }
    return cwd;
  }

  /** Human label for a `workdir` value: the server default, a sub-folder of it, or an absolute path. */
  workdirLabel(rel: string = this.workdir): string {
    return rel === "."
      ? (this.workspace?.root ?? t("서버 기본 디렉터리"))
      : rel.startsWith("/")
        ? rel
        : `${this.workspace?.root ?? ""}/${rel}`.replace(/^\//, "/");
  }

  /** Absolute path the next new chat will start in (best effort until the server confirms). */
  get workdirAbs(): string {
    const root = this.workspace?.root ?? "";
    return this.workdir === "."
      ? root
      : this.workdir.startsWith("/")
        ? this.workdir
        : `${root}/${this.workdir}`;
  }

  /** Switch one agent tool on or off for every chat. Saved on the server. */
  async setToolEnabled(name: string, enabled: boolean): Promise<boolean> {
    if (!this.api || !this.toolsInfo) return false;
    const before = this.toolsInfo;
    const disabled = enabled ? before.disabled.filter((n) => n !== name) : [...new Set([...before.disabled, name])];
    this.toolsInfo = { ...before, disabled };
    try {
      this.toolsInfo = await this.api.setDisabledTools(disabled);
      return true;
    } catch (e) {
      this.toolsInfo = before;
      this.fail(e, t("변경하지 못했습니다"), this.activeId);
      return false;
    }
  }

  /** Save the server-wide default working directory (null restores the startup default). */
  async setDefaultWorkdir(path: string | null): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.workdirInfo = await this.api.setDefaultWorkdir(path);
      await this.refreshWorkspace();
      this.toast(
        path
          ? t("기본 작업 디렉터리를 저장했습니다")
          : t("기본 작업 디렉터리를 처음 설정으로 되돌렸습니다"),
        "ok",
      );
      return true;
    } catch (e) {
      this.fail(e, t("저장하지 못했습니다"));
      return false;
    }
  }

  setWorkdir(path: string) {
    this.workdir = path || ".";
    write(`${K.workdir}.${this.serverId}`, this.workdir);
  }

  /** `key`: a server id, or `<serverId>\u0000<workdir>` */
  /** Starred models that still exist, in the order they were starred (the picker's order, and the quick-switch slots). */
  get favModelList(): ModelInfo[] {
    return this.favModels
      .map((k) => this.models.find((m) => `${m.provider}\u0000${m.id}` === k))
      .filter((m): m is ModelInfo => !!m);
  }
  isFavModel(provider: string, id: string) {
    return this.favModels.includes(`${provider}\u0000${id}`);
  }
  toggleFavModel(provider: string, id: string) {
    const k = `${provider}\u0000${id}`;
    this.favModels = this.favModels.includes(k)
      ? this.favModels.filter((x) => x !== k)
      : [...this.favModels, k];
    if (this.serverId) write(`${K.favModels}.${this.serverId}`, this.favModels);
    this.settingsSync?.changed("favModels");
  }

  isFavDir(path: string) {
    return this.favDirs.includes(path);
  }
  toggleFavDir(path: string) {
    this.favDirs = this.favDirs.includes(path) ? this.favDirs.filter((x) => x !== path) : [...this.favDirs, path];
    if (this.serverId) write(`${K.favDirs}.${this.serverId}`, this.favDirs);
    this.settingsSync?.changed("favDirs");
  }
  private loadFavDirs(serverId: string): string[] {
    const list = read<unknown>(`${K.favDirs}.${serverId}`, []);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, 100) : [];
  }

  private loadEscalate(serverId: string): number {
    const v = read<unknown>(`${K.escalate}.${serverId}`, null);
    return typeof v === "number" && (ESCALATE_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_ESCALATE;
  }

  /** This server's starred models. */
  private loadFavModels(serverId: string): string[] {
    const list = read<unknown>(`${K.favModels}.${serverId}`, []);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
  }

  /* ---------- settings that belong to the open server ---------- */

  private settingsSync: ServerSettingsSync | null = null;
  /** The server whose extension list is currently loaded */
  private openedFor: string | null = null;
  listChanged() {
    this.settingsSync?.changed("extensions");
  }
  statesChanged() {
    this.settingsSync?.changed("extensionStates");
  }

  /** (Re)start syncing the open server's shared settings. Never throws: an unreachable server just keeps the local copy. */
  private startSettingsSync(api: Api, serverId: string) {
    this.settingsSync?.dispose();
    const favKey = `${K.favModels}.${serverId}`;
    const favDirKey = `${K.favDirs}.${serverId}`;
    const escKey = `${K.escalate}.${serverId}`;
    const sync = new ServerSettingsSync({
      api,
      origin: notifications.id,
      storage: localStorage,
      storageKey: `pipaya.settings-sync.${serverId}`,
      adapters: {
        favModels: {
          // undefined = this device has never had a list for this server, so there is nothing to offer yet
          read: () => (localStorage.getItem(favKey) !== null || this.favModels.length ? this.favModels : undefined),
          apply: (v) => {
            this.favModels = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
            write(favKey, this.favModels);
          },
        },
        favDirs: {
          read: () => (localStorage.getItem(favDirKey) !== null || this.favDirs.length ? this.favDirs : undefined),
          apply: (v) => {
            this.favDirs = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : [];
            write(favDirKey, this.favDirs);
          },
        },
        extensions: {
          read: () => extensions.packages(),
          apply: (v) => extensions.applyPackages(v),
        },
        extensionStates: {
          read: () => extensions.states(),
          apply: (v) => extensions.applyStates(v),
        },
        notificationPolicy: {
          // only offer what the user actually chose on this device; otherwise the server's value (or its default) stands
          read: () => (localStorage.getItem(escKey) !== null ? { escalateMinutes: this.escalateMinutes } : undefined),
          apply: (v) => {
            const m = (v as { escalateMinutes?: unknown } | null)?.escalateMinutes;
            if (typeof m === "number" && (ESCALATE_CHOICES as readonly number[]).includes(m)) {
              this.escalateMinutes = m;
              write(escKey, m);
            }
          },
        },
      },
    });
    this.settingsSync = sync;
    void sync.pull().catch(() => {});
  }

  /** Hand-set directory order of the open server (empty = by recent activity). */
  get currentDirOrder(): string[] {
    return (this.serverId && this.sidebar.dirOrder[this.serverId]) || [];
  }

  /** Hand-set tab order of the open server (empty = the order they were made in). */
  get currentTabOrder(): string[] {
    return (this.serverId && this.sidebar.tabOrder[this.serverId]) || [];
  }

  /** The open server's working directories and their tabs, in sidebar order. */
  get dirs(): DirBlock[] {
    return sidebarDirs(this.sessions, this.groups, this.terminals, { dirOrder: this.currentDirOrder, tabOrder: this.currentTabOrder, groupDir: this.serverId ? this.sidebar.groupDir[this.serverId] : undefined }, this.browsers);
  }

  /** The tab the focused pane is in, and its directory. */
  get activeTab(): { dir: DirBlock; tab: Tab } | null {
    return tabOf(this.dirs, this.activeId);
  }

  /** The pane last focused in each tab (by tab id), so switching back to a group lands where it was left. */
  private lastPane: Record<string, string> = {};

  /**
   * The tabs `from` (as listed in `before`) became `to`: put `to` where the first of them was, in that directory, and
   * remember the directory's order so it stays that way.
   */
  private replaceTabs(before: DirBlock[], from: string[], to: string[]) {
    if (!this.serverId) return;
    for (const d of before) {
      const ids = d.tabs.map((x) => x.id);
      const at = ids.findIndex((x) => from.includes(x));
      if (at < 0) continue;
      const list = ids.filter((x) => !from.includes(x) && !to.includes(x));
      list.splice(Math.min(at, list.length), 0, ...to);
      this.sidebar.placeTabs(this.serverId, list);
      return;
    }
  }

  /** The tab last open in each folder (by `server\0path`), so a folder button lands where that folder was left. */
  private lastTabIn: Record<string, string> = {};

  /** Show a folder: the tab last used in it, else its first one. `serverId` other than the open one switches server. */
  openDir(serverId: string, path: string) {
    const ov = serverId === this.serverId ? null : this.links[serverId]?.data;
    const dirs = ov
      ? sidebarDirs(ov.sessions, ov.groups, ov.terminals, { dirOrder: this.sidebar.dirOrder[serverId], tabOrder: this.sidebar.tabOrder[serverId], groupDir: this.sidebar.groupDir[serverId] }, ov.browsers)
      : this.dirs;
    const dir = dirs.find((d) => d.path === path);
    if (!dir) return;
    const last = dir.tabs.find((x) => x.id === this.lastTabIn[`${serverId}\u0000${path}`]);
    const tab = last ?? dir.tabs[0];
    if (!tab) return;
    if (!ov) return this.openTab(tab.id);
    const pane = tab.kind === "group" ? tabPanes(tab)[0] : tab.id;
    if (pane) void this.openIn(serverId, { session: pane });
  }

  /** Show tab `id` (a group, session or terminal id): a group focuses the pane last used in it. */
  openTab(id: string) {
    const g = this.groups.find((x) => x.id === id);
    if (!g) return void this.openSession(id);
    const panes = panesOf(g.layout).filter((x) => this.shows(x));
    const last = this.lastPane[id];
    const to = last && panes.includes(last) ? last : panes[0];
    if (to) void this.openSession(to);
  }

  async refreshWorkspace() {
    await this.link?.refreshWorkspace();
  }

  /**
   * Move to another working directory (a path under the workspace root, created on first use).
   * An open chat keeps its own directory, so this leaves it and starts a fresh chat there.
   */
  changeWorkdir(raw: string): boolean {
    let rel = expandHome(raw.trim(), this.workspace?.home).replace(/\/+$/, "") || ".";
    if (rel === "~" || rel.startsWith("~/")) {
      this.toast(t("홈 디렉터리를 알 수 없어 ~를 쓸 수 없습니다"), "error");
      return false;
    }
    if (/[\0\\]/.test(rel)) {
      this.toast(t("경로에 사용할 수 없는 문자가 있습니다"), "error");
      return false;
    }
    // An absolute path inside the default directory is stored relative to it, so the sidebar groups it with the rest.
    if (rel.startsWith("/")) rel = this.relPath(rel);
    else rel = rel.replace(/^(\.\/)+/, "") || ".";
    if (
      !rel.startsWith("/") &&
      rel.split("/").some((seg) => seg === ".." || seg === "")
    ) {
      this.toast(
        t("상대 경로에는 ..을 쓸 수 없습니다. 절대 경로(/로 시작)를 입력하세요"),
        "error",
      );
      return false;
    }
    const same = this.current && this.relPath(this.current.cwd) === rel;
    this.setWorkdir(rel);
    if (same) return true;
    const cur = this.current;
    if (cur && !this.groupOf(cur.id) && this.chats[cur.id]?.items.length === 0) {
      // An empty session made by "new chat" moves to the new folder: start one there and close the empty one.
      void this.startChat().then(() => {
        if (this.activeId !== cur.id) void this.close(cur.id);
      });
    } else this.newChat();
    return true;
  }

  /* ---------- close / resume ---------- */

  /** Hide a session from the sidebar (stopping any run). Its history stays on the server; /resume reopens it. */
  async close(id: string) {
    if (!this.api) return;
    const next = this.neighbourOf(id);
    try {
      await this.api.patchSession(id, { closed: true });
      this.forgetInGroups(id);
      this.sessions = this.sessions.filter((x) => x.id !== id);
      this.running[id] = false;
      this.awaiting[id] = 0;
      delete this.unread[id];
      if (this.activeId === id) this.leave(next);
      void this.refreshWorkspace();
    } catch (e) {
      this.fail(e, t("닫지 못했습니다"));
    }
  }

  /* ---------- archive ---------- */

  /** The connection of any saved server (every one is live). */
  private apiFor(serverId: string): Api | null {
    return this.links[serverId]?.api ?? null;
  }

  /** Tuck a session into the archive: it leaves the tabs but stays open, and a new message brings it back. */
  async archive(id: string) {
    if (!this.api) return;
    const next = this.neighbourOf(id);
    try {
      const s = await this.api.patchSession(id, { archived: true });
      this.forgetInGroups(id);
      this.sessions = this.sessions.filter((x) => x.id !== id);
      this.archived = [s, ...this.archived.filter((x) => x.id !== id)];
      if (this.activeId === id) this.leave(next);
    } catch (e) {
      this.fail(e, t("보관하지 못했습니다"), id);
    }
  }

  /** Bring an archived session of `serverId` back to its folder; `open` also shows it. */
  async unarchive(serverId: string, id: string, open = false) {
    const api = this.apiFor(serverId);
    if (!api) return;
    try {
      const s = await api.patchSession(id, { archived: false });
      if (serverId === this.serverId) {
        this.archived = this.archived.filter((x) => x.id !== id);
        this.sessions = [s, ...this.sessions.filter((x) => x.id !== id)];
      }
      if (open) this.openIn(serverId, { session: id });
    } catch (e) {
      this.fail(e, t("복원하지 못했습니다"));
    }
  }

  /** Delete an archived session of `serverId` for good. */
  async deleteArchived(serverId: string, id: string) {
    const api = this.apiFor(serverId);
    if (!api) return;
    try {
      await api.deleteSession(id);
      if (serverId === this.serverId) this.archived = this.archived.filter((x) => x.id !== id);
      this.toast(t("대화를 영구 삭제했습니다"));
    } catch (e) {
      this.fail(e, t("삭제하지 못했습니다"));
    }
  }

  /**
   * The session that should take focus when `id` goes away. In a group: the next pane of that group, or the previous
   * when it was last. Otherwise (or when it was alone in its group): the next session in sidebar order, or the previous
   * when it was last. Undefined when nothing else is open. Call it before `id` leaves the list.
   */
  private neighbourOf(id: string): string | undefined {
    const g = this.groupOf(id);
    if (g) {
      const ids = panesOf(g.layout).filter((x) => this.shows(x));
      const i = ids.indexOf(id);
      const inGroup = i < 0 ? undefined : (ids[i + 1] ?? ids[i - 1]);
      if (inGroup) return inGroup;
    }
    // the next tab of the same folder (the previous when it was last): closing never carries you off to another folder
    const at = this.activeTabOf(id);
    if (at) {
      const i = at.dir.tabs.findIndex((x) => x.id === at.tab.id);
      const sib = at.dir.tabs[i + 1] ?? at.dir.tabs[i - 1];
      const pane = sib && (this.lastPane[sib.id] && this.shows(this.lastPane[sib.id]) ? this.lastPane[sib.id] : tabPanes(sib)[0]);
      if (pane) return pane;
    }
    const order = sessionOrder(this.sessions, this.groups, this.currentDirOrder, this.currentTabOrder, this.terminals, this.browsers);
    const i = order.indexOf(id);
    return i < 0 ? undefined : (order[i + 1] ?? order[i - 1]);
  }

  private activeTabOf(id: string) {
    return tabOf(this.dirs, id);
  }

  /**
   * A session left (closed or deleted): take it out of its group right away, and dissolve the group when a single
   * session is left. The server does the same and says so with a group event; doing it here too means the survivor
   * is a plain session at once, not a one-pane group until that event arrives.
   */
  private forgetInGroups(id: string) {
    const g = this.groupOf(id);
    if (!g) return;
    const next = layoutRemove(g.layout, id);
    if (worthKeeping(next)) {
      const i = this.groups.findIndex((x) => x.id === g.id);
      if (i >= 0) this.groups[i] = { ...g, layout: next };
    } else {
      this.groups = this.groups.filter((x) => x.id !== g.id);
    }
  }

  /** The focused session is gone: focus its neighbour (see `neighbourOf`) if there is one, else fall back to a blank chat. */
  private leave(next?: string) {
    if (next && this.shows(next)) void this.openSession(next);
    else this.newChat();
  }

  /** Close the focused session (focus moves to a remaining pane of its group, see `close`). */
  async closeActive() {
    if (isTerminalId(this.activeId)) await this.closeTerminal(this.activeId);
    else if (isBrowserId(this.activeId)) await this.closeBrowser(this.activeId);
    else if (this.activeId) await this.close(this.activeId);
  }

  /** Archive the focused chat (a terminal cannot be archived). */
  async archiveActive() {
    if (!this.activeId || isTerminalId(this.activeId) || isBrowserId(this.activeId)) return void this.toast(t("보관할 수 있는 대화가 아닙니다"), "error");
    await this.archive(this.activeId);
  }

  /** Reopen a closed session and show it. */
  async resume(id: string): Promise<boolean> {
    if (!this.api) return false;
    // Resumed from inside a group: the session takes the focused pane's place instead of opening outside the group.
    const from = this.activeId;
    const g = from ? this.groupOf(from) : undefined;
    try {
      const s = await this.api.patchSession(id, { closed: false, archived: false });
      const i = this.sessions.findIndex((x) => x.id === id);
      if (i >= 0) this.sessions.splice(i, 1);
      this.archived = this.archived.filter((x) => x.id !== id);
      this.sessions.unshift(s);
      if (g && from && from !== id && !layoutHas(g.layout, id)) {
        await this.saveLayout(g.id, replaceSession(g.layout, from, id));
        void this.refreshGroups();
      }
      await this.openSession(id, true);
      return true;
    } catch (e) {
      this.fail(e, t("다시 열지 못했습니다"));
      return false;
    }
  }

  /** Open a session whether it is active or closed (closed ones are resumed first). */
  async openAny(id: string) {
    if (this.sessions.some((s) => s.id === id)) await this.openSession(id);
    else await this.resume(id);
  }

  async listClosed(): Promise<Session[]> {
    return this.api
      ? (await this.api.listSessions(200, true)).sessions.filter(
          (s) => s.closed,
        )
      : [];
  }

  /** Every session, active and closed (for /tree). */
  async listAll(): Promise<Session[]> {
    return this.api ? (await this.api.listSessions(200)).sessions : [];
  }

  /* ---------- navigation ---------- */

  newChat() {
    if (this.activeId) this.previousId = this.activeId;
    this.activeId = null;
    try {
      localStorage.removeItem(this.activeKey);
    } catch {
      /* ignore */
    }
    this.sidebar.open = false;
    // A new chat starts from the server default, not from a model picked in an earlier new chat.
    const d = this.serverDefault;
    if (d && this.models.some((m) => m.provider === d.provider && m.id === d.model && m.configured && m.available !== false))
      this.updateDraft(draftFromDefault(d));
  }

  /**
   * Start a new chat as a real session: it is created at once from the draft (pending model settings and working
   * directory) and shows up in the sidebar as an active "New session" right away. Without a usable model, or if the
   * server refuses, it falls back to the blank new-chat screen. Every call creates a fresh session, even if an
   * empty one is already open.
   */
  async startChat(): Promise<void> {
    const api = this.api;
    const d = this.draft;
    if (!api || !d.model) return this.newChat();
    const cwd = this.workdir === "." ? undefined : this.workdir;
    try {
      const s = await api.createSession({
        cwd,
        provider: d.provider,
        model: d.model,
        thinkingLevel: normalizeThinking(d.thinkingLevel),
      });
      if (!this.sessions.some((x) => x.id === s.id)) this.sessions.unshift(s);
      await this.openSession(s.id, true);
    } catch (e) {
      this.fail(e, t("새 대화를 만들지 못했습니다"));
    }
  }

  /**
   * `/new`: start a fresh conversation in the focused pane only. Inside a group the pane's session is swapped for a new
   * one (same working directory and model settings) and the rest of the group stays as it is; the old session is closed
   * (off the sidebar, reachable only through /resume). Outside a group this is a plain `newChat`.
   */
  async newChatInPane(): Promise<void> {
    const api = this.api;
    const from = this.session(this.activeId);
    const g = from && this.groupOf(from.id);
    if (!api || !from || !g) return this.startChat();
    let made: Session;
    try {
      made = await api.createSession({
        cwd: from.cwd,
        provider: from.provider,
        model: from.model,
        thinkingLevel: from.thinkingLevel,
      });
    } catch (e) {
      return this.fail(e, t("새 대화를 만들지 못했습니다"));
    }
    if (!this.sessions.some((x) => x.id === made.id)) this.sessions.unshift(made);
    // Swap layout and focus in the same tick, and only then close the old session: the screen never passes through a
    // state where the focused session is gone or outside its group (that made the whole app flash).
    const saving = this.saveLayout(g.id, replaceSession(g.layout, from.id, made.id));
    const opening = this.openSession(made.id);
    await Promise.all([saving, opening]);
    void this.refreshGroups(); // the server is the authority on who is in which group
    // The replaced session leaves the active list instead of dropping out of the group as a loose session.
    try {
      await api.patchSession(from.id, { closed: true });
      this.sessions = this.sessions.filter((x) => x.id !== from.id);
      this.running[from.id] = false;
      this.awaiting[from.id] = 0;
      delete this.unread[from.id];
    } catch (e) {
      this.fail(e, t("닫지 못했습니다"));
    }
  }

  /** Focus a session (showing its group if it has one). */
  async openSession(id: string, force = false) {
    if (!this.api) return;
    if (!force && this.activeId === id && (this.chats[id] || isTerminalId(id) || isBrowserId(id))) {
      this.sidebar.open = false;
      return;
    }
    if (this.activeId && this.activeId !== id) this.previousId = this.activeId;
    this.activeId = id;
    write(this.activeKey, id);
    const g = this.groupOf(id);
    if (g) this.lastPane[g.id] = id;
    const at = this.serverId ? tabOf(this.dirs, id) : null;
    if (at && this.serverId) this.lastTabIn[`${this.serverId}\u0000${at.dir.path}`] = at.tab.id;
    delete this.unread[id];
    delete this.failed[id];
    notifications.read(id);
    const cwd = this.sessions.find((s) => s.id === id)?.cwd ?? this.terminal(id)?.cwd ?? this.browser(id)?.cwd;
    if (cwd) this.setWorkdir(this.relPath(cwd));
    this.sidebar.open = false;
    if (isTerminalId(id) || isBrowserId(id)) return;
    await this.ensureChat(id, force);
  }

  /** Make sure a session's transcript is loaded. `fresh` reloads it from the server. */
  async ensureChat(id: string, fresh = false): Promise<void> {
    const api = this.api;
    if (!api) return;
    if (this.chats[id] && !fresh) return;
    const chat = new ChatState(id, api);
    this.chats = { ...this.chats, [id]: chat };
    await chat.load();
    if (this.chats[id] !== chat) return;
    if (chat.notFound) {
      const { [id]: _gone, ...rest } = this.chats;
      this.chats = rest;
      if (this.activeId === id) this.newChat();
      return;
    }
    this.awaiting[id] = Object.values(chat.tools).filter(
      (t) => t.state === "awaiting_input",
    ).length;
  }

  /**
   * Keep exactly the visible sessions' transcripts loaded (called whenever what is on screen changes).
   * Focusing a session counts as having seen what it finished; the other panes of its group keep their mark.
   */
  syncChats(ids: string[]) {
    const keep = new Set(ids);
    const stale = Object.keys(this.chats).filter((id) => !keep.has(id));
    if (stale.length) {
      const next = { ...this.chats };
      for (const id of stale) delete next[id];
      this.chats = next;
    }
    for (const id of ids) {
      if (id === this.activeId) {
        delete this.unread[id];
        delete this.failed[id];
      }
      if (!this.chats[id]) void this.ensureChat(id);
    }
  }

  /**
   * The user is looking at the window and touched it (came back to it, or clicked anywhere): what finished on the
   * focused session counts as read. Finishing while the window was hidden leaves the mark until now.
   * Other panes of the group are read by focusing them.
   */
  markSeen() {
    const id = this.activeId;
    if (!id || !this.attended()) return;
    if (!this.unread[id] && !this.failed[id]) return;
    delete this.unread[id];
    delete this.failed[id];
    notifications.read(id);
  }

  /* ---------- commands ---------- */

  /** `sid`: the session the message is about, so it appears inside that session's pane (see SessionToasts). */
  toast(text: string, tone: Toast["tone"] = "info", sid?: string | null) {
    this.feedback.toast(text, tone, sid);
  }

  private fail(e: unknown, prefix?: string, sid?: string | null) {
    const reason = errorText(e);
    this.toast(prefix ? `${prefix}: ${reason}` : reason, "error", sid);
  }

  /** Toasts shown as a global strip: not about a session, or about one that is not on screen right now. */
  get globalToasts(): Toast[] {
    return this.feedback.global(this.shownIds);
  }
  /** Toasts shown inside the pane of session `id`. */
  toastsOf(id: string | null): Toast[] {
    return this.feedback.of(id, this.shownIds);
  }

  /** `to`: the session to send to (a pane's own); omitted = the focused one. null starts a new chat. */
  async send(
    text: string,
    images: ImageBlock[] = [],
    to: string | null = this.activeId,
    files: UploadFile[] = [],
  ): Promise<boolean> {
    const api = this.api;
    if (!api || this.sending) return false;
    text = text.trim();
    if (!text && !images.length && !files.length) return false;
    if (!text) text = files.length && !images.length ? t("(첨부한 파일을 봐 주세요)") : t("(첨부한 이미지를 봐 주세요)");
    this.sending = true;
    let seeded = false;
    try {
      if (!to) {
        const d = this.draft;
        if (!d.model) {
          this.toast(
            t("사용할 수 있는 모델이 없습니다. 모델 선택창에서 연결을 추가하세요."),
            "error",
          );
          return false;
        }
        const s = await api.createSession({
          cwd: this.workdir === "." ? undefined : this.workdir,
          provider: d.provider,
          model: d.model,
          thinkingLevel: normalizeThinking(d.thinkingLevel),
        });
        if (!this.sessions.some((x) => x.id === s.id)) this.sessions.unshift(s);
        // Load the new chat off-screen and put the prompt in it first, so the pane goes from the welcome screen
        // straight to the sent message instead of flashing a skeleton and an empty transcript in between.
        const fresh = new ChatState(s.id, api);
        await fresh.load();
        if (!fresh.ready) throw new Error(fresh.loadError || t("불러오지 못했습니다"));
        fresh.addOptimisticUser(text, images, files.map((f) => ({ path: "", name: f.name, size: f.size, mimeType: f.mimeType })));
        this.chats = { ...this.chats, [s.id]: fresh };
        await this.openSession(s.id);
        to = s.id;
        seeded = true;
      }
      const chat = this.chatOf(to);
      if (!chat) return false;

      // During a compaction the model context is being rewritten: wait in the queue and go out right after it.
      if (chat.compacting && !chat.running) {
        chat.held.push({ text, images, files });
        chat.requestBottom();
        return true;
      }

      const mode: SendMode = chat.running ? "follow_up" : "prompt";
      if (mode === "prompt" && !seeded) chat.addOptimisticUser(text, images, files.map((f) => ({ path: "", name: f.name, size: f.size, mimeType: f.mimeType })));
      chat.requestBottom();
      try {
        await api.send(chat.id, text, mode, images.length ? images : undefined, files.length ? files : undefined);
      } catch (e) {
        if (mode === "prompt") chat.dropOptimisticUser();
        throw e;
      }
      return true;
    } catch (e) {
      this.fail(e, t("보내지 못했습니다"), to);
      return false;
    } finally {
      this.sending = false;
    }
  }

  /** Send what was held during a compaction: the first starts the run, the rest queue behind it. */
  private async flushHeld(chat: ChatState): Promise<void> {
    if (chat.compacting || !chat.held.length) return;
    const list = chat.held.splice(0);
    for (const [i, h] of list.entries()) {
      const ok = i === 0 ? await this.send(h.text, h.images, chat.id, h.files) : await this.queue(h.text, h.images, chat.id, h.files);
      if (!ok) break;
    }
  }

  /**
   * Send while a run is active. `steer` is delivered after the current tool calls finish and before the next
   * model call; `follow_up` waits until the whole run is done. If the run ended a moment ago the server answers
   * 409, in which case the text simply starts a new run.
   */
  private async during(
    mode: "steer" | "follow_up",
    text: string,
    images: ImageBlock[],
    failMsg: string,
    to: string | null,
    files: UploadFile[] = [],
  ): Promise<boolean> {
    const chat = this.chatOf(to);
    const api = this.api;
    text = text.trim();
    if (!api || !chat || (!text && !images.length && !files.length)) return false;
    if (!text) text = files.length && !images.length ? t("(첨부한 파일을 봐 주세요)") : t("(첨부한 이미지를 봐 주세요)");
    chat.requestBottom();
    try {
      await api.send(chat.id, text, mode, images.length ? images : undefined, files.length ? files : undefined);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409)
        return this.send(text, images, to, files);
      this.fail(e, failMsg, chat.id);
      return false;
    }
  }

  steer = (text: string, images: ImageBlock[] = [], to = this.activeId, files: UploadFile[] = []) =>
    this.during("steer", text, images, t("끼워 넣지 못했습니다"), to, files);
  queue = (text: string, images: ImageBlock[] = [], to = this.activeId, files: UploadFile[] = []) =>
    this.during("follow_up", text, images, t("대기열에 추가하지 못했습니다"), to, files);

  /** Open a file preview (null = closed) */
  filePreview = $state<{ sessionId: string; file: FileRef } | null>(null);
  openFile(sessionId: string, file: FileRef) {
    this.filePreview = { sessionId, file };
  }

  /** Bumped when the server (re)loads its extensions, so lists that come from them are read again. */
  serverExtensionsTick = $state(0);
  /** Commands and tools that extensions inside the server provide; refreshed when the server (re)loads them. */
  serverCommands = $state<{ name: string; description?: string; args?: string; extension: string }[]>([]);
  async refreshServerExtensions() {
    const api = this.api;
    if (!api) return;
    try {
      const [list, tools] = await Promise.all([api.serverExtensions(), api.tools()]);
      if (api !== this.api) return;
      this.serverCommands = list.commands;
      if (this.link) this.link.tools = tools.tools;
    } catch { /* unreachable: nothing to show */ }
  }

  /** Modal question asked by an extension (`sdk.dialog`). One at a time; a second request waits its turn. */
  extensionDialog = $state<{ request: import("./extensions/host.svelte").ExtensionDialogRequest; resolve(value: unknown): void } | null>(null);
  private dialogQueue: Promise<unknown> = Promise.resolve();
  askExtension(request: import("./extensions/host.svelte").ExtensionDialogRequest): Promise<unknown> {
    const run = () => new Promise<unknown>(resolve => { this.extensionDialog = { request, resolve }; });
    const next = this.dialogQueue.then(run, run);
    this.dialogQueue = next.catch(() => {});
    return next;
  }
  resolveExtensionDialog(value: unknown) {
    const pending = this.extensionDialog; this.extensionDialog = null; pending?.resolve(value);
  }

  /** Queue manager dialog: the session whose queued messages are listed. null = closed. */
  queueDialog = $state<string | null>(null);
  openQueue(id: string | null = this.activeId) {
    if (!id || !this.chatOf(id)?.waiting.length) return void this.toast(t("취소할 대기열이 없습니다"), "error", id);
    this.queueDialog = id;
  }

  /** Remove one not-yet-delivered steer/queue message. The chat list updates from the `message_dequeued` event. */
  async cancelQueued(item: { mode: "steer" | "follow_up"; text: string }, id: string | null = this.queueDialog): Promise<void> {
    const chat = this.chatOf(id);
    if (!this.api || !chat) return;
    const h = item.mode === "follow_up" ? chat.held.findIndex((x) => x.text === item.text) : -1;
    if (h >= 0) {
      chat.held.splice(h, 1);
      if (chat.id === this.activeId) this.prefill = item.text;
      return;
    }
    try {
      const r = await this.api.cancelQueued(chat.id, item.mode, item.text);
      if (!r.cancelled) {
        // Already delivered (or gone): drop the stale row so the list matches the server.
        const i = chat.queued.findIndex((x) => x.mode === item.mode && x.text === item.text);
        if (i >= 0) chat.queued.splice(i, 1);
        this.toast(t("이미 전달되어 취소할 수 없습니다"), "error", chat.id);
      } else if (chat.id === this.activeId) {
        // Cancelled in time: hand the text back to the input so it can be edited or re-sent.
        this.prefill = item.text;
      }
    } catch (e) {
      if ((e as { code?: string })?.code === "not_found") {
        // Session or route is gone on the server: the row can never be cancelled, so drop it.
        const i = chat.queued.findIndex((x) => x.mode === item.mode && x.text === item.text);
        if (i >= 0) chat.queued.splice(i, 1);
      }
      this.fail(e, t("대기열에서 빼지 못했습니다"), chat.id);
    }
  }

  async abort(id: string | null = this.activeId) {
    if (!this.api || !id) return;
    try {
      await this.api.abort(id);
    } catch (e) {
      this.fail(e, undefined, id);
    }
  }

  async compact(customInstructions?: string, id = this.activeId): Promise<boolean> {
    const chat = this.chatOf(id);
    const api = this.api;
    if (!chat || !api || this.net !== "online") {
      this.toast(t("서버에 연결하고 압축할 대화를 여세요"), "error", id);
      return false;
    }
    if (!chat.ready || chat.loadError || this.sending || chat.running || chat.compacting) {
      this.toast(t("진행 중인 작업이 끝난 뒤 압축하세요"), "error", id);
      return false;
    }
    if (chat.compaction?.supported === false) {
      this.toast(t("이 서버는 컨텍스트 압축을 지원하지 않습니다. BE 연동이 필요합니다"), "error", id);
      return false;
    }
    try {
      // The progress and the result are shown inside that session's transcript (see ChatState.compact), not as a toast.
      await chat.compact(customInstructions);
      if (this.chats[chat.id] === chat && this.api === api) void this.refreshUsage(chat);
      return true;
    } catch {
      return false;
    } finally {
      void this.flushHeld(chat);
    }
  }

  async retry(id = this.activeId) {
    const chat = this.chatOf(id);
    if (!this.api || !chat || chat.compacting) return;
    try {
      await this.api.retry(chat.id);
    } catch (e) {
      this.fail(e, t("다시 시도하지 못했습니다"), chat.id);
    }
  }

  async answerQuestion(toolCallId: string, answer: string | string[], id = this.activeId) {
    const chat = this.chatOf(id);
    if (!this.api || !chat) return;
    try {
      await this.api.answer(chat.id, toolCallId, answer);
    } catch (e) {
      this.fail(e, t("답변을 보내지 못했습니다"), chat.id);
      void chat.load();
    }
  }

  async rename(id: string, title: string) {
    title = title.trim();
    if (!this.api || !title) return;
    try {
      const s = await this.api.patchSession(id, { title });
      const i = this.sessions.findIndex((x) => x.id === id);
      if (i >= 0) this.sessions[i] = s;
    } catch (e) {
      this.fail(e, t("이름을 바꾸지 못했습니다"), id);
    }
  }

  async remove(id: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      const next = this.neighbourOf(id);
      await this.api.deleteSession(id);
      this.forgetInGroups(id);
      this.sessions = this.sessions.filter((x) => x.id !== id);
      if (this.activeId === id) this.leave(next);
      void this.refreshWorkspace();
      return true;
    } catch (e) {
      this.fail(e, t("삭제하지 못했습니다"), id);
      return false;
    }
  }

  /* ---------- groups ---------- */

  /** Show a new layout at once, then save it; the server's answer (or a refetch on failure) is what stays. */
  async saveLayout(id: string, layout: Layout, persist = true): Promise<void> {
    const i = this.groups.findIndex((g) => g.id === id);
    if (i < 0 || !this.api) return;
    this.groups[i] = { ...this.groups[i]!, layout };
    if (!persist) return;
    try {
      const g = await this.api.patchGroup(id, { layout });
      const j = this.groups.findIndex((x) => x.id === id);
      if (j >= 0) this.groups[j] = g;
    } catch (e) {
      this.fail(e, t("그룹을 저장하지 못했습니다"));
      void this.refreshGroups();
    }
  }

  async refreshGroups(): Promise<void> {
    if (!this.api) return;
    try {
      this.groups = await this.api.groups();
    } catch {
      /* the next sync retries */
    }
  }

  /**
   * Drop session `id` on a side of the pane showing `target`. If `target` is in a group the layout changes there;
   * otherwise the two sessions become a new group on the spot. A session is in one group only, so dropping moves it.
   */
  async dropSession(id: string, target: string, zone: Zone, focus = true): Promise<void> {
    if (!this.api || id === target) return;
    const g = this.groupOf(target);
    if (g) {
      if (!layoutHas(g.layout, id) && panesOf(g.layout).length >= MAX_PANES)
        return void this.toast(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }), "error");
      const next = place(g.layout, id, target, zone);
      if (next) await this.saveLayout(g.id, next);
    } else {
      await this.createGroup(pair(target, id, zone));
    }
    void this.refreshGroups(); // the session may have left another group, which can have dissolved
    if (focus) void this.openSession(id);
  }

  /**
   * Split pane `target` with a brand-new conversation (same folder and model settings) on `zone`'s side and return its
   * id, or null when it could not be made. `focus: false` leaves the focus where it is (for programmatic callers).
   */
  async splitPane(target: string, zone: Zone, focus = true): Promise<string | null> {
    const api = this.api;
    const from = this.session(target) ?? this.terminal(target) ?? this.browser(target);
    if (!api || !from) return null;
    const g = this.groupOf(target);
    if (g && panesOf(g.layout).length >= MAX_PANES) {
      this.toast(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }), "error");
      return null;
    }
    const base = this.session(target);
    const d = this.draft;
    if (!base && !d.model) {
      this.toast(t("사용할 수 있는 모델이 없습니다. 모델 선택창에서 연결을 추가하세요."), "error");
      return null;
    }
    try {
      const made = await api.createSession({
        cwd: from.cwd,
        provider: base?.provider ?? d.provider,
        model: base?.model ?? d.model,
        thinkingLevel: base?.thinkingLevel ?? normalizeThinking(d.thinkingLevel),
      });
      if (!this.sessions.some((x) => x.id === made.id)) this.sessions.unshift(made);
      await this.dropSession(made.id, target, zone, focus);
      return made.id;
    } catch (e) {
      this.fail(e, t("새 대화를 만들지 못했습니다"));
      return null;
    }
  }

  /**
   * Split the focused pane: a brand-new conversation appears on `zone`'s side of it and the two are grouped
   * (or the group grows). The newcomer starts in the focused session's working directory and, being a new
   * chat, with the same model settings; it takes focus.
   */
  async splitActive(zone: Zone): Promise<void> {
    const api = this.api;
    if (!api) return;
    const term = this.terminal(this.activeId);
    if (term) return this.splitWithNewChat(term.id, term.cwd, zone);
    const web = this.browser(this.activeId);
    if (web) return this.splitWithNewChat(web.id, web.cwd, zone);
    let from = this.session(this.activeId);
    // A new chat has no session yet: make one from the draft (the pending model settings and working directory)
    // so there is something to split. Both halves then start empty and ready for input.
    if (!from) {
      const d = this.draft;
      if (!d.model)
        return void this.toast(
          t("사용할 수 있는 모델이 없습니다. 모델 선택창에서 연결을 추가하세요."),
          "error",
        );
      try {
        from = await api.createSession({
          cwd: this.workdir === "." ? undefined : this.workdir,
          provider: d.provider,
          model: d.model,
          thinkingLevel: normalizeThinking(d.thinkingLevel),
        });
      } catch (e) {
        return this.fail(e, t("새 대화를 만들지 못했습니다"));
      }
      if (!this.sessions.some((x) => x.id === from!.id)) this.sessions.unshift(from);
    }
    const g = this.groupOf(from.id);
    if (g && panesOf(g.layout).length >= MAX_PANES)
      return void this.toast(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }), "error");
    let made: Session;
    try {
      made = await api.createSession({
        cwd: from.cwd,
        provider: from.provider,
        model: from.model,
        thinkingLevel: from.thinkingLevel,
      });
    } catch (e) {
      return this.fail(e, t("새 대화를 만들지 못했습니다"));
    }
    if (!this.sessions.some((x) => x.id === made.id)) this.sessions.unshift(made);
    await this.dropSession(made.id, from.id, zone);
  }

  /**
   * Pull session `id` toward `other` in the sidebar: they join `other`'s group, or become a group of their own.
   * Groups are made this way, one drag at a time, rather than created empty and filled.
   */
  async groupWith(id: string, other: string): Promise<void> {
    if (!this.api || id === other) return;
    const g = this.groupOf(other);
    if (g) {
      if (layoutHas(g.layout, id)) return;
      await this.addToGroup(id, g.id);
    } else {
      const made = await this.createGroup(pair(other, id, "right"));
      if (!made) return;
    }
    void this.openSession(id);
  }

  /* ---------- terminals ---------- */

  /**
   * Open a new terminal on the server (its own OS shell) and show it. `workdir`: "." / undefined for the default working
   * directory, else a path. `beside`: put it next to that pane (grouping them) instead of on its own.
   */
  async openTerminal(workdir?: string, beside?: { target: string; zone: Zone; focus?: boolean }): Promise<TerminalInfo | null> {
    const api = this.api;
    if (!api) return null;
    if (this.terminalSupport && !this.terminalSupport.enabled) {
      this.toast(t("이 서버는 터미널이 꺼져 있습니다 (PIPAYA_TERMINAL=0)"), "error");
      return null;
    }
    if (beside) {
      const g = this.groupOf(beside.target);
      if (g && panesOf(g.layout).length >= MAX_PANES) {
        this.toast(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }), "error");
        return null;
      }
    }
    let made: TerminalInfo;
    try {
      made = await api.createTerminal({ cwd: workdir && workdir !== "." ? workdir : undefined });
    } catch (e) {
      if (isUnsupportedRoute(e)) this.toast(t("이 서버는 터미널을 지원하지 않습니다. 서버를 업데이트하세요"), "error");
      else this.fail(e, t("터미널을 열지 못했습니다"));
      return null;
    }
    if (!this.terminals.some((x) => x.id === made.id)) this.terminals.push(made);
    if (beside) await this.dropSession(made.id, beside.target, beside.zone, beside.focus ?? true);
    else await this.openSession(made.id);
    return made;
  }

  /* ---------- browser tabs ---------- */

  /** Open a page in a browser tab on the server and show it. `beside`: put it next to that pane (grouping them). */
  async openBrowser(url?: string, beside?: { target: string; zone: Zone; focus?: boolean }, workdir?: string, profile?: string): Promise<BrowserTabInfo | null> {
    const api = this.api;
    if (!api) return null;
    const support = this.browserSupport;
    if (support && !support.enabled) return void this.toast(t("이 서버는 브라우저가 꺼져 있습니다 (PIPAYA_BROWSER=0)"), "error"), null;
    if (support && !support.available) return void this.toast(t("이 서버에 Chrome 또는 Chromium이 없습니다"), "error"), null;
    if (beside) {
      const g = this.groupOf(beside.target);
      if (g && panesOf(g.layout).length >= MAX_PANES) return void this.toast(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }), "error"), null;
    }
    const from = workdir && workdir !== "." ? workdir : beside ? (this.session(beside.target)?.cwd ?? this.terminal(beside.target)?.cwd ?? this.browser(beside.target)?.cwd) : this.session(this.activeId)?.cwd;
    let made: BrowserTabInfo;
    try {
      made = await api.createBrowser({ ...(url ? { url } : {}), ...(from ? { cwd: from } : {}), ...(profile ? { profile } : {}) });
    } catch (e) {
      if (isUnsupportedRoute(e)) this.toast(t("이 서버는 브라우저를 지원하지 않습니다. 서버를 업데이트하세요"), "error");
      else this.fail(e, t("브라우저를 열지 못했습니다"));
      return null;
    }
    if (!this.browsers.some((x) => x.id === made.id)) this.browsers.push(made);
    if (beside) await this.dropSession(made.id, beside.target, beside.zone, beside.focus ?? true);
    else await this.openSession(made.id);
    return made;
  }

  /** A browser tab beside the focused pane (right by default). */
  async splitBrowser(zone: Zone = "right"): Promise<void> {
    const id = this.activeId;
    if (!id) return void (await this.openBrowser());
    await this.openBrowser(undefined, { target: id, zone });
  }

  /** Close the tab (the server confirms with browser_closed). */
  async closeBrowser(id: string): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.closeBrowser(id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) return this.fail(e, t("브라우저를 닫지 못했습니다"), id);
    }
    this.dropBrowser(id);
  }

  /** The tab is gone (closed here, elsewhere, or the browser ended): forget it and move focus on. */
  dropBrowser(id: string) {
    if (!this.browsers.some((x) => x.id === id)) return;
    const next = this.neighbourOf(id);
    this.forgetInGroups(id);
    this.browsers = this.browsers.filter((x) => x.id !== id);
    if (this.zoomId === id) this.zoomId = null;
    if (this.activeId === id) this.leave(next);
  }

  /** A terminal beside the focused pane: below by default, or the given side: it starts where that pane works. */
  async splitTerminal(zone: Zone = "bottom"): Promise<void> {
    const id = this.activeId;
    const cwd = this.session(id)?.cwd ?? this.terminal(id)?.cwd;
    if (!id || !cwd) return void (await this.openTerminal(this.workdir));
    await this.openTerminal(cwd, { target: id, zone });
  }

  /** Split a terminal pane with a brand-new conversation working in the same folder. */
  private async splitWithNewChat(target: string, cwd: string, zone: Zone): Promise<void> {
    const api = this.api;
    const d = this.draft;
    if (!api) return;
    if (!d.model)
      return void this.toast(t("사용할 수 있는 모델이 없습니다. 모델 선택창에서 연결을 추가하세요."), "error");
    const g = this.groupOf(target);
    if (g && panesOf(g.layout).length >= MAX_PANES)
      return void this.toast(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }), "error");
    try {
      const made = await api.createSession({ cwd, provider: d.provider, model: d.model, thinkingLevel: normalizeThinking(d.thinkingLevel) });
      if (!this.sessions.some((x) => x.id === made.id)) this.sessions.unshift(made);
      await this.dropSession(made.id, target, zone);
    } catch (e) {
      this.fail(e, t("새 대화를 만들지 못했습니다"));
    }
  }

  async renameTerminal(id: string, title: string): Promise<void> {
    title = title.trim();
    if (!this.api || !title) return;
    try {
      const x = await this.api.renameTerminal(id, title);
      const i = this.terminals.findIndex((y) => y.id === id);
      if (i >= 0) this.terminals[i] = x;
    } catch (e) {
      this.fail(e, t("이름을 바꾸지 못했습니다"), id);
    }
  }

  /** End the shell. The terminal leaves its group and the sidebar (the server confirms with terminal_closed). */
  async closeTerminal(id: string): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.closeTerminal(id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) return this.fail(e, t("터미널을 닫지 못했습니다"), id);
    }
    this.dropTerminal(id);
  }

  /** The shell is gone (closed here, elsewhere, or it exited): forget it and move focus on. */
  dropTerminal(id: string) {
    if (!this.terminals.some((x) => x.id === id)) return;
    const next = this.neighbourOf(id);
    this.forgetInGroups(id);
    this.terminals = this.terminals.filter((x) => x.id !== id);
    if (this.zoomId === id) this.zoomId = null;
    if (this.activeId === id) this.leave(next);
  }

  /**
   * Name a new group after its sessions' working folders: `pipaya` when they all share one,
   * `pipaya / pipaya-wiki` when they differ. Falls back to "Group N" when no folder is known.
   */
  private nextGroupName(layout: Layout): string {
    const dirs: string[] = [];
    for (const id of panesOf(layout)) {
      const cwd = this.session(id)?.cwd.replace(/\/+$/, "");
      const dir = cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? "") : "";
      if (dir && !dirs.includes(dir)) dirs.push(dir);
    }
    const taken = new Set(this.groups.map((g) => g.name));
    if (dirs.length) {
      const shown = dirs.length > 3 ? [...dirs.slice(0, 3), `+${dirs.length - 3}`] : dirs;
      const base = shown.join(" / ");
      if (!taken.has(base)) return base;
      for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
    }
    for (let n = 1; ; n++) if (!taken.has(t("그룹 {n}", { n }))) return t("그룹 {n}", { n });
  }

  async createGroup(layout: Layout, name?: string): Promise<Group | null> {
    if (!this.api) return null;
    try {
      // the new group's tab takes the place of the tab the drop landed on (the pane split; `pair` puts it first or second)
      const before = this.dirs;
      const g = await this.api.createGroup({ layout, name: name || this.nextGroupName(layout), ...(name ? {} : { autoName: true }) });
      if (!this.groups.some((x) => x.id === g.id)) this.groups.push(g);
      this.replaceTabs(before, panesOf(layout), [g.id]);
      // the server moved these sessions out of any group they were in
      await this.refreshGroups();
      return g;
    } catch (e) {
      this.fail(e, t("그룹을 만들지 못했습니다"));
      return null;
    }
  }

  /** Put a session into an existing group, beside everything else in it. */
  async addToGroup(id: string, groupId: string): Promise<void> {
    if (!this.api) return;
    const g = this.groups.find((x) => x.id === groupId);
    if (!g || layoutHas(g.layout, id)) return;
    if (panesOf(g.layout).length >= MAX_PANES)
      return void this.toast(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }), "error");
    await this.saveLayout(g.id, append(g.layout, id));
    await this.refreshGroups();
  }

  /** Take a session out of its group; a group left with a single session dissolves. */
  async leaveGroup(id: string): Promise<void> {
    const g = this.groupOf(id);
    if (!g || !this.api) return;
    const next = layoutRemove(g.layout, id);
    if (worthKeeping(next)) await this.saveLayout(g.id, next);
    else await this.deleteGroup(g.id);
  }

  async renameGroup(id: string, name: string): Promise<void> {
    name = name.trim();
    const i = this.groups.findIndex((g) => g.id === id);
    if (!this.api || !name || i < 0 || this.groups[i]!.name === name) return;
    const before = this.groups[i]!.name;
    this.groups[i] = { ...this.groups[i]!, name };
    try {
      const g = await this.api.patchGroup(id, { name });
      const j = this.groups.findIndex((x) => x.id === id);
      if (j >= 0) this.groups[j] = g;
    } catch (e) {
      const j = this.groups.findIndex((x) => x.id === id);
      if (j >= 0) this.groups[j] = { ...this.groups[j]!, name: before };
      this.fail(e, t("그룹 이름을 바꾸지 못했습니다"));
    }
  }

  /** Dissolve a group. Its sessions stay, as ordinary sessions. */
  async deleteGroup(id: string): Promise<void> {
    if (!this.api) return;
    const g = this.groups.find((x) => x.id === id);
    const before = this.dirs;
    try {
      await this.api.deleteGroup(id);
      // what was in the group comes back as tabs of its own, where the group's tab was
      if (g) this.replaceTabs(before, [id], panesOf(g.layout).filter((x) => this.shows(x)));
      this.groups = this.groups.filter((g) => g.id !== id);
      this.dropFull(id);
    } catch (e) {
      this.fail(e, t("그룹을 해제하지 못했습니다"));
    }
  }

  /** Branch `id` into a new chat holding the history up to and including `atSeq`. */
  async fork(id: string, atSeq?: number): Promise<boolean> {
    if (!this.api) return false;
    try {
      const s = await this.api.forkSession(id, atSeq);
      if (!this.sessions.some((x) => x.id === s.id)) this.sessions.unshift(s);
      // Forked from inside a group: the branch joins that group, right beside its source.
      const g = this.groupOf(id);
      if (g && !layoutHas(g.layout, s.id)) {
        if (panesOf(g.layout).length < MAX_PANES) await this.dropSession(s.id, id, "right");
        else this.toast(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }), "error");
      }
      await this.openSession(s.id, true);
      this.toast(t("새 대화로 분기했습니다"), "ok", s.id);
      return true;
    } catch (e) {
      this.fail(e, t("분기하지 못했습니다"), id);
      return false;
    }
  }

  /** Branch from just before the user message at `seq` and put its text back in the input to rewrite. */
  async branchEdit(id: string, seq: number, text: string) {
    const ok = seq > 0 ? await this.fork(id, seq - 1) : (this.newChat(), true);
    if (ok) this.prefill = text;
  }

  /**
   * Change model/thinking. These belong to the open chat (the server stores them on the session); only a new
   * chat that has no session yet edits the draft. A change to one chat never leaks into another chat or into
   * what new chats start with.
   */
  async configure(patch: Partial<Draft>, id = this.activeId): Promise<boolean> {
    if (this.chatOf(id)?.compacting) {
      this.toast(t("압축이 끝난 뒤 모델 설정을 변경하세요"), "error", id);
      return false;
    }
    const s = this.session(id);
    if (!s || !this.api) {
      this.updateDraft(patch);
      return true;
    }
    try {
      const updated = await this.api.patchSession(s.id, patch);
      const i = this.sessions.findIndex((x) => x.id === s.id);
      if (i >= 0)
        this.sessions[i] = {
          ...this.sessions[i]!,
          ...updated,
          updatedAt: s.updatedAt,
        };
      return true;
    } catch (e) {
      this.fail(e, t("변경하지 못했습니다"), s.id);
      return false;
    }
  }

  /* ---------- generic extension configuration capability ---------- */

  extensionApproval = $state<{ message: string; resolve(value: boolean): void } | null>(null);
  confirmExtension(message: string): Promise<boolean> {
    if (this.extensionApproval) return Promise.resolve(false);
    return new Promise(resolve => { this.extensionApproval = { message, resolve }; });
  }
  resolveExtension(approved: boolean) {
    const pending = this.extensionApproval; this.extensionApproval = null; pending?.resolve(approved);
  }
  captureConfiguration(): Pick<ConfigurationDocument, "servers" | "preferences" | "keybindings"> {
    return {
      servers: this.servers.map(s => ({ name: s.name, baseUrl: s.baseUrl })),
      preferences: this.prefs.capture(),
      keybindings: this.prefs.changedBindings(),
    };
  }
  backupConfiguration() {
    return { servers: JSON.parse(JSON.stringify(this.servers)), preferences: this.captureConfiguration().preferences, bindings: { ...this.prefs.bindings } };
  }
  applyConfiguration(document: ConfigurationDocument) {
    const checked = parseConfiguration(document);
    for (const server of checked.servers) {
      const existing = this.servers.find(s => normalizeUrl(s.baseUrl) === server.baseUrl);
      if (existing) existing.name = server.name;
      else this.servers.push({ ...server, id: uid(), token: "" });
    }
    localStorage.setItem(K.servers, JSON.stringify(this.servers));
    this.prefs.apply(checked.preferences);
    this.prefs.mergeBindings(checked.keybindings);
  }
  applyBackgroundConfiguration(document: ConfigurationDocument) {
    const checked = parseConfiguration(document);
    const servers = checked.servers.map(s => {
      const old = this.servers.find(x => normalizeUrl(x.baseUrl) === s.baseUrl);
      return { ...s, id: old?.id ?? uid(), token: old?.token ?? "" };
    });
    this.servers = servers;
    localStorage.setItem(K.servers, JSON.stringify(servers));
    this.syncLinks();
    if (this.serverId && !servers.some(s => s.id === this.serverId)) this.closeServer();
    this.prefs.apply(checked.preferences);
  }
  restoreConfiguration(value: unknown) {
    const raw = value as { servers: Server[]; preferences: ConfigurationDocument["preferences"]; bindings?: Record<string, string> };
    if (!raw || !Array.isArray(raw.servers)) throw new LocalizedError(t("잘못된 앱 백업"));
    const checked = parseConfiguration({ schemaVersion: 1, servers: raw.servers.map(s => ({ name: s.name, baseUrl: s.baseUrl })), extensions: [], preferences: raw.preferences });
    if (raw.servers.some(s => typeof s.id !== "string" || typeof s.token !== "string")) throw new LocalizedError(t("잘못된 서버 백업"));
    this.servers = raw.servers.map((s, i) => ({ ...checked.servers[i]!, id: s.id, token: s.token }));
    localStorage.setItem(K.servers, JSON.stringify(this.servers));
    this.syncLinks();
    if (this.serverId && !this.servers.some(s => s.id === this.serverId)) this.closeServer();
    this.prefs.apply(checked.preferences);
    // A backup taken before shortcuts were part of it has none: leave the current ones.
    if (raw.bindings && typeof raw.bindings === "object") {
      this.prefs.replaceBindings(parseKeybindings(raw.bindings));
    }
  }
}

export const app = new AppStore();
