import {
  Api,
  ApiError,
  errorText,
  isUnsupportedRoute,
  normalizeUrl,
} from "./api";
import { normalizeWorkdir, relPath, workdirAbs } from "./workdir-model";
import { moveBundledServer, readBundledBind, startBundledServer, type LocalBind, type LocalServerInfo } from "./local-server";
import { compat, type Compat, type ServerVersions } from "./protocol";
import { serverUpdater } from "./server-update.svelte";
import { hostOf, uid } from "./format";
import { ChatState, type Outgoing } from "./chat.svelte";
import { ExtensionRequests } from "./extension-requests.svelte";
import { mergeServers, replaceServers } from "./configuration-servers";

/** How many off-screen transcripts stay loaded so switching back to them is instant. */
const KEEP_CHATS = 8;
import { ServerLink, type NetState as LinkNet } from "./server-link.svelte";
import { applyLinkEvent, applyLiveEvent } from "./server-link-model";
import { dropListCache } from "./list-cache";
import { viewport } from "./viewport.svelte";
import { sidebarDirs, tabOf, tabPanes, workDir, type DirBlock, type Tab } from "./nav";
import { flattenBlocks, projectBlocks, projectKey, type SidebarBlock } from "./projects";
import { dirKey } from "./sidebar-model";
import { MAX_PANES, append, has as layoutHas, pair, panesOf, place, remove as layoutRemove, replaceSession, worthKeeping, type Layout, type Zone } from "./layout";
import { findPreset, nextArrangedPreset, type LayoutPreset, type LayoutPresetId } from "./layout-presets";
import { extensions } from "./extensions/host.svelte";
import { extensionUpdates } from "./extension-updates.svelte";
import { notifications } from "./notifications";
import { ServerSettingsSync } from "./server-settings";
import { ServerExtensionStore } from "./extensions/server-store";
import { IdleExtensionStores } from "./idle-extension-stores.svelte";
import { ServerExtensionFeed } from "./server-extension-feed.svelte";
import type { PairingLink } from "./pairing";
import { CloseGuard } from "./close-guard.svelte";
import { SessionCloseGuard } from "./session-close-guard.svelte";
import { sessionTitle } from "./session-title";
import { PairingFlow } from "./pairing-flow.svelte";
import { getLang, onLangChange, setRemotePacks, t } from "./i18n";
import { queuedShown } from "./queue";
import { graphRuns } from "./graph-runs.svelte";
import { fetchLocalePacks } from "./locale-sync";
import { configureUiEnv } from "./ui-env.svelte";
import { groupNameFor } from "./group-name";
import { buildMentionIndex, type MentionIndex, type MentionTarget } from "./peers";
import { parseConfiguration, type ConfigurationDocument } from "./extensions/configuration";
import { rehydrateSettingsFromDurable } from "./durable-storage";
import { K, read, write } from "./persist";
import { Preferences } from "./prefs.svelte";
import { ServerPrefs, serverPrefKeys } from "./server-prefs.svelte";
import { Feedback, type Toast } from "./feedback.svelte";
import { watchWake } from "./store/wake";
import { UiOverlayState, type ViewerImage, type ViewerState, type SettingsTargetTab } from "./store/ui-overlay.svelte";
import { applyDraftPatch, resolveDraftFallback, shouldAdoptServerDefault, startingTierOf } from "./store/draft-model";
import { canAddToGroup, findSessionNeighbour, stripSessionFromGroups } from "./store/groups-ops";
import { parseAppBackup } from "./store/configuration-ops";
import { cueBackgroundEvent, handleOpenServerEvent } from "./store/event-handler";
import type { SettingsFocus } from "./settings-focus";
import { SidebarState, reorder } from "./sidebar.svelte";
import { ScheduleBook } from "./schedule-book.svelte";
import { GoalBook } from "./goal-book.svelte";
import { setGoalActivity } from "./activity";
import { goalActivity } from "./goals";
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
import { draftFromDefault, loadServers, normalizeThinking, pinLocal, readDraft } from "./store-model";
import type { Draft, PaletteSpec, Server } from "./store-model";
import type { ServiceTier } from "./types";
import type { SettingsProblem } from "./settings-problems";
import { forgetDraft } from "./composer/saved-drafts";
import { forgetMemoryDraft } from "./composer/memory-drafts";
import { forgetAttachments } from "./composer/saved-attachments";
import { forgetMessageScroll } from "./chat-scroll";
import { forgetGraphPin } from "./graph-pins";

const NO_DIRS: DirBlock[] = [];

export interface SendingState {
  /** Upload progress 0..1 when uploading attachments, or null before the first progress event. */
  progress: number | null;
  loaded: number;
  total: number;
  /** True once upload bytes finished reaching the server and we are awaiting its 202 response. */
  waiting: boolean;
  /** True when this send carries images or files (drives the composer upload progress row). */
  hasAttachments: boolean;
  /** True after a short anti-flicker delay (150 ms) so instant LAN uploads do not flash the toolbar. */
  visible: boolean;
  cancel: () => void;
}

class AppStore {
  servers = $state<Server[]>(loadServers());
  serverId = $state<string | null>(null);
  /** Transient UI overlays, modals, graph view, cross-component ticks, and one-shot composer handoffs. */
  readonly ui = new UiOverlayState();
  /** Add-server / edit-server dialog: `null` = closed, `"new"` = add, otherwise the id being edited. */
  get serverForm(): string | "new" | null { return this.ui.serverForm; }
  set serverForm(v: string | "new" | null) { this.ui.serverForm = v; }
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
  /** The tab overview (the folder's tabs as a grid of cards, behind the tab count button) is open. */
  get tabOverview(): boolean { return this.ui.tabOverview; }
  set tabOverview(v: boolean) { this.ui.tabOverview = v; }
  /** The server whose conversation list (close / delete) is open, or null. */
  get sessionsDialog(): string | null { return this.ui.sessionsDialog; }
  set sessionsDialog(v: string | null) { this.ui.sessionsDialog = v; }
  /** Narrows the open conversation list to one folder (`cwd`). */
  get sessionsFilter(): { cwd?: string } | null { return this.ui.sessionsFilter; }
  set sessionsFilter(v: { cwd?: string } | null) { this.ui.sessionsFilter = v; }
  openSessions(serverId: string, filter: { cwd?: string } | null = null) {
    this.ui.openSessions(serverId, filter);
  }
  /** Workspace root on the server; every session lives in a working directory under it. */
  get workspace(): WorkspaceInfo | null {
    return this.link?.workspace ?? null;
  }
  set workspace(v: WorkspaceInfo | null) {
    if (this.link) this.link.workspace = v;
  }
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
  get dirPicker(): boolean { return this.ui.dirPicker; }
  set dirPicker(v: boolean) { this.ui.dirPicker = v; }
  /** Images open in the full-screen viewer (null = closed) */
  get viewer(): ViewerState | null { return this.ui.viewer; }
  set viewer(v: ViewerState | null) { this.ui.viewer = v; }

  openImage(images: ViewerImage[], index = 0) {
    this.ui.openImage(images, index);
  }
  /** Stars and the notification delay of the open server (server scope: shared with every client of that server). */
  private readonly serverPrefs = new ServerPrefs((key) => this.settingsSync?.changed(key), () => this.models);
  get favModels() { return this.serverPrefs.favModels; }
  get favDirs() { return this.serverPrefs.favDirs; }
  /** Minutes an unread PC notification waits before the phone is pushed too (server scope: the server acts on it) */
  get escalateMinutes() { return this.serverPrefs.escalateMinutes; }
  setEscalateMinutes(minutes: number) { this.serverPrefs.setEscalateMinutes(minutes); }
  get quietPeers() { return this.serverPrefs.quietPeers; }
  setQuietPeers(on: boolean) { this.serverPrefs.setQuietPeers(on); }
  get favModelList() { return this.serverPrefs.favModelList; }
  isFavModel(provider: string, id: string) { return this.serverPrefs.isFavModel(provider, id); }
  toggleFavModel(provider: string, id: string) { this.serverPrefs.toggleFavModel(provider, id); }
  isFavDir(path: string) { return this.serverPrefs.isFavDir(path); }
  toggleFavDir(path: string) { this.serverPrefs.toggleFavDir(path); }
  /** Picker overlay opened by a slash command. */
  get palette(): PaletteSpec | null { return this.ui.palette; }
  set palette(v: PaletteSpec | null) { this.ui.palette = v; }
  /** Bumped by /model to open the model picker. */
  get modelPickerTick(): number { return this.ui.modelPickerTick; }
  set modelPickerTick(v: number) { this.ui.modelPickerTick = v; }
  /** Bumped by the "queue message" shortcut: the focused composer queues its input. */
  get queueSendTick(): number { return this.ui.queueSendTick; }
  set queueSendTick(v: number) { this.ui.queueSendTick = v; }
  /** Bumped by the "find in chat" shortcut; the focused pane opens its search bar. */
  get findTick(): number { return this.ui.findTick; }
  set findTick(v: number) { this.ui.findTick = v; }
  /** Bumped when the open server reports a model-connection change (any client) */
  get configTick(): number { return this.ui.configTick; }
  set configTick(v: number) { this.ui.configTick = v; }
  /** Bumped when the open server reports a voice-input change (settings saved or a connection test run on any device) */
  get voiceTick(): number { return this.ui.voiceTick; }
  set voiceTick(v: number) { this.ui.voiceTick = v; }
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
  /** The server `previousId` belongs to: going back may cross to another server. */
  previousServer: string | null = null;
  /** Remember the focused pane as the one to go back to (before something else takes the focus). */
  private rememberPrevious() {
    if (!this.activeId) return;
    this.previousId = this.activeId;
    this.previousServer = this.serverId;
  }
  /** Transcripts of every session on screen: the focused one, plus all panes of the open group. */
  chats = $state.raw<Record<string, ChatState>>({});
  /** Session groups of the open server: named split-window layouts, stored on the server. */
  get groups(): Group[] {
    return this.link?.data.groups ?? NONE;
  }
  set groups(v: Group[]) {
    if (this.link) this.link.data.groups = v;
  }
  /** Shared lookup from `@name` (session or group) to the target it opens, memoized across all messages and tool cards. */
  mentionIndex: MentionIndex = $derived(buildMentionIndex(this.sessions, this.groups));

  /** Open the active session or group named by a mention chip, closing the queue modal if it was opened from there. */
  openMention(target: MentionTarget) {
    if (this.queueDialog) this.queueDialog = null;
    if (target.kind === "group") {
      if (this.groups.some((g) => g.id === target.id)) this.openTab(target.id);
    } else if (this.sessions.some((s) => s.id === target.id)) {
      void this.openAny(target.id);
    }
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

  get models(): ModelInfo[] {
    return this.link?.models ?? NONE;
  }
  get providers(): ProviderInfo[] {
    return this.link?.providers ?? NONE;
  }
  /** Settings of one server that no longer work (any server, not only the open one). */
  problemsOf(serverId: string): SettingsProblem[] {
    return this.links[serverId]?.problems ?? NONE;
  }
  /** How many settings problems all servers have together: the sidebar's settings button shows it. */
  get problemCount(): number {
    return this.servers.reduce((n, s) => n + this.problemsOf(s.id).length, 0);
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
  /** Scheduled tasks per server as the sidebar shows them (the button's count, the clock on a conversation). */
  readonly schedules = new ScheduleBook();
  /** Per-session goals per server (sidebar/tab corner marks, composer queue row, activity state). */
  readonly goals = new GoalBook();

  /** Text the composer should pick up once (edit-and-branch). */
  get prefill(): string | null { return this.ui.prefill; }
  set prefill(v: string | null) { this.ui.prefill = v; }
  /** Text to put into the composer at the caret, once: voice input's transcript (a plain append would add a line break). */
  get insertText(): { paneId: string; text: string } | null { return this.ui.insertText; }
  set insertText(v: { paneId: string; text: string } | null) { this.ui.insertText = v; }
  /**
   * Live dictation in a composer: everything heard so far in this recording, rewritten as words arrive. The composer
   * shows it after the text that was there when the recording began; null when no live dictation is running.
   */
  get liveText(): { paneId: string; text: string } | null { return this.ui.liveText; }
  set liveText(v: { paneId: string; text: string } | null) { this.ui.liveText = v; }
  /** Message the next prompt answers (the Reply button); the composer shows it as a badge and quotes it on send. */
  get replyTo(): { text: string; who?: string } | null { return this.ui.replyTo; }
  set replyTo(v: { text: string; who?: string } | null) { this.ui.replyTo = v; }
  get settingsOpen(): boolean { return this.ui.settingsOpen; }
  set settingsOpen(v: boolean) { this.ui.settingsOpen = v; }
  /** Skills dialog (opened from the footer badge or a /skill:name chip). cwd decides which project's skills; sessionId marks the ones that conversation already uses; skill opens that skill's viewer directly. */
  get skillsDialog(): { cwd: string; sessionId: string | null; skill?: string } | null { return this.ui.skillsDialog; }
  set skillsDialog(v: { cwd: string; sessionId: string | null; skill?: string } | null) { this.ui.skillsDialog = v; }
  /** Bumped when any client changes a skill, so footers and dialogs re-read it. */
  get skillsTick(): number { return this.ui.skillsTick; }
  set skillsTick(v: number) { this.ui.skillsTick = v; }
  openSkills(sessionId: string | null = this.activeId, skill?: string) {
    if (!this.api) return;
    this.ui.skillsDialog = { cwd: this.session(sessionId)?.cwd ?? this.workdirAbs, sessionId, ...(skill ? { skill } : {}) };
  }
  /** MCP servers dialog (opened from the footer badge). */
  get mcpDialog(): boolean { return this.ui.mcpDialog; }
  set mcpDialog(v: boolean) { this.ui.mcpDialog = v; }
  /** Bumped when an MCP server is changed or connects/disconnects, so footers and the dialog re-read it. */
  get mcpTick(): number { return this.ui.mcpTick; }
  set mcpTick(v: number) { this.ui.mcpTick = v; }
  /** Bumped by `schedules_updated`; the scheduled-tasks list reads it to refetch. */
  get schedulesTick(): number { return this.ui.schedulesTick; }
  set schedulesTick(v: number) { this.ui.schedulesTick = v; }
  /** Bumped by `goals_updated`; App.svelte refetches the open server's goals. */
  get goalsTick(): number { return this.ui.goalsTick; }
  set goalsTick(v: number) { this.ui.goalsTick = v; }
  /** Session whose goal edit dialog is open. null = closed. */
  get goalDialog(): string | null { return this.ui.goalDialog; }
  set goalDialog(v: string | null) { this.ui.goalDialog = v; }
  openGoal(id: string | null = this.activeId) {
    this.ui.openGoal(id);
  }
  /**
   * The graph view (every server's chats, their models and subagents) shown in place of the conversation. Opening a
   * conversation, a new chat or a terminal leaves it (`openIn`, `openSession`, `newChat`); Ctrl+G toggles it.
   */
  get graphOpen(): boolean { return this.ui.graphOpen; }
  set graphOpen(v: boolean) { this.ui.graphOpen = v; }
  /** The conversation the graph was opened from, so the toggle can go back to it. */
  get graphFrom(): { server: string; session: string } | null { return this.ui.graphFrom; }
  set graphFrom(v: { server: string; session: string } | null) { this.ui.graphFrom = v; }
  /**
   * The graph view's quick look: the chat shown in a dialog over the graph. It is the real conversation (the pane, its
   * input and status line), opened on its server the usual way while the graph stays up; the graph remembers where the
   * user came from (`graphFrom`) and goes back there when it closes.
   */
  get graphPeek(): { server: string; session: string } | null { return this.ui.graphPeek; }
  set graphPeek(v: { server: string; session: string } | null) { this.ui.graphPeek = v; }
  async peekChat(server: string, session: string) {
    this.ui.graphPeek = { server, session };
    // the chat's own server becomes the open one (its transcript, composer and status read from it)
    if (server !== this.serverId || this.net === "idle") {
      write(`${K.active}.${server}`, session);
      this.openServer(server, true);
      return; // attach opens the remembered session once connected (with the graph kept open: see openSession)
    }
    await this.openSession(session, false, false);
  }
  closePeek() {
    this.ui.closePeek();
  }

  toggleGraph(open = !this.ui.graphOpen) {
    if (open === this.ui.graphOpen) return;
    if (open) {
      this.ui.graphFrom = this.serverId && this.activeId ? { server: this.serverId, session: this.activeId } : null;
      this.ui.graphOpen = true;
      this.sidebar.open = false;
      return;
    }
    this.ui.graphOpen = false;
    this.ui.graphPeek = null;
    // back to the chat the graph was opened from (a quick look may have opened others meanwhile)
    const from = this.ui.graphFrom;
    if (!from) return;
    if (from.server !== this.serverId) this.openIn(from.server, { session: from.session });
    else if (from.session !== this.activeId && this.shows(from.session)) void this.openSession(from.session, false, false);
  }
  /** The scheduled-tasks window opened from the sidebar (the open server's list and form), or false. */
  get schedulesDialog(): boolean { return this.ui.schedulesDialog; }
  set schedulesDialog(v: boolean) { this.ui.schedulesDialog = v; }
  /** The session the scheduled-tasks page opens a new-task form for (set by a conversation's menu, taken by the page). */
  get scheduleFor(): string | null { return this.ui.scheduleFor; }
  set scheduleFor(v: string | null) { this.ui.scheduleFor = v; }
  /** The task the scheduled-tasks page opens in its edit form (set by a row above the input, taken by the page). */
  get scheduleEdit(): string | null { return this.ui.scheduleEdit; }
  set scheduleEdit(v: string | null) { this.ui.scheduleEdit = v; }
  openMcp() {
    if (this.api) this.ui.mcpDialog = true;
  }
  /** Subagent roles dialog (`delegate` roles, opened from the footer). cwd decides which folder's project roles are listed. */
  get subagentsDialog(): { cwd: string } | null { return this.ui.subagentsDialog; }
  set subagentsDialog(v: { cwd: string } | null) { this.ui.subagentsDialog = v; }
  openSubagents(sessionId: string | null = this.activeId) {
    if (!this.api) return;
    this.ui.subagentsDialog = { cwd: this.session(sessionId)?.cwd ?? this.workdirAbs };
  }
  /** Extension commands dialog (`/prefix:name`, opened from the footer badge). cwd decides which folder's commands are listed. */
  get commandsDialog(): { cwd: string } | null { return this.ui.commandsDialog; }
  set commandsDialog(v: { cwd: string } | null) { this.ui.commandsDialog = v; }
  openCommands(sessionId: string | null = this.activeId) {
    if (!this.api) return;
    this.ui.commandsDialog = { cwd: this.session(sessionId)?.cwd ?? this.workdirAbs };
  }
  /** Built-in prompt templates dialog (`/prompt:<name>`, opened from the footer or settings). */
  get templatesDialog(): { cwd: string } | null { return this.ui.templatesDialog; }
  set templatesDialog(v: { cwd: string } | null) { this.ui.templatesDialog = v; }
  openTemplates(sessionId: string | null = this.activeId) {
    if (!this.api) return;
    this.ui.templatesDialog = { cwd: this.session(sessionId)?.cwd ?? this.workdirAbs };
  }
  /**
   * The section the settings window opens on. `"servers"` and `"agent"` are old links (the server list and the model
   * connection); `Settings` maps them to the sections they became, so a stored or linked value still lands somewhere.
   */
  get settingsTab(): SettingsTargetTab { return this.ui.settingsTab; }
  set settingsTab(v: SettingsTargetTab) { this.ui.settingsTab = v; }
  /** The server whose sections the settings window opens on (`"new"` for the add form), or null for the open server. */
  get settingsServer(): string | "new" | null { return this.ui.settingsServer; }
  set settingsServer(v: string | "new" | null) { this.ui.settingsServer = v; }
  /** True when a section was asked for (not a plain open): on a phone it opens straight on that section instead of the list. */
  get settingsDirect(): boolean { return this.ui.settingsDirect; }
  set settingsDirect(v: boolean) { this.ui.settingsDirect = v; }
  /** One row to bring into view once the section opens (handed over once: the section that shows it clears it). */
  get settingsFocus(): SettingsFocus | null { return this.ui.settingsFocus; }
  set settingsFocus(v: SettingsFocus | null) { this.ui.settingsFocus = v; }
  openSettings(
    tab?: SettingsTargetTab,
    server: string | "new" | null = null,
    focus: SettingsFocus | null = null,
  ) {
    this.ui.openSettings(tab, server, focus);
  }
  /** Opens the scheduled-tasks page with a new-task form for this conversation. */
  openScheduleFor(sessionId: string) {
    this.ui.openScheduleFor(sessionId);
  }
  /** Opens the scheduled-tasks page with this task in the edit form. */
  openScheduleEdit(id: string) {
    this.ui.openScheduleEdit(id);
  }
  /** In-flight sends keyed by `serverId\0sessionId` so one slow upload never blocks other conversations. */
  private sendingMap = $state<Record<string, SendingState>>({});
  private sendKey(serverId: string | null, sessionId: string | null): string {
    return `${serverId ?? ""}\0${sessionId ?? ""}`;
  }
  /** Active send/upload state for `id` on the open server, or null when idle. */
  sendingOf(id: string | null = this.activeId): SendingState | null {
    return this.sendingMap[this.sendKey(this.serverId, id)] ?? null;
  }
  /** True while a send/upload is in flight for `id` on the open server. */
  isSending(id: string | null = this.activeId): boolean {
    return Boolean(this.sendingOf(id));
  }
  /** Whether the focused session is currently sending. */
  get sending(): boolean {
    return this.isSending(this.activeId);
  }
  /** Cancel an in-flight send/upload for `id` on the open server. */
  cancelSend(id: string | null = this.activeId): void {
    this.sendingOf(id)?.cancel();
  }

  private beginSend(serverId: string | null, sessionId: string | null, hasAttachments: boolean, estimatedTotal: number) {
    let key = this.sendKey(serverId, sessionId);
    const abort = new AbortController();
    let disposed = false;
    const initial: SendingState = {
      progress: null,
      loaded: 0,
      total: estimatedTotal,
      waiting: false,
      hasAttachments,
      visible: false,
      cancel: () => abort.abort(),
    };
    this.sendingMap = { ...this.sendingMap, [key]: initial };
    const revealTimer = hasAttachments
      ? setTimeout(() => {
          if (disposed) return;
          const cur = this.sendingMap[key];
          if (cur && !cur.visible) this.sendingMap = { ...this.sendingMap, [key]: { ...cur, visible: true } };
        }, 150)
      : undefined;
    const onProgress = (loaded: number, total: number) => {
      if (disposed) return;
      const cur = this.sendingMap[key];
      if (!cur) return;
      const progress = total > 0 ? Math.min(1, loaded / total) : null;
      const waiting = total > 0 && loaded >= total;
      this.sendingMap = { ...this.sendingMap, [key]: { ...cur, loaded, total, progress, waiting } };
    };
    const migrate = (nextSessionId: string | null) => {
      if (disposed) return;
      const nextKey = this.sendKey(serverId, nextSessionId);
      if (nextKey === key) return;
      const cur = this.sendingMap[key];
      const { [key]: _old, ...rest } = this.sendingMap;
      this.sendingMap = cur ? { ...rest, [nextKey]: cur } : rest;
      key = nextKey;
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (revealTimer !== undefined) clearTimeout(revealTimer);
      if (key in this.sendingMap) {
        const { [key]: _gone, ...rest } = this.sendingMap;
        this.sendingMap = rest;
      }
    };
    return { abort, onProgress, migrate, dispose };
  }

  /** The open server's connection. */
  get api(): Api | null {
    return this.link?.api ?? null;
  }
  private attachToken = 0;

  /* ---------- derived ---------- */

  get server(): Server | undefined {
    return this.servers.find((s) => s.id === this.serverId);
  }

  /**
   * Update the connected server, then say so and reload what it serves. The one path for every "update the server" button.
   * `force` goes ahead although conversations are running: they are cut off by the restart.
   */
  async updateServerSoftware(api: Api | null = this.api, force = false): Promise<boolean> {
    if (!api) return false;
    const outcome = await serverUpdater.apply(api, force);
    if (outcome === "pending") {
      this.toast(t("실행 중인 대화가 끝나면 서버를 업데이트합니다"), "ok");
      return true;
    }
    if (outcome !== "updated") return false;
    this.notifyServerUpdated();
    return true;
  }

  /** Cancel a queued server update waiting for running conversations to finish. */
  async cancelServerUpdate(api: Api | null = this.api): Promise<boolean> {
    if (!api) return false;
    const ok = await serverUpdater.cancel(api);
    if (ok) this.toast(t("서버 업데이트 대기를 취소했습니다"), "ok");
    return ok;
  }

  private notifyServerUpdated() {
    this.toast(serverUpdater.updatedTo ? t("서버를 v{version}(으)로 업데이트했습니다", { version: serverUpdater.updatedTo }) : t("서버를 업데이트했습니다"), "ok");
    void this.sync();
  }

  /** Reconnect the open server now (its stream is dropped and everything is read again). */
  async sync(): Promise<void> {
    await this.link?.sync();
  }

  /** Reconnect every server that is currently not online (the banner's "reconnect" button). */
  async syncAll(): Promise<void> {
    const targets = Object.values(this.links).filter((l) => !l.online);
    if (targets.length) await Promise.all(targets.map((l) => l.sync()));
    else await this.link?.sync();
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
    // a lookup, not a scan: it runs once per row on every list change
    return id ? this.link?.sessionById.get(id) : undefined;
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
    return this.activeId && !isTerminalId(this.activeId) ? this.activeId : null;
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
    // under the graph view no pane is drawn but the quick look's (which shows the active chat once it is open there)
    if (this.graphOpen) return this.graphPeek && this.graphPeek.session === this.activeId && this.graphPeek.server === this.serverId ? [this.activeId] : [];
    const g = this.activeGroup;
    const out = new Set<string>(this.activeId ? [this.activeId] : []);
    if (g && !viewport.narrow) for (const id of panesOf(g.layout)) if (this.shows(id)) out.add(id);
    return [...out];
  }

  groupOf(sessionId: string): Group | undefined {
    return this.groups.find((g) => layoutHas(g.layout, sessionId));
  }

  groupById(id: string, serverId?: string | null): Group | undefined {
    return this.linkOf(serverId)?.data.groups.find((g) => g.id === id);
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
          serviceTier: s.serviceTier,
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

  /** Window close asked while work is running: the confirmation. */
  private readonly closing = new CloseGuard({
    local: () => this.servers.find((s) => s.local),
    openId: () => this.serverId,
    openApi: () => this.api,
    busyIds: () => this.busyIds(),
  });
  get closeConfirm() { return this.closing.confirm; }
  /** Resolves true when the window may close now (nothing running, or the user confirmed and the work was stopped). */
  requestClose(): Promise<boolean> { return this.closing.request(); }

  /** Closing a tab that needs confirmation (working/asking conversation, or a pinned conversation/terminal). */
  private readonly sessionClosing = new SessionCloseGuard(
    (id, serverId) => {
      const link = this.links[serverId];
      if (!link) return null;
      const isMember = link.data.groups.some((g) => layoutHas(g.layout, id));
      const pinned = !isMember && this.sidebar.isTabPinned(serverId, id);
      if (isTerminalId(id)) return pinned ? "pinned-terminal" : null;
      if ((link.data.awaiting[id] ?? 0) > 0) return "asking";
      if (link.data.running[id] || (serverId === this.serverId && this.chatOf(id)?.compacting)) return "working";
      return pinned ? "pinned" : null;
    },
    (id, serverId) =>
      isTerminalId(id)
        ? (this.links[serverId]?.data.terminals.find((x) => x.id === id)?.title || t("터미널"))
        : sessionTitle(this.links[serverId]?.sessionById.get(id)?.title),
  );
  get sessionCloseConfirm() { return this.sessionClosing.ask; }

  /** The link for `serverId`, defaulting to the open server. */
  private linkOf(serverId?: string | null): ServerLink | null {
    const sid = serverId === undefined ? this.serverId : serverId;
    return (sid && this.links[sid]) || null;
  }

  /** If a user action hit a network failure while the link still thought it was online, probe and reconnect promptly. */
  private probeIfNetwork(link: ServerLink, e: unknown): void {
    if (e instanceof ApiError && e.status === 0 && this.links[link.id] === link) void link.probe();
  }

  get runningHere(): boolean {
    return !!this.chat?.running;
  }

  /* ---------- boot / connection ---------- */

  private stopInit: (() => void) | null = null;

  init(): () => void {
    if (this.stopInit) return this.stopInit;
    this.bindUpdateHints();
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
    // Session @names are stored once (Korean) and written per UI language at render (lib/member-names), so a switch renames nothing.
    // Client extensions hear the change too (they may keep text in it).
    let language = getLang();
    const stopLang = onLangChange(() => {
      if (getLang() === language) return;
      language = getLang();
      extensions.emit({ type: "language_changed", sessionId: null, at: Date.now() });
    });
    const stopWake = watchWake((force) => this.resyncLinks(force));
    const saved = read<string | null>(K.currentServer, null);
    const first = this.servers.find((s) => s.id === saved) ?? this.servers[0];
    this.syncLinks(); // every saved server goes live at once; `first` is only the one in view
    if (first) this.openServer(first.id);
    void this.ensureLocalServer();
    const dispose = () => {
      stopLang();
      stopWake();
      if (this.stopInit === dispose) this.stopInit = null;
    };
    this.stopInit = dispose;
    return dispose;
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
  localBind(): Promise<LocalBind | null> {
    return readBundledBind();
  }

  /** Change where the bundled server listens ("" = this PC only) and restart it there. Throws the reason on failure. */
  async setLocalBind(host: string, port: number) {
    await this.applyLocalInfo(await moveBundledServer(host, port));
  }

  private async startLocalServer() {
    const info = await startBundledServer();
    if (info) await this.applyLocalInfo(info);
  }

  private async applyLocalInfo(info: LocalServerInfo) {
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
      this.servers = pinLocal([...this.servers, server]);
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

  /** Connecting from a link or QR (the card shown over the whole app). */
  private readonly pairing = new PairingFlow({
    add: (input) => {
      const before = this.servers.length;
      this.addServer(input);
      return this.servers.length > before;
    },
    toast: (text, kind) => this.toast(text, kind),
  });
  get linking() { return this.pairing.linking; }
  connectByLink(link: PairingLink) { this.pairing.connect(link); }
  confirmLinking() { return this.pairing.confirm(); }
  closeLinking() { this.pairing.close(); }

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
    this.servers = pinLocal(ids.map((i) => this.servers.find((s) => s.id === i)!));
    this.saveServers();
  }

  /** Forget a server. The desktop app's own server cannot be removed: the app starts it and lists it itself. */
  removeServer(id: string) {
    if (this.servers.find((s) => s.id === id)?.local) return;
    this.sessionClosing.cancelServer(id);
    const wasOpen = id === this.serverId;
    this.servers = this.servers.filter((s) => s.id !== id);
    this.saveServers();
    this.syncLinks();
    try {
      localStorage.removeItem(`${K.active}.${id}`);
      for (const key of serverPrefKeys(id)) localStorage.removeItem(key);
      localStorage.removeItem(`pipaya.settings-sync.${id}`);
      dropListCache(id);
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
      delete this.parkedChats[s.id]; // they read through the old connection
      const link = new ServerLink(s, {
        event: (l, e) => this.onLinkEvent(l, e),
        // Pushed pages are live-only: after a reconnect they may have changed unseen, so the pages read the list again.
        ready: (l, warm) => { this.serverExtensionFeed.onEvent(l.id, "extensions_updated", {}); void this.attach(l, warm); },
        shape: (l) => this.sidebarShape(l.id),
      });
      next[s.id] = link;
      changed = true;
      link.start();
    }
    for (const id of Object.keys(this.links)) if (!next[id]) {
      delete this.parkedChats[id];
      void this.idleExtensions.drop(id);
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
  openServer(id: string, force = false, pending?: { terminal?: string | null; chat?: boolean }) {
    const target = this.servers.find((s) => s.id === id);
    if (!target) return;
    if (!force && this.serverId === id && this.net !== "idle") return;
    // leaving a server: what was open there is where "back to the previous conversation" goes
    if (this.serverId && this.serverId !== id) this.rememberPrevious();
    // Clear any deferred new-chat/terminal requested for a previous server that never finished connecting.
    this.pendingTerminal = pending?.terminal ?? null;
    this.pendingChat = Boolean(pending?.chat);
    this.syncLinks();
    this.attachToken++;
    // The extension host reads the open server's list once at launch (init); only a later switch has to swap it.
    const changing = this.openedFor !== null && this.openedFor !== id;
    if (changing) this.draft = readDraft(); // Never carry an explicit tier to a different server.
    this.serverId = id;
    this.openedFor = id;
    write(K.currentServer, id);
    this.settingsSync?.dispose();
    this.settingsSync = null;
    this.serverPrefs.load(id);
    // This server's list now belongs to the extension host: the idle editor of it (and its sync) is done. The host
    // reads the list from storage (the editor writes it at once), and the editor's uploads finish before the host's pull.
    this.idleExtensions.handOver(id);
    if (changing) void extensions.switchServer();
    notifications.connect(null);
    serverUpdater.reset();
    this.workdir = read<string>(`${K.workdir}.${id}`, ".");
    this.palette = null;
    this.tabOverview = false;
    this.skillsDialog = null;
    this.commandsDialog = null;
    this.mcpDialog = false;
    this.schedulesDialog = false;
    this.queueDialog = null;
    // The transcripts of the server we leave are parked, and the ones parked for this server come back: coming back to a
    // server shows its conversation at once and refreshes it in place (attach), instead of an empty pane for the length of
    // a request followed by the whole transcript being laid out again (the jump on every switch between servers).
    if (this.parkedFor && this.parkedFor !== id) this.parkedChats[this.parkedFor] = this.chats;
    const parked = this.parkedChats[id] ?? {};
    delete this.parkedChats[id];
    this.parkedFor = id;
    const link = this.links[id];
    const want = read<string | null>(this.activeKey, null);
    const back = !!(want && parked[want]?.ready && link?.loaded && this.shows(want));
    this.activeId = back ? want : null;
    this.chats = back ? parked : {};
    this.sidebar.open = false;
    if (!link) return;
    if (link.online && link.loaded) void this.attach(link);
    else void link.sync(); // not reachable yet (or refused earlier): try now instead of waiting for the next retry
  }

  private closeServer() {
    this.attachToken++;
    this.serverId = null;
    this.settingsSync?.dispose();
    this.settingsSync = null;
    this.serverPrefs.clear();
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
  openIn(serverId: string, to: { session?: string; workdir?: string; terminal?: boolean }) {
    this.graphOpen = false;
    this.graphPeek = null;
    if (serverId !== this.serverId || this.net === "idle") {
      // A terminal or new chat asked for on another server opens once that server is connected (see attach).
      const pending = { terminal: to.terminal ? (to.workdir ?? ".") : null, chat: !to.session && !to.terminal };
      if (to.workdir !== undefined)
        write(`${K.workdir}.${serverId}`, to.workdir);
      if (to.session) write(`${K.active}.${serverId}`, to.session);
      else
        try {
          localStorage.removeItem(`${K.active}.${serverId}`);
        } catch {
          /* ignore */
        }
      this.openServer(serverId, true, pending);
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

  /** A new chat to start as soon as the server being switched to is connected */
  private pendingChat = false;

  private get activeKey(): string {
    return `${K.active}.${this.serverId}`;
  }

  /**
   * The window came back. `force` reopens every stream outright (a long absence: the socket is probably gone); otherwise
   * a link that still says "online" is only pinged and reopens its stream when the ping fails. Neither reloads anything.
   */
  private resyncLinks(force: boolean) {
    for (const l of Object.values(this.links)) void l.resume(force);
  }

  private cueBackground(link: ServerLink, e: PipayaEvent) {
    cueBackgroundEvent(link, e, {
      cue: (kind) => this.prefs.cue(kind),
      announce: (sid, kind, serverId) => this.feedback.announce(sid, kind, serverId),
    });
  }

  /** A server's event arrived: the one in view reacts in full, the others just keep their lists and activity current. */
  private onLinkEvent(link: ServerLink, e: PipayaEvent) {
    // Server extension pages follow their server's events whether or not it is the open one.
    this.serverExtensionFeed.onEvent(link.id, e.type, e.data);
    applyLiveEvent(link.data, e);
    if (this.graphOpen) graphRuns.onEvent(link.id, e.type, e.data);
    if (link.id === this.serverId) return this.handle(e);
    // The client extensions of a server shown in settings follow what its other devices change.
    if (e.type === "client_settings_updated") this.idleExtensions.onEvent(link.id, e.data as { key?: unknown; updatedAt?: unknown; origin?: unknown });
    // Notices of a server not in view still reach this device.
    if (e.type === "notification") {
      const data = e.data as { deviceId: string; notification: import("./notification-contract").NotificationSpec & { id: string; at: number } };
      void notifications.receive(data.deviceId, data.notification, link.api).catch(() => {});
    } else if (e.type === "device_revoked") notifications.revoked((e.data as { deviceId: string }).deviceId, link.api);
    this.cueBackground(link, e);
    applyLinkEvent(link.data, e, () => { void link.refreshActivity(); });
    if (e.type === "session_updated" && (e.data as Session).closed) this.cleanupClosedSession(link.id, (e.data as Session).id);
    else if (e.type === "session_deleted") this.cleanupDeletedSession(link.id, (e.data as { id: string }).id);
    else if (e.type === "group_deleted") this.cleanupDeletedGroup(link.id, (e.data as { id: string }).id);
    else if (e.type === "terminal_closed") this.cleanupClosedTerminal(link.id, (e.data as { id: string }).id);
    if (e.type === "provider_updated" || e.type === "configuration_updated") {
      void link.refreshCatalog();
      if (e.type === "configuration_updated") void link.refreshWorkspace();
    }
  }

  /**
   * The server in view is loaded and streaming: restore its open conversation and start what belongs to the open server.
   * `warm`: the link only reopened its stream after the window was in the background and replayed the events it missed,
   * so the lists and the open transcript are already current. Reloading them anyway re-rendered every message and every
   * sidebar row for nothing (that was the "wriggle" on coming back to the window, worst on Windows).
   */
  private async attach(link: ServerLink, warm = false): Promise<void> {
    if (link.id !== this.serverId) return;
    const token = ++this.attachToken;
    const api = link.api;
    void this.refreshServerExtensions(undefined, { skipTools: !warm });
    void this.syncLocales(); // language packs: never blocks connecting, and a server without them just has none
    this.ensureDraftModel();
    // The editor of this server (if settings had it open) sends what it still holds before the host pulls the server's copy.
    // Bounded: an unreachable server must not hold up opening it.
    await Promise.race([this.idleExtensions.settled, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    if (link.id !== this.serverId || token !== this.attachToken) return;
    // A warm reconnect already has its settings sync running (and the editor holds nothing new): rebuilding it here made
    // every client of this server pull all of its settings again on each return to the window.
    if (!warm) this.startSettingsSync(api, link.id);
    // Restore (or refresh) the open conversation. A warm reconnect keeps what is on screen: the replayed events already
    // brought it up to date, and a reload would rebuild the whole transcript under the reader.
    const want = this.activeId ?? read<string | null>(this.activeKey, null);
    const had = Object.keys(this.chats);
    // Restoring what was open is not the user opening something: the tree stays as they folded it.
    if (warm) {
      if (want && !this.chats[want] && this.shows(want)) await this.openSession(want, false, false);
    } else if (want && this.shows(want)) await this.openSession(want, true, false);
    else if (this.activeId) this.newChat();
    if (token !== this.attachToken) return;
    if (this.pendingTerminal !== null) {
      const dir = this.pendingTerminal;
      this.pendingTerminal = null;
      void this.openTerminal(dir);
    }
    if (this.pendingChat) {
      this.pendingChat = false;
      void this.startChat();
    }
    // Panes of the open group missed events while we were away. A warm reconnect replayed them, so only the two things a
    // replay cannot carry are read (a run that started or ended, a reply that streamed); a cold one reloads them.
    if (warm) for (const id of this.visibleIds) void this.chats[id]?.catchUp();
    else for (const id of this.visibleIds) if (id !== this.activeId && had.includes(id)) void this.ensureChat(id, true);
    notifications.connect(api);
    if (!warm) void serverUpdater.check(api, link.id);
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
    const fallback = resolveDraftFallback(this.models, this.draft, this.serverDefault);
    if (fallback) this.updateDraft(fallback);
  }

  private startingTier(provider: string, id: string): ServiceTier | null {
    return startingTierOf(this.models, this.serverDefault, provider, id);
  }

  updateDraft(patch: Partial<Draft>) {
    this.draft = applyDraftPatch(this.draft, patch, this.models, this.serverDefault);
    write(K.draft, this.draft);
  }

  /* ---------- events ---------- */

  private handle(e: PipayaEvent) {
    const link = this.link;
    if (!link) return;
    if (e.type === "server_update_changed") {
      serverUpdater.onServerEvent(e.data as Parameters<typeof serverUpdater.onServerEvent>[0], link.api, () => this.notifyServerUpdated());
      return;
    }
    handleOpenServerEvent(
      {
        activeId: this.activeId,
        quietPeers: this.serverPrefs.quietPeers,
        sessions: this.sessions,
        groups: this.groups,
        terminals: this.terminals,
        running: link.data.running,
        compacting: link.data.compacting,
        awaiting: link.data.awaiting,
        unread: link.data.unread,
        failed: link.data.failed,
        chats: this.chats,
        setSessions: (next) => { this.sessions = next; },
        setGroups: (next) => { this.groups = next; },
        setToolsInfo: (next) => { this.toolsInfo = next; },
        setWorkdirInfo: (next) => { this.workdirInfo = next; },
        neighbourOf: (id) => this.neighbourOf(id),
        forgetInGroups: (id) => this.forgetInGroups(id),
        leave: (next) => this.leave(next),
        dropFull: (id) => this.dropFull(id),
        dropTerminal: (id) => this.dropTerminal(id),
        onSessionClosed: (id) => { if (this.serverId) this.cleanupClosedSession(this.serverId, id); },
        onSessionDeleted: (id) => { if (this.serverId) this.cleanupDeletedSession(this.serverId, id); },
        onGroupDeleted: (id) => { if (this.serverId) this.cleanupDeletedGroup(this.serverId, id); },
        cue: (kind) => this.prefs.cue(kind),
        announce: (sid, kind) => this.feedback.announce(sid, kind),
        bumpSkills: () => { this.skillsTick++; },
        bumpMcp: () => { this.mcpTick++; },
        bumpSchedules: () => { this.schedulesTick++; },
        bumpGoals: () => { this.goalsTick++; },
        isGoalActive: (sid) => this.goals.of(this.serverId, sid)?.status === "active",
        bumpConfig: () => { this.configTick++; },
        bumpVoice: () => { this.voiceTick++; },
        refreshWorkspace: () => { void this.refreshWorkspace(); },
        refreshProviders: () => { void this.refreshProviders(); },
        refreshServerExtensions: () => { void this.refreshServerExtensions(); },
        refreshActivity: () => { void link.refreshActivity(); },
        syncLocales: () => { void this.syncLocales(); },
        onClientSettings: (data) => {
          const sid = this.serverId;
          void this.settingsSync?.onEvent(data).then(() => { if (sid && data.key === "sidebar") this.prunePinnedTabsOn(sid); });
        },
        refreshUsage: (chat) => { void this.refreshUsage(chat); },
        flushHeld: (chat) => { void this.flushHeld(chat); },
      },
      e,
    );
  }

  /**
   * UI language packs published on the server. Only packs that changed since the last sync are downloaded; a failed
   * download keeps the copy already held (or none), and a server from before language packs leaves the cache untouched.
   */
  async syncLocales(): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const packs = await fetchLocalePacks(api);
      if (api !== this.api) return; // switched servers meanwhile: these packs are not the open one's
      setRemotePacks(packs);
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
    if (shouldAdoptServerDefault(before, now, this.models)) {
      this.updateDraft(draftFromDefault(now));
    }
    if (!now && before && this.draft.provider === before.provider && this.draft.model === before.model) {
      this.updateDraft({ serviceTier: this.startingTier(before.provider, before.model) });
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
    return relPath(cwd, this.workspace?.root);
  }

  /** Absolute path the next new chat will start in (best effort until the server confirms). */
  get workdirAbs(): string {
    return workdirAbs(this.workdir, this.workspace?.root);
  }

  /** Save the server-wide default working directory (null restores the startup default). */
  async setDefaultWorkdir(path: string | null): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.workdirInfo = await this.api.setDefaultWorkdir(path);
      await this.refreshWorkspace();
      this.toast(
        path
          ? t("기본 작업 폴더를 저장했습니다")
          : t("기본 작업 폴더를 처음 설정으로 되돌렸습니다"),
        "ok",
      );
      return true;
    } catch (e) {
      this.fail(e, t("저장하지 못했습니다"));
      return false;
    }
  }

  /** Where a conversation or terminal works now: the folder the sidebar lists it under (see `workDir`). */
  memberDir(id: string | null | undefined): string | undefined {
    const m = id ? (this.session(id) ?? this.terminal(id)) : undefined;
    return m ? workDir(m) : undefined;
  }

  setWorkdir(path: string) {
    this.workdir = path || ".";
    write(`${K.workdir}.${this.serverId}`, this.workdir);
  }

  /* ---------- settings that belong to the open server ---------- */

  private settingsSync: ServerSettingsSync | null = null;
  /** The server whose extension list is currently loaded */
  private openedFor: string | null = null;
  /** When each transcript was last on screen, and which were on screen at the previous sync (see syncChats). */
  private chatUsed = new Map<string, number>();
  private lastVisible = new Set<string>();
  /** Transcripts of servers not in view, kept from when they were last open (see openServer); dropped with their link. */
  private parkedChats: Record<string, Record<string, ChatState>> = {};
  /** The server `chats` belongs to. */
  private parkedFor: string | null = null;
  /** Live changes to the settings and pages of server extensions, per server (the settings window can show any of them). */
  readonly serverExtensionFeed = new ServerExtensionFeed();
  /** Editors of the client extensions of saved servers that are not the open one. */
  private readonly idleExtensions = new IdleExtensionStores({ openId: () => this.serverId, apiOf: (id) => this.links[id]?.api ?? null });
  /** Bumped whenever one of those editors changed, so what shows them reads again. */
  get extensionStoreTick() { return this.idleExtensions.tick; }
  extensionStoreOf(serverId: string | null | undefined): ServerExtensionStore | null { return this.idleExtensions.of(serverId); }
  attachExtensionStore(serverId: string): Promise<void> { return this.idleExtensions.attach(serverId); }
  /** The client extensions as one server sees them (the host's when it is open, the idle editor's otherwise). */
  clientExtensionsOf(serverId: string | null | undefined) { return this.idleExtensions.clientsOf(serverId); }
  listChanged() {
    this.settingsSync?.changed("extensions");
  }
  /** Lets the update hints read each server's own client extensions (never the open server's for another server). */
  private bindUpdateHints() {
    extensionUpdates.clientsOf = (id) => { void this.extensionStoreTick; return this.clientExtensionsOf(id).map((e) => ({ id: e.id, version: e.version })); };
  }
  statesChanged() {
    this.settingsSync?.changed("extensionStates");
  }

  /** (Re)start syncing the open server's shared settings. Never throws: an unreachable server just keeps the local copy. */
  private startSettingsSync(api: Api, serverId: string) {
    this.settingsSync?.dispose();
    const sync = new ServerSettingsSync({
      api,
      origin: notifications.id,
      storage: localStorage,
      storageKey: `pipaya.settings-sync.${serverId}`,
      adapters: {
        ...this.serverPrefs.adapters(serverId),
        extensions: {
          read: () => extensions.packages(),
          apply: (v) => extensions.applyPackages(v),
        },
        sidebar: {
          read: () => this.sidebar.shared(serverId),
          apply: (v) => this.sidebar.applyShared(serverId, v),
        },
        extensionStates: {
          read: () => extensions.states(),
          apply: (v) => extensions.applyStates(v),
        },
      },
    });
    this.settingsSync = sync;
    this.sidebar.onEdit = (id) => { if (id === serverId) sync.changed("sidebar"); };
    void sync.pull().then(() => this.prunePinnedTabsOn(serverId)).catch(() => {});
  }

  /**
   * Drop pinned tab ids for sessions/groups/terminals that are no longer open on `serverId` (e.g. closed while offline
   * or on another server). Only runs when the link has the complete active session list (`listed && sessionsComplete`).
   */
  private prunePinnedTabsOn(serverId: string) {
    const link = this.links[serverId];
    if (!link?.listed || !link.sessionsComplete || link.cached) return;
    const active = new Set<string>([
      ...link.data.sessions.map((s) => s.id),
      ...link.data.groups.map((g) => g.id),
      ...link.data.terminals.map((t) => t.id),
    ]);
    this.sidebar.prunePinnedTabs(serverId, active);
  }

  /** Hand-set directory order of the open server (empty = by recent activity). */
  get currentDirOrder(): string[] {
    return (this.serverId && this.sidebar.dirOrder[this.serverId]) || [];
  }

  /** Hand-set tab order of the open server (empty = the order they were made in). */
  get currentTabOrder(): string[] {
    return (this.serverId && this.sidebar.tabOrder[this.serverId]) || [];
  }

  get currentPinnedTabs(): string[] {
    return (this.serverId && this.sidebar.pinnedTabs[this.serverId]) || [];
  }

  /**
   * Every server's working directories and tabs in sidebar order, built once per change and shared by the sidebar, the
   * rail, the tab bar and the shortcuts. They each used to build their own copy (and the getters rebuilt it on every read),
   * dozens of sorts of the whole session list in the second after a send. A search narrows the list, so the sidebar
   * still builds its own while a query is typed.
   */
  blocksByServer: Record<string, SidebarBlock[]> = $derived.by(() => {
    const out: Record<string, SidebarBlock[]> = {};
    for (const server of this.servers) {
      const link = this.links[server.id];
      const d = link?.data;
      if (!d) continue;
      const id = server.id;
      const dirs = sidebarDirs(d.sessions, d.groups, d.terminals, { dirOrder: this.sidebar.dirOrder[id], tabOrder: this.sidebar.tabOrder[id], groupDir: this.sidebar.groupDir[id], keep: this.sidebar.pinned[id], pinnedTabs: this.sidebar.pinnedTabs[id] });
      out[id] = projectBlocks(dirs, link.repos, this.sidebar.overrides(id));
    }
    return out;
  });

  /**
   * Rows per top-level entry of a server's list as drawn now (its header, then the rows open under it), so a cold start's
   * skeleton has the height the list will have. Folders start folded, so most entries are a single row.
   */
  private sidebarShape(serverId: string): number[] {
    const rows = (d: DirBlock, inProject: boolean) => 1 + (this.sidebar.isDirFolded(dirKey(serverId, d.path), inProject) ? 0 : d.tabs.length);
    return (this.blocksByServer[serverId] ?? []).map((b) =>
      b.kind === "dir" ? rows(b.dir, false) : 1 + (this.sidebar.folded.includes(projectKey(serverId, b.root)) ? 0 : b.dirs.reduce((k, d) => k + rows(d, true), 0)),
    );
  }

  /** Folder `path` of a server lists no tabs under its row: folded by hand, or never opened (outside a project they start folded). */
  dirFolded(serverId: string, path: string): boolean {
    const inProject = (this.blocksByServer[serverId] ?? []).some((b) => b.kind === "project" && b.dirs.some((d) => d.path === path));
    return this.sidebar.isDirFolded(dirKey(serverId, path), inProject);
  }

  /** The same folders in the order the sidebar draws them (a project's folders together), for everything that walks them. */
  dirsByServer: Record<string, DirBlock[]> = $derived.by(() => {
    const out: Record<string, DirBlock[]> = {};
    for (const [id, blocks] of Object.entries(this.blocksByServer)) out[id] = flattenBlocks(blocks);
    return out;
  });

  /** The open server's working directories and their tabs, in sidebar order. */
  get dirs(): DirBlock[] {
    return (this.serverId && this.dirsByServer[this.serverId]) || NO_DIRS;
  }

  /** The tab the focused pane is in, and its directory. */
  activeTab: { dir: DirBlock; tab: Tab } | null = $derived.by(() => tabOf(this.dirs, this.activeId));

  /** The folder whose tabs the strip shows: the open tab's, else the folder a new chat would start in. */
  get tabDir(): DirBlock | null {
    return this.activeTab?.dir ?? this.dirs.find((d) => d.path === this.workdirAbs) ?? null;
  }

  /** The pane last focused in each tab (by tab id), so switching back to a group lands where it was left. */
  private lastPane: Record<string, string> = {};

  /**
   * The tabs `from` (as listed in `before`) became `to`: put `to` where the first of them was, in that directory, and
   * remember the directory's order so it stays that way.
   */
  private replaceTabs(before: DirBlock[], from: string[], to: string[], serverId: string | null = this.serverId) {
    if (!serverId) return;
    for (const d of before) {
      const ids = d.tabs.map((x) => x.id);
      const at = ids.findIndex((x) => from.includes(x));
      if (at < 0) continue;
      const list = ids.filter((x) => !from.includes(x) && !to.includes(x));
      list.splice(Math.min(at, list.length), 0, ...to);
      this.sidebar.placeTabs(serverId, list);
      return;
    }
  }

  /** The tab last open in each folder (by `server\0path`), so a folder button lands where that folder was left. */
  private lastTabIn: Record<string, string> = {};

  /**
   * The project whose folders' tabs the strip shows together (its header was clicked in the sidebar), or null: the strip
   * shows the open folder's alone. Opening a folder (its row) or a tab outside the project goes back to one folder.
   */
  tabProject = $state<{ serverId: string; root: string } | null>(null);

  /** The folders of project `root` on server `serverId`, in sidebar order (null: no such project listed). */
  projectDirs(serverId: string, root: string): DirBlock[] | null {
    const b = this.blocksByServer[serverId]?.find((x) => x.kind === "project" && x.root === root);
    return b?.kind === "project" ? b.dirs : null;
  }

  /**
   * The folders whose tabs the strip lists, in order: every folder of the chosen project while the open tab is in one of
   * them, else the open folder alone.
   */
  get stripDirs(): DirBlock[] {
    const cur = this.tabDir;
    const p = this.tabProject;
    const dirs = p && p.serverId === this.serverId ? this.projectDirs(p.serverId, p.root) : null;
    if (dirs && (!cur || dirs.some((d) => d.path === cur.path))) return dirs;
    return cur ? [cur] : NO_DIRS;
  }

  /**
   * Show a whole project in the strip: the tabs of all its folders together. Stays on the open tab when it is already in
   * the project, else opens the tab last used in its first folder that has one.
   */
  openProject(serverId: string, root: string) {
    const own = this.projectDirs(serverId, root);
    const first = own?.find((d) => d.tabs.length);
    if (!own || !first) return;
    this.tabProject = { serverId, root };
    if (serverId === this.serverId && this.activeTab && own.some((d) => d.path === this.activeTab!.dir.path)) return;
    this.showDir(serverId, first.path);
  }

  /** Show a folder: the tab last used in it, else its first one. `serverId` other than the open one switches server. */
  openDir(serverId: string, path: string) {
    this.tabProject = null;
    this.showDir(serverId, path);
  }

  /**
   * Land on a folder the way a click on its row does (the tab last used in it, else its first), but keep a project shown
   * in the strip when the folder is one of its own: the previous / next folder shortcuts walk within it.
   */
  showDir(serverId: string, path: string) {
    const ov = serverId === this.serverId ? null : this.links[serverId]?.data;
    const dirs = ov ? (this.dirsByServer[serverId] ?? []) : this.dirs;
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
    this.revealRow(id);
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
    const norm = normalizeWorkdir(raw, { root: this.workspace?.root, home: this.workspace?.home });
    if (!norm.ok) {
      this.toast(
        norm.error === "home"
          ? t("홈 폴더를 알 수 없어 ~를 쓸 수 없습니다")
          : norm.error === "chars"
            ? t("경로에 사용할 수 없는 문자가 있습니다")
            : t("상대 경로에는 ..을 쓸 수 없습니다. 절대 경로(/로 시작)를 입력하세요"),
        "error",
      );
      return false;
    }
    const rel = norm.path;
    const same = this.current && this.relPath(this.current.cwd) === rel;
    this.setWorkdir(rel);
    if (same) return true;
    const cur = this.current;
    if (cur && !this.groupOf(cur.id) && this.chats[cur.id]?.items.length === 0) {
      // An empty session made by "new chat" moves to the new folder: start one there and close the empty one.
      void this.startChat().then(() => {
        if (this.activeId !== cur.id) void this.close(cur.id, true);
      });
    } else this.newChat();
    return true;
  }

  /** Unpin a closed session so resuming it later starts unpinned, and drop its manual graph pin. */
  cleanupClosedSession(serverId: string, id: string) {
    if (!serverId || !id) return;
    this.sessionClosing.cancelTarget(serverId, id);
    this.sidebar.unpinTab(serverId, id);
    forgetGraphPin(serverId, id);
  }

  /** Drop every persisted and in-memory trace of a permanently deleted session. */
  cleanupDeletedSession(serverId: string, id: string) {
    if (!serverId || !id) return;
    this.sessionClosing.cancelTarget(serverId, id);
    this.sidebar.forgetTab(serverId, id);
    forgetGraphPin(serverId, id);
    forgetDraft(id);
    forgetMemoryDraft(id);
    forgetAttachments(id);
    forgetMessageScroll(id);
    notifications.forgetSession(id);
    if (this.serverId === serverId) {
      if (Object.hasOwn(this.chats, id)) {
        const { [id]: _, ...rest } = this.chats;
        this.chats = rest;
      }
      this.chatUsed.delete(id);
      this.lastVisible.delete(id);
    }
    if (this.parkedChats[serverId]) delete this.parkedChats[serverId]![id];
    if (this.previousId === id && this.previousServer === serverId) {
      this.previousId = null;
      this.previousServer = null;
    }
  }

  /** Drop every persisted and in-memory trace of a dissolved split group. */
  cleanupDeletedGroup(serverId: string, id: string) {
    if (!serverId || !id) return;
    this.sidebar.forgetTab(serverId, id);
    this.dropFull(id);
    delete this.lastPane[id];
    const key = `${serverId}\u0000${id}`;
    const queued = this.layoutSavePending.get(key);
    if (queued) for (const r of queued.resolvers) r(false);
    this.layoutSavePending.delete(key);
    this.layoutSaveBusy.delete(key);
  }

  /** Drop sidebar state of a closed terminal (terminals cannot be resumed). */
  cleanupClosedTerminal(serverId: string, id: string) {
    if (!serverId || !id) return;
    this.sessionClosing.cancelTarget(serverId, id);
    this.sidebar.forgetTab(serverId, id);
  }

  /* ---------- close / resume ---------- */

  /**
   * Hide a session from the sidebar (stopping any run). Its history stays on the server; /resume reopens it.
   * A session still at work asks first (`sessionCloseConfirm`); `force` skips that, for a close the user did not ask for.
   * `serverId` defaults to the open server; passing another server's id acts on that server without switching to it.
   */
  async close(id: string, force = false, serverId?: string | null) {
    const link = this.linkOf(serverId);
    if (!link) return;
    const sid = link.id;
    const api = link.api;
    if (!force && !(await this.sessionClosing.request(id, sid))) return;
    if (this.links[sid] !== link) return;
    const next = this.serverId === sid ? this.neighbourOf(id) : undefined;
    try {
      const closed = await api.closeSession(id);
      if (this.links[sid] !== link) return;
      this.forgetInGroupsOn(link, id);
      link.data.sessions = link.data.sessions.filter((x) => x.id !== id);
      link.data.running[id] = false;
      delete link.data.compacting[id];
      link.data.awaiting[id] = 0;
      delete link.data.unread[id];
      delete link.data.failed[id];
      if (closed === undefined) this.cleanupDeletedSession(sid, id);
      else this.cleanupClosedSession(sid, id);
      if (this.graphPeek?.server === sid && this.graphPeek?.session === id) this.graphPeek = null;
      if (this.graphFrom?.server === sid && this.graphFrom?.session === id) this.graphFrom = next ? { server: sid, session: next } : null;
      if (this.serverId === sid && this.activeId === id) {
        if (this.graphOpen) {
          this.activeId = null;
          try {
            localStorage.removeItem(this.activeKey);
          } catch {
            /* ignore */
          }
          this.resetNewChatDraft();
        } else {
          this.leave(next);
        }
      }
      void link.refreshWorkspace();
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("닫지 못했습니다"));
    }
  }

  private neighbourOf(id: string): string | undefined {
    return findSessionNeighbour({
      id,
      group: this.groupOf(id),
      dirs: this.dirs,
      lastPane: this.lastPane,
      sessions: this.sessions,
      groups: this.groups,
      terminals: this.terminals,
      dirOrder: this.currentDirOrder,
      tabOrder: this.currentTabOrder,
      pinnedTabs: this.currentPinnedTabs,
      shows: (x) => this.shows(x),
    });
  }

  private forgetInGroupsOn(link: ServerLink, id: string) {
    const next = stripSessionFromGroups(link.data.groups, id);
    if (next) link.data.groups = next;
  }

  private forgetInGroups(id: string) {
    if (this.link) this.forgetInGroupsOn(this.link, id);
  }

  private guardGroupLimit(group: Group | undefined, sessionId?: string): boolean {
    if (canAddToGroup(group, sessionId)) return true;
    this.toast(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }), "error");
    return false;
  }

  /** The focused session is gone: focus its neighbour (see `neighbourOf`) if there is one, else fall back to a blank chat. */
  private leave(next?: string) {
    if (this.graphOpen) {
      const gone = this.activeId;
      if (this.graphPeek?.server === this.serverId && this.graphPeek?.session === gone) this.graphPeek = null;
      if (this.graphFrom?.server === this.serverId && this.graphFrom?.session === gone) {
        this.graphFrom = next && this.serverId ? { server: this.serverId, session: next } : null;
      }
      this.activeId = null;
      try {
        localStorage.removeItem(this.activeKey);
      } catch {
        /* ignore */
      }
      this.resetNewChatDraft();
      return;
    }
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
    return this.api ? this.api.allSessions(true) : [];
  }

  /** Every session, active and closed (for /tree). */
  async listAll(): Promise<Session[]> {
    return this.api ? this.api.allSessions() : [];
  }

  /* ---------- navigation ---------- */

  newChat() {
    this.graphOpen = false;
    this.graphPeek = null;
    this.rememberPrevious();
    this.activeId = null;
    try {
      localStorage.removeItem(this.activeKey);
    } catch {
      /* ignore */
    }
    this.sidebar.open = false;
    this.resetNewChatDraft();
  }

  private resetNewChatDraft() {
    // A new chat starts from the server default, not from a model picked in an earlier new chat.
    const d = this.serverDefault;
    if (d && this.models.some((m) => m.provider === d.provider && m.id === d.model && m.configured && m.available !== false))
      this.updateDraft(draftFromDefault(d));
    else {
      this.ensureDraftModel();
      this.updateDraft({ serviceTier: this.startingTier(this.draft.provider, this.draft.model) });
    }
  }

  /**
   * Start a new chat as a real session: it is created at once from the draft (pending model settings and working
   * directory) and shows up in the sidebar as an active "New session" right away. Without a usable model, or if the
   * server refuses, it falls back to the blank new-chat screen. Every call creates a fresh session, even if an
   * empty one is already open.
   */
  async startChat(): Promise<void> {
    this.resetNewChatDraft();
    const link = this.link;
    const d = this.draft;
    if (!link || !d.model) return this.newChat();
    const sid = link.id;
    const cwd = this.workdir === "." ? undefined : this.workdir;
    try {
      const s = await link.api.createSession({
        cwd,
        provider: d.provider,
        model: d.model,
        thinkingLevel: normalizeThinking(d.thinkingLevel),
        serviceTier: d.serviceTier,
      });
      if (this.links[sid] !== link) return;
      if (!link.data.sessions.some((x) => x.id === s.id)) link.data.sessions.unshift(s);
      if (this.serverId === sid) await this.openSession(s.id, true);
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("새 대화를 만들지 못했습니다"));
    }
  }

  /**
   * `/new` (and the new-chat shortcut): start another conversation beside the open one, which stays where it is (in the
   * sidebar and, in a group, in its pane). The newcomer starts in the focused session's working directory and with the
   * new-chat defaults. Without an open chat this is a plain `startChat`.
   */
  async newChatInPane(): Promise<void> {
    const link = this.link;
    const from = this.session(this.activeId);
    if (!link || !from) return this.startChat();
    const sid = link.id;
    this.resetNewChatDraft();
    const d = this.draft;
    let made: Session;
    try {
      made = await link.api.createSession({
        cwd: workDir(from),
        provider: d.provider,
        model: d.model,
        thinkingLevel: d.thinkingLevel,
        serviceTier: d.serviceTier,
      });
    } catch (e) {
      this.probeIfNetwork(link, e);
      return this.fail(e, t("새 대화를 만들지 못했습니다"));
    }
    if (this.links[sid] !== link) return;
    if (!link.data.sessions.some((x) => x.id === made.id)) link.data.sessions.unshift(made);
    if (this.serverId === sid) await this.openSession(made.id, true);
  }

  /**
   * `/clear` (and its shortcut): start over in the focused pane only. The pane's session is swapped for a new one (same
   * working directory and model settings), in a group as well as outside one, and the rest of the group stays as it is.
   * The old chat is closed (still on the server, reopened from the conversation list). Without an open chat this is a
   * plain `startChat`.
   */
  async clearChatInPane(): Promise<void> {
    const link = this.link;
    const from = this.session(this.activeId);
    const g = from && this.groupOf(from.id);
    if (!link || !from) return this.startChat();
    const sid = link.id;
    let made: Session;
    try {
      made = await link.api.createSession({
        cwd: workDir(from),
        provider: from.provider,
        model: from.model,
        thinkingLevel: from.thinkingLevel,
        serviceTier: from.serviceTier,
      });
    } catch (e) {
      this.probeIfNetwork(link, e);
      return this.fail(e, t("새 대화를 만들지 못했습니다"));
    }
    if (this.links[sid] !== link) return;
    if (!link.data.sessions.some((x) => x.id === made.id)) link.data.sessions.unshift(made);
    // Swap layout and focus in the same tick, and only then close the old session: the screen never passes through a
    // state where the focused session is gone or outside its group (that made the whole app flash).
    const saving = g ? this.saveLayout(g.id, replaceSession(g.layout, from.id, made.id), true, sid) : Promise.resolve();
    const opening = this.serverId === sid ? this.openSession(made.id) : Promise.resolve();
    await Promise.all([saving, opening]);
    if (g) void this.refreshGroups(sid); // the server is the authority on who is in which group
    // The replaced session leaves the active list instead of dropping out of the group as a loose session.
    try {
      await link.api.patchSession(from.id, { closed: true });
      if (this.links[sid] !== link) return;
      link.data.sessions = link.data.sessions.filter((x) => x.id !== from.id);
      link.data.running[from.id] = false;
      delete link.data.compacting[from.id];
      link.data.awaiting[from.id] = 0;
      delete link.data.unread[from.id];
      delete link.data.failed[from.id];
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("닫지 못했습니다"), this.serverId === sid ? from.id : null);
    }
  }

  /**
   * Unfold the sidebar rows that hold `id`'s folder (its project and its server), so the folder whose tabs the tab bar now
   * shows is listed rather than hidden under a folded node. The folder itself stays as the user left it.
   */
  private revealRow(id: string): void {
    const sid = this.serverId;
    if (!sid) return;
    // the folder as the sidebar lists it (a group's is the one it was placed under), else the pane's own directory
    const path = tabOf(this.dirs, id)?.dir.path ?? this.memberDir(id);
    const project = path ? this.blocksByServer[sid]?.find((b) => b.kind === "project" && b.dirs.some((d) => d.path === path)) : undefined;
    if (project?.kind === "project") this.sidebar.reveal(projectKey(sid, project.root));
    this.sidebar.reveal(sid);
  }

  /**
   * Focus a session (showing its group if it has one). `reveal` false leaves the sidebar's folds alone (restoring what
   * was open on connect is not the user opening something).
   */
  async openSession(id: string, force = false, reveal = true) {
    if (!this.api) return;
    // opening a chat leaves the graph, unless it is the one the graph's quick look shows
    if (this.graphPeek?.session !== id) this.graphOpen = false;
    if (!force && this.activeId === id && (this.chats[id] || isTerminalId(id))) {
      // already open: only make sure its row can be seen (it may sit under a fold the user made since)
      if (reveal) this.revealRow(id);
      this.sidebar.open = false;
      return;
    }
    if (this.activeId !== id) this.rememberPrevious();
    this.activeId = id;
    write(this.activeKey, id);
    const g = this.groupOf(id);
    if (g) this.lastPane[g.id] = id;
    const at = this.serverId ? tabOf(this.dirs, id) : null;
    if (at && this.serverId) this.lastTabIn[`${this.serverId}\u0000${at.dir.path}`] = at.tab.id;
    // a tab outside the project shown in the strip: back to one folder's tabs
    const p = this.tabProject;
    if (at && p && (p.serverId !== this.serverId || !this.projectDirs(p.serverId, p.root)?.some((d) => d.path === at.dir.path))) this.tabProject = null;
    if (reveal) this.revealRow(id);
    delete this.unread[id];
    delete this.failed[id];
    notifications.read(id);
    const cwd = this.memberDir(id);
    if (cwd) this.setWorkdir(this.relPath(cwd));
    this.sidebar.open = false;
    if (isTerminalId(id)) return;
    await this.ensureChat(id, force);
  }

  /**
   * The pointer is on a conversation's row: start reading its transcript so the click finds it ready (or nearly) instead of
   * starting the request then. It joins the cached transcripts, so events keep it current, and is the first to go when the
   * cache is trimmed (it was never seen).
   */
  prefetchChat(serverId: string, id: string) {
    if (serverId !== this.serverId || isTerminalId(id) || this.chats[id] || !this.session(id)) return;
    void this.ensureChat(id);
  }

  /** Keep the server's sidebar/tab activity aligned with what a session load or catch-up just read. */
  private syncChatStatus(link: ServerLink, chat: ChatState, kind: "load" | "catchUp") {
    if (this.links[link.id] !== link) return;
    if (this.chats[chat.id] && this.chats[chat.id] !== chat) return;
    const active = Boolean(chat.running || chat.compacting);
    if (Boolean(link.data.running[chat.id]) !== active) link.data.running[chat.id] = active;
    if (!active) delete link.data.compacting[chat.id];
    if (kind === "load") {
      const awaiting = Object.values(chat.tools).filter((t) => t.state === "awaiting_input").length;
      if ((link.data.awaiting[chat.id] ?? 0) !== awaiting) link.data.awaiting[chat.id] = awaiting;
    }
    // If compaction finished while disconnected, flush messages held behind it now instead of stranding them.
    if (!chat.compacting && chat.held.length && this.link === link && this.chats[chat.id] === chat) {
      void this.flushHeld(chat);
    }
  }

  /** Make sure a session's transcript is loaded. `fresh` reloads it from the server. */
  async ensureChat(id: string, fresh = false): Promise<void> {
    const api = this.api;
    const link = this.link;
    if (!api || !link) return;
    if (this.chats[id] && !fresh) return;
    // Coming back to a conversation already on screen: reload it in place so the old transcript stays visible
    // (no skeleton) until the new one replaces it.
    const shown = this.chats[id];
    if (shown?.ready) {
      await shown.load();
      if (this.chats[id] !== shown) return;
      if (shown.notFound) {
        const { [id]: _gone, ...rest } = this.chats;
        this.chats = rest;
        if (this.activeId === id) this.newChat();
      }
      return;
    }
    const chat = new ChatState(id, api, (c, kind) => this.syncChatStatus(link, c, kind));
    this.chats = { ...this.chats, [id]: chat };
    await chat.load();
    if (this.chats[id] !== chat) return;
    if (chat.notFound) {
      const { [id]: _gone, ...rest } = this.chats;
      this.chats = rest;
      if (this.activeId === id) this.newChat();
    }
  }

  /**
   * Keep exactly the visible sessions' transcripts loaded (called whenever what is on screen changes).
   * Focusing a session counts as having seen what it finished; the other panes of its group keep their mark.
   */
  syncChats(ids: string[]) {
    const keep = new Set(ids);
    // Recently seen transcripts stay in memory (events keep applying to them), so switching back is instant.
    const now = Date.now();
    for (const id of ids) this.chatUsed.set(id, now);
    const spare = Object.keys(this.chats)
      .filter((id) => !keep.has(id))
      .sort((a, b) => (this.chatUsed.get(b) ?? 0) - (this.chatUsed.get(a) ?? 0))
      .slice(0, KEEP_CHATS);
    const kept = new Set([...keep, ...spare]);
    for (const id of this.chatUsed.keys()) if (!kept.has(id)) this.chatUsed.delete(id);
    const stale = Object.keys(this.chats).filter((id) => !kept.has(id));
    // A cached transcript coming back on screen shows at once; while the event stream stayed online it only needs a
    // lightweight catchUp() (status/context/usage) instead of reloading up to 5000 messages on every tab switch.
    for (const id of ids) {
      // One read moments ago (a prefetch on hover) is current: events have kept it so since.
      const chat = this.chats[id];
      if (chat?.ready && !this.lastVisible.has(id) && !chat.fresh) {
        if (this.link?.online) void chat.catchUp();
        else void chat.load();
      }
    }
    this.lastVisible = keep;
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

  /** Put `text` into the composer of `paneId` at the caret (the composer consumes it once). */
  insertIntoComposer(paneId: string, text: string) {
    this.insertText = { paneId, text };
  }

  /** `sid`: the session the message is about, so it appears inside that session's pane (see SessionToasts). */
  toast(text: string, tone: Toast["tone"] = "info", sid?: string | null, action?: Toast["action"], icon?: Toast["icon"]) {
    this.feedback.toast(text, tone, sid, action, icon);
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
    clientRequestId?: string,
  ): Promise<boolean> {
    const link = this.link;
    const api = link?.api;
    if (!api || !link) return false;
    if (this.isSending(to)) return void this.toast(t("이전 메시지를 보내는 중입니다. 잠시 후 다시 시도하세요"), "error", to), false;
    text = text.trim();
    if (!text && !images.length && !files.length) return false;
    if (!text) text = files.length && !images.length ? t("(첨부한 파일을 봐 주세요)") : t("(첨부한 이미지를 봐 주세요)");
    const hasAttachments = images.length > 0 || files.length > 0;
    const estimatedTotal =
      images.reduce((n, img) => n + img.data.length, 0) +
      files.reduce((n, f) => n + f.data.length, 0);
    const tx = this.beginSend(link.id, to, hasAttachments, estimatedTotal);
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
          serviceTier: d.serviceTier,
        });
        if (tx.abort.signal.aborted) return false;
        // Switched servers while createSession was slow: do not attach the old server's session to the new server.
        if (this.api !== api || this.link !== link) return false;
        if (!this.sessions.some((x) => x.id === s.id)) this.sessions.unshift(s);
        // Load the new chat off-screen and put the prompt in it first, so the pane goes from the welcome screen
        // straight to the sent message instead of flashing a skeleton and an empty transcript in between.
        const fresh = new ChatState(s.id, api, (c, kind) => { this.syncChatStatus(link, c, kind); });
        await fresh.load();
        if (tx.abort.signal.aborted) return false;
        if (this.api !== api || this.link !== link) return false;
        if (!fresh.ready) throw new Error(fresh.loadError || t("불러오지 못했습니다"));
        fresh.addOptimisticUser(text, images, files.map((f) => ({ path: "", name: f.name, size: f.size, mimeType: f.mimeType })));
        this.chats = { ...this.chats, [s.id]: fresh };
        await this.openSession(s.id);
        if (tx.abort.signal.aborted) return false;
        if (this.api !== api || this.link !== link) return false;
        to = s.id;
        tx.migrate(to);
        seeded = true;
      }
      const chat = this.chatOf(to);
      if (!chat) return false;

      // During a compaction the model context is being rewritten: wait in the queue and go out right after it.
      if (chat.compacting && !chat.running) {
        chat.held.push({ text, images, files, at: Date.now() });
        chat.requestBottom();
        return true;
      }

      const mode: SendMode = chat.running ? "follow_up" : "prompt";
      if (mode === "prompt" && !seeded) chat.addOptimisticUser(text, images, files.map((f) => ({ path: "", name: f.name, size: f.size, mimeType: f.mimeType })));
      chat.requestBottom();
      try {
        await api.send(chat.id, text, mode, images.length ? images : undefined, files.length ? files : undefined, {
          ...(clientRequestId ? { clientRequestId } : {}),
          signal: tx.abort.signal,
          ...(hasAttachments ? { onProgress: tx.onProgress } : {}),
        });
      } catch (e) {
        if (mode === "prompt") chat.dropOptimisticUser();
        throw e;
      }
      return true;
    } catch (e) {
      if (tx.abort.signal.aborted && (e as Error)?.name === "AbortError") return false;
      this.probeIfNetwork(link, e);
      this.fail(e, t("보내지 못했습니다"), to);
      return false;
    } finally {
      tx.dispose();
    }
  }

  /**
   * Send what was held during a compaction: the first starts the run, the rest queue behind it. What could not go out
   * (a failed send, a stop meanwhile) goes back to the input instead of being lost.
   */
  private async flushHeld(chat: ChatState): Promise<void> {
    if (chat.compacting || !chat.held.length) return;
    const list = chat.held.splice(0);
    for (const [i, h] of list.entries()) {
      const ok = i === 0 ? await this.send(h.text, h.images, chat.id, h.files) : await this.queue(h.text, h.images, chat.id, h.files);
      if (!ok) return void chat.restored.push(...list.slice(i));
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
    clientRequestId?: string,
  ): Promise<boolean> {
    const chat = this.chatOf(to);
    const link = this.link;
    const api = link?.api;
    text = text.trim();
    if (!api || !link || !chat || (!text && !images.length && !files.length)) return false;
    if (!text) text = files.length && !images.length ? t("(첨부한 파일을 봐 주세요)") : t("(첨부한 이미지를 봐 주세요)");
    const hasAttachments = images.length > 0 || files.length > 0;
    const estimatedTotal =
      images.reduce((n, img) => n + img.data.length, 0) +
      files.reduce((n, f) => n + f.data.length, 0);
    const tx = this.beginSend(link.id, chat.id, hasAttachments, estimatedTotal);
    chat.requestBottom();
    // Kept until delivered: a stop drops it on the server, and then it goes back to the input with its attachments.
    const own: Outgoing = { text, images, files, at: Date.now(), pending: true };
    chat.mine.push(own);
    const notSent = () => (this.toast(t("작업이 중지되어 보내지 않았습니다"), "error", chat.id), false);
    try {
      await api.send(chat.id, text, mode, images.length ? images : undefined, files.length ? files : undefined, {
        ...(clientRequestId ? { clientRequestId } : {}),
        signal: tx.abort.signal,
        ...(hasAttachments ? { onProgress: tx.onProgress } : {}),
      });
      own.pending = false;
      // Accepted, then dropped by a stop before this answer came back: the caller still holds it, so it stays there.
      return own.returned ? notSent() : true;
    } catch (e) {
      own.pending = false;
      const i = chat.mine.indexOf(own);
      if (i >= 0) chat.mine.splice(i, 1);
      if (tx.abort.signal.aborted && (e as Error)?.name === "AbortError") return false;
      // The run was stopped: it takes nothing more, and starting a new run with this text is not what was asked.
      // The caller keeps the text (this returns false), to send again on purpose.
      if (e instanceof ApiError && e.status === 409 && (e.data?.reason === "stopped" || chat.stopped)) return notSent();
      if (e instanceof ApiError && e.status === 409) {
        // The run ended a moment ago: start a new one. Release our sending slot first so `send` can take it.
        tx.dispose();
        for (let i = 0; i < 40 && this.isSending(to); i++) await new Promise((r) => setTimeout(r, 50));
        return this.send(text, images, to, files, clientRequestId);
      }
      this.probeIfNetwork(link, e);
      this.fail(e, failMsg, chat.id);
      return false;
    } finally {
      tx.dispose();
    }
  }

  steer = (text: string, images: ImageBlock[] = [], to = this.activeId, files: UploadFile[] = [], clientRequestId?: string) =>
    this.during("steer", text, images, t("끼워 넣지 못했습니다"), to, files, clientRequestId);
  queue = (text: string, images: ImageBlock[] = [], to = this.activeId, files: UploadFile[] = [], clientRequestId?: string) =>
    this.during("follow_up", text, images, t("대기열에 추가하지 못했습니다"), to, files, clientRequestId);

  /** Open a file preview (null = closed) */
  filePreview = $state<{ sessionId: string; file: FileRef } | null>(null);
  openFile(sessionId: string, file: FileRef) {
    this.filePreview = { sessionId, file };
  }

  /** Bumped when the server (re)loads its extensions, so lists that come from them are read again. */
  serverExtensionsTick = $state(0);
  /** Commands and tools that extensions inside the server provide; refreshed when the server (re)loads them. */
  serverCommands = $state<{ name: string; description?: string; args?: string; extension: string }[]>([]);
  async refreshServerExtensions(serverId?: string, opts?: { skipTools?: boolean }) {
    // Another server's lists are read by whoever shows them; commands and tools belong to the open one.
    if (serverId && serverId !== this.serverId) { this.serverExtensionsTick++; return; }
    const api = this.api;
    if (!api) return;
    try {
      const [list, tools] = await Promise.all([api.serverExtensions(), opts?.skipTools ? Promise.resolve(null) : api.tools()]);
      if (api !== this.api) return;
      this.serverCommands = list.commands;
      if (tools && this.link) this.link.tools = tools.tools;
      this.serverExtensionsTick++;
    } catch { /* unreachable: nothing to show */ }
  }

  /** Questions and settings approvals asked by extensions (`sdk.dialog`, configuration changes), one at a time. */
  readonly extensionRequests = new ExtensionRequests();

  /** Queue manager dialog: the session whose queued messages are listed. null = closed. */
  queueDialog = $state<string | null>(null);
  /** The message the queue dialog opens on (its detail view) instead of the list; the dialog takes it once and clears it. */
  queueItem = $state<{ mode: "steer" | "follow_up"; text: string; deferred?: boolean } | null>(null);
  openQueue(id: string | null = this.activeId, item: { mode: "steer" | "follow_up"; text: string; deferred?: boolean } | null = null) {
    if (!id || !this.chatOf(id)?.waiting.length) return void this.toast(t("취소할 대기열이 없습니다"), "error", id);
    this.queueItem = item;
    this.queueDialog = id;
  }

  /** Remove one not-yet-delivered steer/queue message. The chat list updates from the `message_dequeued` event. */
  async cancelQueued(item: { mode: "steer" | "follow_up"; text: string; deferred?: boolean }, id: string | null = this.queueDialog): Promise<boolean> {
    const chat = this.chatOf(id);
    if (!this.api || !chat) return false;
    const h = item.mode === "follow_up" && !item.deferred ? chat.held.findIndex((x) => x.text === item.text) : -1;
    if (h >= 0) {
      const [held] = chat.held.splice(h, 1);
      chat.restored.push({ ...held!, byHand: true });
      return true;
    }
    // Taken now: the `message_dequeued` event may drop it from `mine` before the answer comes back.
    const own = chat.mine.find((m) => !m.pending && m.text === item.text);
    try {
      const r = await this.api.cancelQueued(chat.id, item.mode, item.text, item.deferred ? true : undefined);
      if (!r.cancelled) {
        // Already delivered (or gone): drop the stale row so the list matches the server.
        const i = chat.queued.findIndex((x) => x.mode === item.mode && x.text === item.text && !!x.deferred === !!item.deferred);
        if (i >= 0) chat.queued.splice(i, 1);
        this.toast(t("이미 전달되어 취소할 수 없습니다"), "error", chat.id);
        return false;
      }
      if (own) {
        // Cancelled in time, and sent from here: back to the input with its pictures and files, to edit or re-send.
        chat.restored.push({ ...own, byHand: true });
      } else if (chat.id === this.activeId) {
        // A message from elsewhere (a peer, another device): only its text is known (without the server's hint blocks).
        this.prefill = queuedShown(item.text);
      }
      return true;
    } catch (e) {
      if ((e as { code?: string })?.code === "not_found") {
        // Session or route is gone on the server: the row can never be cancelled, so drop it.
        const i = chat.queued.findIndex((x) => x.mode === item.mode && x.text === item.text && !!x.deferred === !!item.deferred);
        if (i >= 0) chat.queued.splice(i, 1);
      }
      this.fail(e, t("대기열에서 빼지 못했습니다"), chat.id);
      return false;
    }
  }

  async abort(id: string | null = this.activeId) {
    const link = this.link;
    if (!link || !id) return;
    // Messages held back for a compaction being stopped would otherwise go out the moment it ends.
    this.chatOf(id)?.restoreHeld();
    try {
      await link.api.abort(id);
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, undefined, this.serverId === link.id ? id : null);
    }
  }

  async compact(customInstructions?: string, id = this.activeId): Promise<boolean> {
    const chat = this.chatOf(id);
    const api = this.api;
    if (!chat || !api || this.net !== "online") {
      this.toast(t("서버에 연결하고 압축할 대화를 여세요"), "error", id);
      return false;
    }
    if (chat.compaction?.supported === false) {
      this.toast(t("이 서버 버전은 컨텍스트 압축을 지원하지 않습니다. 서버를 업데이트하세요"), "error", id);
      return false;
    }
    // While it works, /compact waits in the queue like a follow-up: the server runs it when the run ends.
    if (chat.ready && !chat.loadError && chat.running && !chat.compacting) {
      const label = customInstructions?.trim() ? `/compact ${customInstructions.trim()}` : "/compact";
      try {
        await api.queueCommand(chat.id, label, customInstructions);
        return true;
      } catch (e) {
        // The run ended a moment ago: nothing to wait for, compact right away.
        if (!(e instanceof ApiError && e.status === 409)) {
          this.fail(e, t("대기열에 추가하지 못했습니다"), chat.id);
          return false;
        }
      }
    }
    if (!chat.ready || chat.loadError || this.isSending(id) || chat.running || chat.compacting) {
      this.toast(t("진행 중인 작업이 끝난 뒤 압축하세요"), "error", id);
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
    const link = this.link;
    const chat = this.chatOf(id);
    if (!link || !chat || chat.compacting) return;
    try {
      await link.api.retry(chat.id);
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("다시 시도하지 못했습니다"), this.serverId === link.id ? chat.id : null);
    }
  }

  /**
   * Go on with an answer the output limit cut off. The model's context already holds the cut text (it stays in the
   * transcript), so a short prompt is enough: it picks up where the text stopped instead of starting over.
   */
  continueCut(id = this.activeId): Promise<boolean> {
    return this.send(t("이어서 작성해 주세요. 앞부분은 다시 쓰지 말고 끊긴 곳부터 바로 시작해 주세요."), [], id);
  }

  async answerQuestion(toolCallId: string, answer: string | null | (string | null)[], id = this.activeId) {
    const link = this.link;
    const chat = this.chatOf(id);
    if (!link || !chat) return;
    try {
      await link.api.answer(chat.id, toolCallId, answer);
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("답변을 보내지 못했습니다"), this.serverId === link.id ? chat.id : null);
      void chat.load();
    }
  }

  /**
   * Move a conversation to another working tree of its repository (`dir`; its own folder brings it home): its agent
   * works there from its next message, and the sidebar lists it there. The toast offers to move it back.
   */
  async moveWorkdir(id: string, dir: string, undo = true, serverId?: string | null): Promise<boolean> {
    const link = this.linkOf(serverId);
    const s = link?.sessionById.get(id);
    if (!link || !s) return false;
    const sid = link.id;
    const api = link.api;
    const from = workDir(s);
    if (dir === from) return true;
    try {
      const updated = await api.patchSession(id, { workDir: dir === s.cwd ? null : dir });
      if (this.links[sid] !== link) return false;
      const i = link.data.sessions.findIndex((x) => x.id === id);
      if (i >= 0) link.data.sessions[i] = updated;
      const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
      this.toast(t("'{title}'의 작업 폴더를 {dir}(으)로 옮겼습니다", { title: sessionTitle(s.title), dir: name }), "ok", null,
        undo ? { label: t("되돌리기"), run: () => void this.moveWorkdir(id, from, false, sid) } : undefined);
      return true;
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("작업 폴더를 옮기지 못했습니다"), this.serverId === sid ? id : null);
      return false;
    }
  }

  async rename(id: string, title: string, serverId?: string | null) {
    title = title.trim();
    const link = this.linkOf(serverId);
    if (!link || !title) return;
    const sid = link.id;
    try {
      const s = await link.api.patchSession(id, { title });
      if (this.links[sid] !== link) return;
      const i = link.data.sessions.findIndex((x) => x.id === id);
      if (i >= 0) link.data.sessions[i] = s;
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("이름을 바꾸지 못했습니다"), this.serverId === sid ? id : null);
    }
  }

  async remove(id: string, serverId?: string | null): Promise<boolean> {
    const link = this.linkOf(serverId);
    if (!link) return false;
    const sid = link.id;
    try {
      const next = this.serverId === sid ? this.neighbourOf(id) : undefined;
      await link.api.deleteSession(id);
      if (this.links[sid] !== link) return false;
      this.forgetInGroupsOn(link, id);
      link.data.sessions = link.data.sessions.filter((x) => x.id !== id);
      delete link.data.running[id];
      delete link.data.compacting[id];
      delete link.data.awaiting[id];
      delete link.data.unread[id];
      delete link.data.failed[id];
      this.cleanupDeletedSession(sid, id);
      if (this.serverId === sid && this.activeId === id) this.leave(next);
      void link.refreshWorkspace();
      return true;
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("삭제하지 못했습니다"), this.serverId === sid ? id : null);
      return false;
    }
  }

  /* ---------- groups ---------- */

  /** Serialize layout PATCHes per group and coalesce rapid edits so the server always ends on the latest layout. */
  private layoutSaveBusy = new Set<string>();
  private layoutSavePending = new Map<string, { layout: Layout; resolvers: ((ok: boolean) => void)[] }>();

  /** Show a new layout at once, then save it; rapid persists are serialized so the server keeps the latest layout. */
  async saveLayout(id: string, layout: Layout, persist = true, serverId?: string | null): Promise<boolean> {
    const link = this.linkOf(serverId);
    if (!link) return false;
    const sid = link.id;
    const i = link.data.groups.findIndex((g) => g.id === id);
    if (i < 0) return false;
    link.data.groups[i] = { ...link.data.groups[i]!, layout };
    if (!persist) return true;
    const key = `${sid}\u0000${id}`;
    if (this.layoutSaveBusy.has(key)) {
      return new Promise<boolean>((resolve) => {
        const queued = this.layoutSavePending.get(key);
        if (queued) {
          queued.layout = layout;
          queued.resolvers.push(resolve);
        } else {
          this.layoutSavePending.set(key, { layout, resolvers: [resolve] });
        }
      });
    }
    this.layoutSaveBusy.add(key);
    let current = layout;
    let ok = true;
    let batchResolvers: ((v: boolean) => void)[] = [];
    try {
      while (true) {
        try {
          const g = await link.api.patchGroup(id, { layout: current });
          ok = true;
          if (this.links[sid] === link && !this.layoutSavePending.has(key)) {
            const j = link.data.groups.findIndex((x) => x.id === id);
            if (j >= 0) link.data.groups[j] = g;
          }
        } catch (e) {
          ok = false;
          if (!this.layoutSavePending.has(key)) {
            this.probeIfNetwork(link, e);
            this.fail(e, t("그룹을 저장하지 못했습니다"));
            void this.refreshGroups(sid);
          }
        }
        for (const r of batchResolvers) r(ok);
        batchResolvers = [];
        const next = this.layoutSavePending.get(key);
        if (!next || this.links[sid] !== link) {
          this.layoutSavePending.delete(key);
          if (next) for (const r of next.resolvers) r(false);
          break;
        }
        this.layoutSavePending.delete(key);
        current = next.layout;
        batchResolvers = next.resolvers;
      }
      return ok;
    } finally {
      this.layoutSaveBusy.delete(key);
    }
  }

  /**
   * Arrange a split group's panes into a clean preset layout.
   * When `presetId` is omitted, applies the recommended layout for the pane count (or cycles to the next preset if already arranged).
   */
  async arrangeGroup(id: string, presetId?: LayoutPresetId, serverId?: string | null): Promise<LayoutPreset | null> {
    const link = this.linkOf(serverId);
    if (!link) return null;
    const g = link.data.groups.find((x) => x.id === id);
    if (!g) return null;
    const preset = presetId ? findPreset(g.layout, presetId) : nextArrangedPreset(g.layout);
    if (!preset) {
      this.toast(t("적용할 레이아웃이 없습니다"), "error");
      return null;
    }
    if (link.id === this.serverId) {
      if (this.zoomId && layoutHas(g.layout, this.zoomId)) this.zoomId = null;
      if (this.isFull(g.id)) this.toggleFull(g.id);
    }
    const saved = await this.saveLayout(g.id, preset.layout, true, serverId);
    if (saved) this.toast(t("{name} 레이아웃을 적용했습니다", { name: preset.label }));
    return saved ? preset : null;
  }

  async refreshGroups(serverId?: string | null): Promise<void> {
    const link = this.linkOf(serverId);
    if (!link) return;
    const sid = link.id;
    try {
      const groups = await link.api.groups();
      if (this.links[sid] === link) link.data.groups = groups;
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
      if (!this.guardGroupLimit(g, id)) return;
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
    if (!this.guardGroupLimit(g)) return null;
    const base = this.session(target);
    const d = this.draft;
    if (!base && !d.model) {
      this.toast(t("사용할 수 있는 모델이 없습니다. 모델 선택창에서 연결을 추가하세요."), "error");
      return null;
    }
    try {
      const made = await api.createSession({
        cwd: workDir(from),
        provider: base?.provider ?? d.provider,
        model: base?.model ?? d.model,
        thinkingLevel: base?.thinkingLevel ?? normalizeThinking(d.thinkingLevel),
        serviceTier: base ? base.serviceTier : d.serviceTier,
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
          serviceTier: d.serviceTier,
        });
      } catch (e) {
        return this.fail(e, t("새 대화를 만들지 못했습니다"));
      }
      if (!this.sessions.some((x) => x.id === from!.id)) this.sessions.unshift(from);
    }
    const g = this.groupOf(from.id);
    if (!this.guardGroupLimit(g)) return;
    let made: Session;
    try {
      made = await api.createSession({
        cwd: workDir(from),
        provider: from.provider,
        model: from.model,
        thinkingLevel: from.thinkingLevel,
        serviceTier: from.serviceTier,
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
    if (beside && !this.guardGroupLimit(this.groupOf(beside.target))) return null;
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

  /** A terminal beside the focused pane: below by default, or the given side: it starts where that pane works. */
  async splitTerminal(zone: Zone = "bottom"): Promise<void> {
    const id = this.activeId;
    const cwd = this.memberDir(id);
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
    if (!this.guardGroupLimit(this.groupOf(target))) return;
    try {
      const made = await api.createSession({ cwd, provider: d.provider, model: d.model, thinkingLevel: normalizeThinking(d.thinkingLevel), serviceTier: d.serviceTier });
      if (!this.sessions.some((x) => x.id === made.id)) this.sessions.unshift(made);
      await this.dropSession(made.id, target, zone);
    } catch (e) {
      this.fail(e, t("새 대화를 만들지 못했습니다"));
    }
  }

  async renameTerminal(id: string, title: string, serverId?: string | null): Promise<void> {
    title = title.trim();
    const link = this.linkOf(serverId);
    if (!link || !title) return;
    const sid = link.id;
    try {
      const x = await link.api.renameTerminal(id, title);
      if (this.links[sid] !== link) return;
      const i = link.data.terminals.findIndex((y) => y.id === id);
      if (i >= 0) link.data.terminals[i] = x;
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("이름을 바꾸지 못했습니다"), this.serverId === sid ? id : null);
    }
  }

  /** End the shell. A pinned terminal asks first (`sessionCloseConfirm`); `force` skips that. */
  async closeTerminal(id: string, serverId?: string | null, force = false): Promise<void> {
    const link = this.linkOf(serverId);
    if (!link) return;
    const sid = link.id;
    if (!force && !(await this.sessionClosing.request(id, sid))) return;
    if (this.links[sid] !== link) return;
    try {
      await link.api.closeTerminal(id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {
        this.probeIfNetwork(link, e);
        return this.fail(e, t("터미널을 닫지 못했습니다"), this.serverId === sid ? id : null);
      }
    }
    if (this.links[sid] !== link) return;
    this.dropTerminalOn(link, id);
  }

  private dropTerminalOn(link: ServerLink, id: string) {
    this.cleanupClosedTerminal(link.id, id);
    if (!link.data.terminals.some((x) => x.id === id)) return;
    const isOpen = this.serverId === link.id;
    const next = isOpen ? this.neighbourOf(id) : undefined;
    this.forgetInGroupsOn(link, id);
    link.data.terminals = link.data.terminals.filter((x) => x.id !== id);
    if (isOpen) {
      if (this.zoomId === id) this.zoomId = null;
      if (this.activeId === id) this.leave(next);
    }
  }

  /** The shell is gone (closed here, elsewhere, or it exited): forget it and move focus on. */
  dropTerminal(id: string) {
    if (this.link) this.dropTerminalOn(this.link, id);
  }

  async createGroup(layout: Layout, name?: string): Promise<Group | null> {
    const link = this.link;
    if (!link) return null;
    const sid = link.id;
    try {
      // the new group's tab takes the place of the tab the drop landed on (the pane split; `pair` puts it first or second)
      const before = this.dirs;
      const g = await link.api.createGroup({ layout, name: name || groupNameFor(panesOf(layout).map((id) => this.memberDir(id)), new Set(link.data.groups.map((g) => g.name))), ...(name ? {} : { autoName: true }) });
      if (this.links[sid] !== link) return null;
      if (!link.data.groups.some((x) => x.id === g.id)) link.data.groups.push(g);
      this.replaceTabs(before, panesOf(layout), [g.id], sid);
      // the server moved these sessions out of any group they were in
      await this.refreshGroups(sid);
      return g;
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("그룹을 만들지 못했습니다"));
      return null;
    }
  }

  /** Put a session into an existing group, beside everything else in it. */
  async addToGroup(id: string, groupId: string): Promise<void> {
    const link = this.link;
    if (!link) return;
    const sid = link.id;
    const g = link.data.groups.find((x) => x.id === groupId);
    if (!g || layoutHas(g.layout, id)) return;
    if (!this.guardGroupLimit(g, id)) return;
    await this.saveLayout(g.id, append(g.layout, id), true, sid);
    await this.refreshGroups(sid);
  }

  /** Take a session out of its group; a group left with a single session dissolves. */
  async leaveGroup(id: string, serverId?: string | null): Promise<void> {
    const link = this.linkOf(serverId);
    if (!link) return;
    const sid = link.id;
    const g = link.data.groups.find((x) => layoutHas(x.layout, id));
    if (!g) return;
    const next = layoutRemove(g.layout, id);
    if (worthKeeping(next)) await this.saveLayout(g.id, next, true, sid);
    else await this.deleteGroup(g.id, sid);
  }

  async renameGroup(id: string, name: string, serverId?: string | null): Promise<void> {
    name = name.trim();
    const link = this.linkOf(serverId);
    if (!link || !name) return;
    const sid = link.id;
    const i = link.data.groups.findIndex((g) => g.id === id);
    if (i < 0 || link.data.groups[i]!.name === name) return;
    const before = link.data.groups[i]!.name;
    link.data.groups[i] = { ...link.data.groups[i]!, name };
    try {
      const g = await link.api.patchGroup(id, { name });
      if (this.links[sid] !== link) return;
      const j = link.data.groups.findIndex((x) => x.id === id);
      if (j >= 0) link.data.groups[j] = g;
    } catch (e) {
      if (this.links[sid] === link) {
        const j = link.data.groups.findIndex((x) => x.id === id);
        if (j >= 0) link.data.groups[j] = { ...link.data.groups[j]!, name: before };
      }
      this.probeIfNetwork(link, e);
      this.fail(e, t("그룹 이름을 바꾸지 못했습니다"));
    }
  }

  /** Dissolve a group. Its sessions stay, as ordinary sessions. */
  async deleteGroup(id: string, serverId?: string | null): Promise<void> {
    const link = this.linkOf(serverId);
    if (!link) return;
    const sid = link.id;
    const g = link.data.groups.find((x) => x.id === id);
    const before = this.dirsByServer[sid] ?? NO_DIRS;
    try {
      await link.api.deleteGroup(id);
      if (this.links[sid] !== link) return;
      // what was in the group comes back as tabs of its own, where the group's tab was
      const showsOnLink = (x: string) => link.sessionById.has(x) || link.data.terminals.some((t) => t.id === x);
      if (g) this.replaceTabs(before, [id], panesOf(g.layout).filter(showsOnLink), sid);
      link.data.groups = link.data.groups.filter((x) => x.id !== id);
      this.cleanupDeletedGroup(sid, id);
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("그룹을 해제하지 못했습니다"));
    }
  }

  /** Branch `id` into a new chat holding the history up to and including `atSeq`. */
  async fork(id: string, atSeq?: number): Promise<boolean> {
    const link = this.link;
    if (!link) return false;
    const sid = link.id;
    try {
      const s = await link.api.forkSession(id, atSeq);
      if (this.links[sid] !== link) return false;
      if (!link.data.sessions.some((x) => x.id === s.id)) link.data.sessions.unshift(s);
      if (this.serverId !== sid) return true;
      // Forked from inside a group: the branch joins that group, right beside its source.
      const g = this.groupOf(id);
      if (g && !layoutHas(g.layout, s.id) && this.guardGroupLimit(g, s.id)) {
        await this.dropSession(s.id, id, "right");
      }
      if (this.serverId === sid) await this.openSession(s.id, true);
      this.toast(t("새 대화로 분기했습니다"), "ok", s.id);
      return true;
    } catch (e) {
      this.probeIfNetwork(link, e);
      this.fail(e, t("분기하지 못했습니다"), this.serverId === sid ? id : null);
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
    mergeServers(this.servers, checked.servers);
    this.saveServers();
    this.prefs.apply(checked.preferences);
    this.prefs.mergeBindings(checked.keybindings);
  }
  applyBackgroundConfiguration(document: ConfigurationDocument) {
    const checked = parseConfiguration(document);
    this.replaceServerList(replaceServers(this.servers, checked.servers));
    this.prefs.apply(checked.preferences);
  }
  /** A new server list from a document or a backup: save it, reconnect, and close the open server if it is gone. */
  private replaceServerList(servers: Server[]) {
    // The app's own server stays, first, whatever the document lists (documents carry no `local` flag).
    servers = pinLocal(servers, this.servers.find((s) => s.local));
    this.servers = servers;
    this.saveServers();
    this.syncLinks();
    if (this.serverId && !servers.some(s => s.id === this.serverId)) this.closeServer();
  }
  restoreConfiguration(value: unknown) {
    const parsed = parseAppBackup(value);
    this.replaceServerList(parsed.servers);
    this.prefs.apply(parsed.preferences);
    // A backup taken before shortcuts were part of it has none: leave the current ones.
    if (parsed.bindings) this.prefs.replaceBindings(parsed.bindings);
  }
}

export const app = new AppStore();
setGoalActivity((id) => {
  const g = app.goals.bySessionId(id, app.serverId);
  return g ? goalActivity(g.status) : null;
});

configureUiEnv({
  dark: () => app.prefs.resolvedDark,
  closeBinding: (action) => (app.prefs.recordingKey ? undefined : app.prefs.bindings[action]),
});
