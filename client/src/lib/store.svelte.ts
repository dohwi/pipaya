import {
  Api,
  ApiError,
  describeConnectError,
  errorText,
  isUnsupportedRoute,
  normalizeUrl,
  probeServer,
  verifyServer,
  type ServerProbe,
} from "./api";
import { isTauri } from "./tauri";
import { compat, isClientTooOld, type Compat, type ServerVersions } from "./protocol";
import { serverUpdater } from "./server-update.svelte";
import { hostOf, uid } from "./format";
import { ChatState } from "./chat.svelte";
import { viewport } from "./viewport.svelte";
import { sessionOrder } from "./nav";
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
import { SidebarState } from "./sidebar.svelte";
import { isTerminalId, type TerminalInfo, type TerminalSupport } from "./terminal";
import type {
  ApprovalMode,
  ApprovalPolicy,
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
} from "./types";

export type NetState =
  "idle" | "connecting" | "online" | "offline" | "unauthorized" | "incompatible";
export type { ThemePref } from "./prefs.svelte";
export type { Toast, Notice } from "./feedback.svelte";
export { NOTICE_MS, NOTICE_MAX } from "./feedback.svelte";
export { SIDEBAR_W } from "./sidebar.svelte";
export type { PaletteItem, PaletteSpec, Draft, Server } from "./store-model";
export { defaultServerUrl } from "./store-model";
import { approvalMode, draftFromDefault, loadServers, normalizeThinking, readDraft } from "./store-model";
import type { Draft, PaletteSpec, Server } from "./store-model";

class AppStore {
  servers = $state<Server[]>(loadServers());
  serverId = $state<string | null>(null);
  status = $state<Record<string, ServerProbe | "checking">>({});
  /** Add-server / edit-server dialog: `null` = closed, `"new"` = add, otherwise the id being edited. */
  serverForm = $state<string | "new" | null>(null);
  /** What the sidebar shows for servers other than the open one (read from each server, not cached by the client) */
  overview = $state<
    Record<
      string,
      {
        sessions: Session[];
        workspace: WorkspaceInfo | null;
        groups: Group[];
        /** Terminals open on that server */
        terminals: TerminalInfo[];
        /** Sessions of that server that are running / waiting for the user (as it reports them) */
        running: Record<string, boolean>;
        awaiting: Record<string, number>;
      }
    >
  >({});
  net = $state<NetState>("idle");
  /** What the open server said about its version on connect (`/health`), or null before that. */
  serverVersions = $state<ServerVersions | null>(null);
  /** The open server needs a newer app (`update-app`) or is older than this app (`update-server`). */
  get compat(): Compat {
    return this.net === "incompatible" ? "update-app" : compat(this.serverVersions);
  }
  netError = $state("");

  /** Active (not closed) sessions only. Closed ones are fetched on demand by /resume and /tree. */
  sessions = $state<Session[]>([]);
  /** Workspace root on the server; every session lives in a working directory under it. */
  workspace = $state<WorkspaceInfo | null>(null);
  /** Working directory (relative to the root, "." = root) where the next new chat starts. */
  /** Directory the next new chat starts in: "." = the server's default, else a path relative to it or absolute */
  workdir = $state(".");
  /** The server's default working directory setting (null on servers from before it existed) */
  workdirInfo = $state<WorkdirInfo | null>(null);
  /** Whether the agent may ask questions (ask_user); saved on the server */
  askUserEnabled = $state(true);
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
  serverDefault = $state<DefaultModelSelection | null>(null);
  sessionsLoaded = $state(false);
  /** The focused session: what commands, shortcuts and the header act on. null = a new chat that has no session yet. */
  activeId = $state<string | null>(null);
  /** The session that had the focus before this one: the target of "back to the previous conversation". */
  previousId: string | null = null;
  /** Transcripts of every session on screen: the focused one, plus all panes of the open group. */
  chats = $state.raw<Record<string, ChatState>>({});
  /** Session groups of the open server: named split-window layouts, stored on the server. */
  groups = $state<Group[]>([]);
  /** Terminals open on the server (shells on its own OS), and what it supports; null support = an older server */
  terminals = $state<TerminalInfo[]>([]);
  terminalSupport = $state<TerminalSupport | null>(null);

  models = $state<ModelInfo[]>([]);
  providers = $state<ProviderInfo[]>([]);
  tools = $state<ToolInfo[]>([]);

  running = $state<Record<string, boolean>>({});
  /** The grouped session shown full-size in its group for a moment (Esc returns to the grid) */
  zoomId = $state<string | null>(null);
  /** Groups in "full" mode (kept on this device): one pane fills the group and a strip under the header picks the pane. */
  fullGroups = $state<string[]>(read<string[]>(K.fullGroups, []));
  awaiting = $state<Record<string, number>>({});
  unread = $state<Record<string, boolean>>({});
  /** Sessions whose last run ended in an error and have not been looked at yet */
  failed = $state<Record<string, boolean>>({});

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
  /** Prompt templates dialog (opened from the footer badge). cwd decides which project's templates are listed. */
  templatesDialog = $state<{ cwd: string } | null>(null);
  openTemplates(sessionId: string | null = this.activeId) {
    if (!this.api) return;
    this.templatesDialog = { cwd: this.session(sessionId)?.cwd ?? this.workdirAbs };
  }
  /** Model connections / API keys of the open server, opened from the model picker */
  connectionsOpen = $state(false);
  settingsTab = $state<"general" | "servers" | "keys" | "extensions" | "backup">("general");
  /** The server whose detail page the settings window opens on (`"new"` for the add form), or null for the list. */
  settingsServer = $state<string | "new" | null>(null);
  openSettings(
    tab: "general" | "servers" | "keys" | "extensions" | "backup" = "general",
    server: string | "new" | null = null,
  ) {
    this.settingsTab = tab;
    this.settingsServer = tab === "servers" ? server : null;
    this.settingsOpen = true;
  }
  sending = $state(false);

  api: Api | null = null;
  private unsubscribe: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 1000;
  private syncToken = 0;
  private hiddenAt = 0;

  /* ---------- derived ---------- */

  get server(): Server | undefined {
    return this.servers.find((s) => s.id === this.serverId);
  }

  /** Connection of the open server (kept as `conn` for components that only need url/token). */
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

  /** A session or a terminal that is open: something a pane can show. */
  shows(id: string | null | undefined): boolean {
    return !!this.session(id) || !!this.terminal(id);
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

  /** Sessions whose transcripts must be loaded: the focused one, and every pane of the group on a wide screen. */
  get visibleIds(): string[] {
    const out = new Set<string>();
    if (this.activeId && !isTerminalId(this.activeId)) out.add(this.activeId);
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

  /** The model/thinking/approval shown in the UI: the session's, or the draft's for a new chat. */
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
          approval: s.approval,
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
    let korean = /^ko(?:-|$)/i.test(getLang());
    onLangChange(() => {
      const now = /^ko(?:-|$)/i.test(getLang());
      if (now === korean) return;
      korean = now;
      void this.api?.localizeNames(getLang()).catch(() => {}); // an older server has no such route: names just stay
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.hiddenAt = Date.now();
      } else if (
        this.conn &&
        (this.net !== "online" || Date.now() - this.hiddenAt > 20_000)
      ) {
        // Mobile OSes silently kill background sockets; resync instead of trusting the stream.
        void this.sync();
      }
    });
    window.addEventListener(
      "online",
      () => this.conn && this.net !== "online" && void this.sync(),
    );
    const saved = read<string | null>(K.currentServer, null);
    const first = this.servers.find((s) => s.id === saved) ?? this.servers[0];
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

  private async startLocalServer() {
    if (!isTauri()) return;
    let info: { baseUrl: string; token: string };
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      info = await invoke("local_server");
    } catch {
      return; // mobile, or the bundled server is missing (dev build): the manual flow still works
    }
    const baseUrl = normalizeUrl(info.baseUrl);
    const cur = this.servers.find((s) => s.local);
    if (cur) {
      if (cur.baseUrl !== baseUrl || cur.token !== info.token) {
        const i = this.servers.findIndex((s) => s.id === cur.id);
        this.servers[i] = { ...cur, baseUrl, token: info.token };
        this.saveServers();
        if (cur.id === this.serverId) this.openServer(cur.id, true);
      }
    } else {
      const server: Server = { id: uid(), name: t("이 PC"), baseUrl, token: info.token, local: true };
      this.servers.push(server);
      this.saveServers();
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
    if (connChanged) delete this.status[id];
  }

  removeServer(id: string) {
    const wasOpen = id === this.serverId;
    this.servers = this.servers.filter((s) => s.id !== id);
    this.saveServers();
    delete this.status[id];
    try {
      localStorage.removeItem(`${K.active}.${id}`);
      localStorage.removeItem(`${K.favModels}.${id}`);
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

  /** Switch to a server: tear down the current stream, clear per-server state, and sync. */
  openServer(id: string, force = false) {
    const target = this.servers.find((s) => s.id === id);
    if (!target) return;
    if (!force && this.serverId === id && this.net !== "idle") return;
    this.stopStream();
    this.syncToken++;
    // The extension host reads the open server's list once at launch (init); only a later switch has to swap it.
    const changing = this.openedFor !== null && this.openedFor !== id;
    this.serverId = id;
    this.openedFor = id;
    write(K.currentServer, id);
    this.api = null;
    this.settingsSync?.dispose();
    this.settingsSync = null;
    this.favModels = this.loadFavModels(id);
    this.escalateMinutes = this.loadEscalate(id);
    if (changing) void extensions.switchServer();
    notifications.connect(null);
    this.net = "connecting";
    this.netError = "";
    this.serverVersions = null;
    serverUpdater.reset();
    this.sessions = [];
    this.workspace = null;
    this.workdirInfo = null;
    this.serverDefault = null;
    this.workdir = read<string>(`${K.workdir}.${id}`, ".");
    this.palette = null;
    this.skillsDialog = null;
    this.templatesDialog = null;
    this.queueDialog = null;
    this.sessionsLoaded = false;
    this.models = [];
    this.providers = [];
    this.tools = [];
    this.running = {};
    this.awaiting = {};
    this.unread = {};
    this.failed = {};
    this.activeId = null;
    this.chats = {};
    this.groups = [];
    this.terminals = [];
    this.terminalSupport = null;
    this.sidebar.open = false;
    this.retryDelay = 1000;
    void this.sync();
  }

  private closeServer() {
    this.stopStream();
    this.syncToken++;
    this.serverId = null;
    this.api = null;
    this.net = "idle";
    this.settingsSync?.dispose();
    this.settingsSync = null;
    this.favModels = [];
    this.escalateMinutes = DEFAULT_ESCALATE;
    notifications.connect(null);
    this.sessions = [];
    this.sessionsLoaded = false;
    this.activeId = null;
    this.chats = {};
    this.groups = [];
    this.terminals = [];
    this.terminalSupport = null;
    try {
      localStorage.removeItem(K.currentServer);
    } catch {
      /* ignore */
    }
  }

  /** Refresh the status dots of every saved server (the open one reports from its live stream). */
  async probeAll() {
    await Promise.all(
      this.servers.map(async (s) => {
        if (s.id === this.serverId && this.net === "online") {
          this.status[s.id] = "online";
          return;
        }
        this.status[s.id] = "checking";
        this.status[s.id] = await probeServer(s.baseUrl, s.token);
      }),
    );
  }

  /** Read the active sessions and working directories of every other server, straight from that server. */
  async refreshOverview() {
    await Promise.all(
      this.servers
        .filter((s) => s.id !== this.serverId)
        .map(async (s) => {
          const api = new Api({ baseUrl: s.baseUrl, token: s.token });
          try {
            const [list, workspace, groups, act, terminals] = await Promise.all([
              api.listSessions(200, false),
              api.workspace().catch(() => null),
              api.groups().catch(() => [] as Group[]),
              api.activity().catch(() => null),
              api.terminals().catch(() => [] as TerminalInfo[]),
            ]);
            const running: Record<string, boolean> = {};
            const awaiting: Record<string, number> = {};
            for (const a of act?.sessions ?? []) {
              if (a.running) running[a.sessionId] = true;
              const n = a.pendingApprovals + (a.pendingQuestions ?? 0);
              if (n) awaiting[a.sessionId] = n;
            }
            this.overview[s.id] = {
              sessions: list.sessions.filter((x) => !x.closed),
              workspace,
              groups,
              terminals,
              running,
              awaiting,
            };
            this.status[s.id] = "online";
          } catch (e) {
            this.status[s.id] =
              e instanceof ApiError && (e.status === 401 || e.status === 403)
                ? "unauthorized"
                : "offline";
          }
        }),
    );
  }

  /** Go to a server and open one of its sessions, or start a new chat in one of its working directories. */
  openIn(serverId: string, to: { session?: string; workdir?: string; terminal?: boolean }) {
    if (serverId !== this.serverId || this.net === "idle") {
      // A terminal asked for on another server opens once that server is connected (see sync).
      this.pendingTerminal = to.terminal ? (to.workdir ?? ".") : null;
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
    else {
      if (to.workdir !== undefined) this.setWorkdir(to.workdir);
      void this.startChat();
    }
  }

  /** Working directory of a terminal to open as soon as the server being switched to is connected */
  private pendingTerminal: string | null = null;

  private get activeKey(): string {
    return `${K.active}.${this.serverId}`;
  }

  private stopStream() {
    clearTimeout(this.retryTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.sync(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
  }

  /** (Re)load everything and (re)open the event stream. Safe to call repeatedly. */
  async sync(): Promise<void> {
    if (!this.conn) return;
    const token = ++this.syncToken;
    this.stopStream();
    this.net = this.net === "online" ? "online" : "connecting";
    const api = (this.api = new Api(this.conn));
    try {
      const health = await api.health();
      if (token !== this.syncToken) return;
      this.serverVersions = { version: health.version, protocol: health.protocol, minClientProtocol: health.minClientProtocol };
      if (compat(this.serverVersions) === "update-app") {
        // Every other call would be refused (426) or answered in a shape this app cannot read: say why instead.
        this.net = "incompatible";
        this.netError = t("이 서버는 더 새로운 앱이 필요합니다. 앱을 업데이트하세요");
        return;
      }
      const [list, models, providers, tools, cursor, workspace, config, groups, terminals, terminalSupport] =
        await Promise.all([
          api.listSessions(200, false),
          api.models(),
          api.providers(),
          api.tools(),
          api.latestEventId(),
          api.workspace().catch(() => null), // servers from before workspaces existed
          api.configuration().catch(() => null), // servers from before model configuration existed
          api.groups().catch(() => [] as Group[]), // servers from before session groups existed
          api.terminals().catch(() => [] as TerminalInfo[]), // servers from before terminals existed
          api.terminalSupport().catch(() => null),
        ]);
      if (token !== this.syncToken) return;
      this.workspace = workspace;
      this.sessions = list.sessions.filter((s) => !s.closed);
      this.groups = groups;
      this.terminals = terminals;
      this.terminalSupport = terminalSupport;
      this.sessionsLoaded = true;
      this.models = models;
      this.providers = providers;
      this.tools = tools.tools;
      // New chats follow the server's approval default, not whatever the browser last remembered.
      const serverApproval = config?.approval?.effective ?? tools.defaultApproval;
      if (serverApproval) this.updateDraft({ approval: approvalMode(serverApproval) });
      void this.refreshServerExtensions();
      this.serverDefault = config?.effectiveDefaults ?? null;
      this.workdirInfo = config?.workdir ?? null;
      this.askUserEnabled = config?.askUser?.enabled ?? true;
      this.ensureDraftModel();
      void this.syncLocales(); // language packs: never blocks connecting, and a server without them just has none
      if (this.serverId) this.startSettingsSync(api, this.serverId);
      await this.syncActivity();
      if (token !== this.syncToken) return;

      this.unsubscribe = api.subscribe(
        {
          onEvent: (e) => this.handle(e),
          onOpen: () => {
            this.net = "online";
            this.netError = "";
            this.retryDelay = 1000;
          },
          onError: () => {
            if (token !== this.syncToken) return;
            this.net = "offline";
            this.scheduleRetry();
          },
        },
        cursor,
      );

      // Restore (or refresh) the open conversation.
      const want = this.activeId ?? read<string | null>(this.activeKey, null);
      const had = Object.keys(this.chats);
      if (want && this.shows(want))
        await this.openSession(want, true);
      else if (this.activeId) this.newChat();
      if (this.pendingTerminal !== null) {
        const dir = this.pendingTerminal;
        this.pendingTerminal = null;
        void this.openTerminal(dir);
      }
      // Panes of the open group missed events while we were away: reload them too.
      for (const id of this.visibleIds)
        if (id !== this.activeId && had.includes(id))
          void this.ensureChat(id, true);
      this.net = "online";
      notifications.connect(api);
      this.netError = "";
      this.retryDelay = 1000;
      if (this.serverId) void serverUpdater.check(api, this.serverId);
    } catch (e) {
      if (token !== this.syncToken) return;
      if (e instanceof ApiError && isClientTooOld(e.status, e.code)) {
        this.net = "incompatible";
        this.netError = t("이 서버는 더 새로운 앱이 필요합니다. 앱을 업데이트하세요");
        return;
      }
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        this.net = "unauthorized";
        this.netError = t("토큰이 거부되었습니다");
        return;
      }
      this.net = "offline";
      this.netError = errorText(e);
      this.scheduleRetry();
    }
  }

  /** The user is looking at this window right now (so a sound or badge would only be noise). */
  private attended(): boolean {
    return (
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      document.hasFocus()
    );
  }

  /** Sessions that are running or waiting right now, as the server reports it (survives reloads and other clients). */
  async syncActivity() {
    if (!this.api) return;
    try {
      const { sessions } = await this.api.activity();
      const running: Record<string, boolean> = {};
      const awaiting: Record<string, number> = {};
      for (const a of sessions) {
        if (a.running) running[a.sessionId] = true;
        const n = a.pendingApprovals + (a.pendingQuestions ?? 0);
        if (n) awaiting[a.sessionId] = n;
      }
      this.running = running;
      this.awaiting = awaiting;
    } catch {
      /* older server: the event stream still keeps these current */
    }
  }

  private ensureDraftModel() {
    const usable = (p: string, id: string) =>
      this.models.some((m) => m.provider === p && m.id === id && m.configured);
    if (usable(this.draft.provider, this.draft.model)) return;
    const d = this.serverDefault;
    if (d && usable(d.provider, d.model))
      return void this.updateDraft(draftFromDefault(d));
    const pick = this.models.find((m) => m.configured) ?? this.models[0];
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
    if (e.type === "run_started" || e.type === "run_finished" || e.type === "session_created" || e.type === "session_updated" || e.type === "session_deleted" || e.type === "compaction_finished" || e.type === "approval_requested" || e.type === "approval_resolved") {
      extensions.emit({ type: e.type, sessionId: sid, at: e.ts, ...(e.type === "run_finished" && typeof e.data.status === "string" ? { status: e.data.status } : {}) });
    }
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
      void this.refreshServerExtensions();
    }
    switch (e.type) {
      case "notification": {
        const data = e.data as { deviceId: string; notification: import("./notification-contract").NotificationSpec & { id: string; at: number } };
        void notifications.receive(data.deviceId, data.notification).catch(() => {});
        break;
      }
      case "device_revoked": {
        notifications.revoked((e.data as { deviceId: string }).deviceId);
        break;
      }
      case "session_created": {
        const s = e.data as Session;
        if (!s.closed && !this.sessions.some((x) => x.id === s.id))
          this.sessions.unshift(s);
        void this.refreshWorkspace();
        break;
      }
      case "session_updated": {
        const s = e.data as Session;
        const next = s.closed ? this.neighbourOf(s.id) : undefined;
        if (s.closed) this.forgetInGroups(s.id);
        const i = this.sessions.findIndex((x) => x.id === s.id);
        if (i >= 0) this.sessions.splice(i, 1);
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
      case "session_deleted": {
        const id = e.data.id as string;
        const next = this.neighbourOf(id);
        this.forgetInGroups(id);
        this.sessions = this.sessions.filter((x) => x.id !== id);
        delete this.running[id];
        delete this.awaiting[id];
        delete this.unread[id];
        delete this.failed[id];
        if (this.activeId === id) this.leave(next);
        break;
      }
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
          // Only the focused pane counts as watched: a sibling pane of the open group finishing is news too.
          const seen = sid === this.activeId && this.attended();
          if (!seen) {
            if (bad) this.failed[sid] = true;
            else this.unread[sid] = true;
          }
          // A stopped run is the user's own doing: no sound
          if (e.data.status !== "aborted")
            this.prefs.cue(bad ? "failed" : "done");
          // Say it when the user is on another session (a phone shows only one) or on another pane of the group
          if (sid !== this.activeId && (viewport.narrow || this.isShown(sid)) && e.data.status !== "aborted")
            this.feedback.announce(sid, bad ? "failed" : "done");
        }
        break;
      case "approval_requested":
      case "question_requested":
        if (sid) {
          const first = !this.awaiting[sid];
          this.awaiting[sid] = (this.awaiting[sid] ?? 0) + 1;
          if (first) this.prefs.cue("ask");
        }
        break;
      case "approval_resolved":
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
        if ((e.data as { scope?: string } | undefined)?.scope === "approval") {
          // The server's default changed (here or from another client): new chats follow it.
          const eff = (e.data as { effective?: ApprovalPolicy }).effective;
          if (eff) this.updateDraft({ approval: approvalMode(eff) });
        }
        if ((e.data as { scope?: string } | undefined)?.scope === "ask_user") {
          this.askUserEnabled = (e.data as { enabled?: boolean }).enabled !== false;
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
      /* older server or offline: keep the cached packs */
    }
  }

  async refreshProviders() {
    if (!this.api) return;
    try {
      const [providers, models, config] = await Promise.all([
        this.api.providers(),
        this.api.models(),
        this.api.configuration().catch(() => null),
      ]);
      this.providers = providers;
      this.models = models;
      const before = this.serverDefault;
      const now = config?.effectiveDefaults ?? null;
      this.serverDefault = now;
      // The default was changed (here or from another client): new chats follow it, model and strength together.
      if (
        now &&
        (now.provider !== before?.provider || now.model !== before?.model || now.thinkingLevel !== before?.thinkingLevel) &&
        models.some(
          (m) =>
            m.provider === now.provider && m.id === now.model && m.configured,
        )
      ) {
        this.updateDraft(draftFromDefault(now));
      }
      this.ensureDraftModel();
    } catch {
      /* next sync will retry */
    }
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

  /** Let the agent ask the user questions (ask_user) or not. Saved on the server for every client. */
  async setAskUser(enabled: boolean): Promise<boolean> {
    if (!this.api) return false;
    const before = this.askUserEnabled;
    this.askUserEnabled = enabled;
    try {
      this.askUserEnabled = (await this.api.setAskUser(enabled)).enabled;
      return true;
    } catch (e) {
      this.askUserEnabled = before;
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

  private loadEscalate(serverId: string): number {
    const v = read<unknown>(`${K.escalate}.${serverId}`, null);
    return typeof v === "number" && (ESCALATE_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_ESCALATE;
  }

  /** This server's starred models; a device that only has the old global list lends it to the first server it opens. */
  private loadFavModels(serverId: string): string[] {
    const own = read<unknown>(`${K.favModels}.${serverId}`, null);
    let list: unknown = own;
    if (!Array.isArray(own)) {
      // the old single list goes to the first server opened after the update, then is retired
      list = read<unknown>(K.favModels, []);
      if (Array.isArray(list) && list.length) {
        write(`${K.favModels}.${serverId}`, list);
        try { localStorage.removeItem(K.favModels); } catch { /* ignore */ }
      }
    }
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
  }

  /* ---------- settings that belong to the open server ---------- */

  private settingsSync: ServerSettingsSync | null = null;
  /** The server whose extension list is currently loaded */
  private openedFor: string | null = null;
  listChanged() {
    this.settingsSync?.changed("extensions");
  }

  /** (Re)start syncing the open server's shared settings. Never throws: an unreachable or older server just keeps the local copy. */
  private startSettingsSync(api: Api, serverId: string) {
    this.settingsSync?.dispose();
    const favKey = `${K.favModels}.${serverId}`;
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
        extensions: {
          read: () => extensions.packages(),
          apply: (v) => extensions.applyPackages(v),
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

  /** Hand-set group order of the open server (empty = creation order). */
  get currentGroupOrder(): string[] {
    return (this.serverId && this.sidebar.groupOrder[this.serverId]) || [];
  }

  /** Hand-set order of loose sessions of the open server (empty = as the server lists them). */
  get currentSessionOrder(): string[] {
    return (this.serverId && this.sidebar.sessionOrder[this.serverId]) || [];
  }

  async refreshWorkspace() {
    if (!this.api) return;
    try {
      this.workspace = await this.api.workspace();
    } catch {
      /* older server: relPath falls back to the full path */
    }
  }

  /**
   * Move to another working directory (a path under the workspace root, created on first use).
   * An open chat keeps its own directory, so this leaves it and starts a fresh chat there.
   */
  changeWorkdir(raw: string): boolean {
    let rel = raw.trim().replace(/\/+$/, "") || ".";
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
    const order = sessionOrder(this.sessions, this.groups, this.currentDirOrder, this.currentGroupOrder, this.terminals, this.currentSessionOrder);
    const i = order.indexOf(id);
    return i < 0 ? undefined : (order[i + 1] ?? order[i - 1]);
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
    else if (this.activeId) await this.close(this.activeId);
  }

  /** Reopen a closed session and show it. */
  async resume(id: string): Promise<boolean> {
    if (!this.api) return false;
    // Resumed from inside a group: the session takes the focused pane's place instead of opening outside the group.
    const from = this.activeId;
    const g = from ? this.groupOf(from) : undefined;
    try {
      const s = await this.api.patchSession(id, { closed: false });
      const i = this.sessions.findIndex((x) => x.id === id);
      if (i >= 0) this.sessions.splice(i, 1);
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
    if (d && this.models.some((m) => m.provider === d.provider && m.id === d.model && m.configured))
      this.updateDraft(draftFromDefault(d));
  }

  /**
   * Start a new chat as a real session: it is created at once from the draft (pending model settings and working
   * directory) and shows up in the sidebar as an active "New session" right away. Without a usable model, or if the
   * server refuses, it falls back to the blank new-chat screen. An already open empty session in the same working
   * directory is reused rather than piling up another.
   */
  async startChat(): Promise<void> {
    const api = this.api;
    const d = this.draft;
    if (!api || !d.model) return this.newChat();
    const cur = this.session(this.activeId);
    const cwd = this.workdir === "." ? undefined : this.workdir;
    if (
      cur &&
      this.chats[cur.id]?.items.length === 0 &&
      !this.groupOf(cur.id) &&
      (!cwd || this.relPath(cur.cwd) === this.relPath(cwd))
    ) {
      this.sidebar.open = false;
      return;
    }
    try {
      const s = await api.createSession({
        cwd,
        provider: d.provider,
        model: d.model,
        thinkingLevel: normalizeThinking(d.thinkingLevel),
        approval: d.approval,
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
        approval: from.approval,
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
    if (!force && this.activeId === id && (this.chats[id] || isTerminalId(id))) {
      this.sidebar.open = false;
      return;
    }
    if (this.activeId && this.activeId !== id) this.previousId = this.activeId;
    this.activeId = id;
    write(this.activeKey, id);
    delete this.unread[id];
    delete this.failed[id];
    notifications.read(id);
    const cwd = this.sessions.find((s) => s.id === id)?.cwd ?? this.terminal(id)?.cwd;
    if (cwd) this.setWorkdir(this.relPath(cwd));
    this.sidebar.open = false;
    if (isTerminalId(id)) return;
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
      (t) => t.state === "awaiting_approval",
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
          approval: d.approval,
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

  /** Commands and tools that extensions inside the server provide; refreshed when the server (re)loads them. */
  serverCommands = $state<{ name: string; description?: string; extension: string }[]>([]);
  async refreshServerExtensions() {
    const api = this.api;
    if (!api) return;
    try {
      const [list, tools] = await Promise.all([api.serverExtensions(), api.tools()]);
      if (api !== this.api) return;
      this.serverCommands = list.commands;
      this.tools = tools.tools;
    } catch { /* an older server has no extensions; nothing to show */ }
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
    if (!id || !this.chatOf(id)?.queued.length) return void this.toast(t("취소할 대기열이 없습니다"), "error", id);
    this.queueDialog = id;
  }

  /** Remove one not-yet-delivered steer/queue message. The chat list updates from the `message_dequeued` event. */
  async cancelQueued(item: { mode: "steer" | "follow_up"; text: string }, id: string | null = this.queueDialog): Promise<void> {
    const chat = this.chatOf(id);
    if (!this.api || !chat) return;
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

  async decide(toolCallId: string, approved: boolean, reason?: string, id = this.activeId) {
    const chat = this.chatOf(id);
    if (!this.api || !chat) return;
    try {
      await this.api.decide(chat.id, toolCallId, approved, reason);
    } catch (e) {
      this.fail(e, t("승인 처리에 실패했습니다"), chat.id);
      void chat.load();
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
    const from = this.session(target) ?? this.terminal(target);
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
        approval: base?.approval ?? d.approval,
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
          approval: d.approval,
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
        approval: from.approval,
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

  /** A terminal beside the focused pane (Mod+Shift+` style split): it starts where that pane works. */
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
      const made = await api.createSession({ cwd, provider: d.provider, model: d.model, thinkingLevel: normalizeThinking(d.thinkingLevel), approval: d.approval });
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
      const dir = cwd ? (cwd.split("/").pop() ?? "") : "";
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
      const g = await this.api.createGroup({ layout, name: name || this.nextGroupName(layout), ...(name ? {} : { autoName: true }) });
      if (!this.groups.some((x) => x.id === g.id)) this.groups.push(g);
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
    try {
      await this.api.deleteGroup(id);
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
   * what new chats start with. (Tool approval is different: see setApprovalMode.)
   */
  async configure(patch: Partial<Omit<Draft, "approval">>, id = this.activeId): Promise<boolean> {
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

  /**
   * Tool approval: "ask" confirms only what reaches outside the project, "auto" never asks. One setting, not one per
   * chat: it is saved on the server as the default every new chat starts with, and the open chat follows it right
   * away, so switching to auto once stays auto. Other chats that are already open keep the mode they have.
   * Returns false (after telling the user) when nothing could be applied.
   */
  async setApprovalMode(mode: ApprovalMode): Promise<boolean> {
    const api = this.api;
    if (!api) return false;
    const sid = this.activeId;
    const s = this.session(sid);
    const before = this.draft.approval;
    this.updateDraft({ approval: mode });
    let chatChanged = false;
    try {
      if (s && s.approval !== mode) {
        const updated = await api.patchSession(s.id, { approval: mode });
        const i = this.sessions.findIndex((x) => x.id === s.id);
        if (i >= 0) this.sessions[i] = { ...this.sessions[i]!, ...updated, updatedAt: s.updatedAt };
        chatChanged = true;
      }
      await api.setDefaultApproval(mode);
      return true;
    } catch (e) {
      // A server from before the default existed has no such route. The open chat may already have the new mode;
      // say why new chats will not keep it instead of showing a bare "not found".
      if (chatChanged && isUnsupportedRoute(e)) {
        this.toast(t("이 서버는 새 대화의 기본값을 저장하지 못합니다. 서버를 업데이트하세요"), "error", sid);
        return true;
      }
      if (!chatChanged) this.updateDraft({ approval: before });
      this.fail(e, t("변경하지 못했습니다"), sid);
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
    if (this.serverId && !this.servers.some(s => s.id === this.serverId)) this.closeServer();
    this.prefs.apply(checked.preferences);
    // A backup taken before shortcuts were part of it has none: leave the current ones.
    if (raw.bindings && typeof raw.bindings === "object") {
      this.prefs.replaceBindings(parseKeybindings(raw.bindings));
    }
  }
}

export const app = new AppStore();
