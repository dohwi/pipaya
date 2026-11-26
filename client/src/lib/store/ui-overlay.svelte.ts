/**
 * UI overlay, modal, graph view, cross-component event ticks, and one-shot composer handoff state.
 * Separated from domain server/session data in `AppStore` so transient UI visibility has one clear owner.
 */
import type { SettingsFocus } from "../settings-focus";
import type { SettingsSectionAlias, SettingsTabId } from "../settings-search";
import type { PaletteSpec } from "../store-model";

/** What a video player carries from one surface to another (inline <-> viewer) so playback continues seamlessly. */
export interface VideoPlaybackState {
  time: number;
  rate: number;
  volume: number;
  muted: boolean;
  playing: boolean;
}

export interface ViewerImage {
  src: string;
  mimeType: string;
  /** File name offered when saving (otherwise `image-N.ext`). */
  name?: string;
  loadFull?: (signal?: AbortSignal) => Promise<string>;
  /** `"video"` slides play in the viewer's own player (default `"image"`). */
  kind?: "image" | "video";
  /** Video: snapshot the inline player's state and pause it. */
  getVideoState?: () => VideoPlaybackState | null;
  /** Video: hand the viewer's final state back to the inline player (slide change / close). */
  syncVideoState?: (state: VideoPlaybackState) => void;
}

export interface ViewerState {
  images: ViewerImage[];
  index: number;
}

export type SettingsTargetTab = SettingsTabId | SettingsSectionAlias;

export class UiOverlayState {
  /** Add-server / edit-server dialog: `null` = closed, `"new"` = add, otherwise the id being edited. */
  serverForm = $state<string | "new" | null>(null);
  /** The tab overview (the folder's tabs as a grid of cards, behind the tab count button) is open. */
  tabOverview = $state(false);
  /** The server whose conversation list (close / delete) is open, or null. */
  sessionsDialog = $state<string | null>(null);
  /** Narrows the open conversation list to one folder (`cwd`). */
  sessionsFilter = $state<{ cwd?: string } | null>(null);
  /** Open the directory picker. */
  dirPicker = $state(false);
  /** Images open in the full-screen viewer (null = closed). */
  viewer = $state<ViewerState | null>(null);
  /** Picker overlay opened by a slash command. */
  palette = $state.raw<PaletteSpec | null>(null);

  /** Cross-component reactive ticks (incremented to signal observers without tight coupling). */
  modelPickerTick = $state(0);
  queueSendTick = $state(0);
  findTick = $state(0);
  configTick = $state(0);
  voiceTick = $state(0);
  skillsTick = $state(0);
  mcpTick = $state(0);
  schedulesTick = $state(0);
  goalsTick = $state(0);

  /** One-shot composer handoffs. */
  prefill = $state<string | null>(null);
  insertText = $state<{ paneId: string; text: string } | null>(null);
  liveText = $state<{ paneId: string; text: string } | null>(null);
  replyTo = $state<{ text: string; who?: string } | null>(null);

  /** Feature & settings dialogs. */
  settingsOpen = $state(false);
  settingsTab = $state<SettingsTargetTab>("general");
  settingsServer = $state<string | "new" | null>(null);
  settingsDirect = false;
  settingsFocus = $state<SettingsFocus | null>(null);

  skillsDialog = $state<{ cwd: string; sessionId: string | null; skill?: string } | null>(null);
  mcpDialog = $state(false);
  goalDialog = $state<string | null>(null);
  schedulesDialog = $state(false);
  scheduleFor = $state<string | null>(null);
  scheduleEdit = $state<string | null>(null);
  subagentsDialog = $state<{ cwd: string } | null>(null);
  commandsDialog = $state<{ cwd: string } | null>(null);
  templatesDialog = $state<{ cwd: string } | null>(null);

  /** Graph view & quick-look peek state + modal back-navigation history. */
  graphOpen = $state(false);
  graphFrom = $state<{ server: string; session: string } | null>(null);
  graphPeek = $state<{ server: string; session: string } | null>(null);
  graphPeekHistory = $state<{ server: string; session: string }[]>([]);
  /** Chat quick-look modal: session (on the current or another server, open or closed) opened from a `@mention` chip. */
  chatPeek = $state<{ server: string; session: string } | null>(null);
  chatPeekHistory = $state<{ server: string; session: string }[]>([]);

  /** Read-only workspace file viewer side panel. */
  filesOpen = $state(false);

  openSessions(serverId: string, filter: { cwd?: string } | null = null) {
    this.sessionsFilter = filter;
    this.sessionsDialog = serverId;
  }

  openImage(images: ViewerImage[], index = 0) {
    if (!images.length) return;
    const clamped = Math.max(0, Math.min(index, images.length - 1));
    this.viewer = { images, index: clamped };
  }

  openGoal(id: string | null) {
    if (!id) return;
    this.goalDialog = id;
  }

  closePeek() {
    this.graphPeek = null;
    this.graphPeekHistory = [];
  }

  closeChatPeek() {
    this.chatPeek = null;
    this.chatPeekHistory = [];
  }

  openSettings(
    tab?: SettingsTargetTab,
    server: string | "new" | null = null,
    focus: SettingsFocus | null = null,
  ) {
    this.settingsFocus = focus;
    this.settingsDirect = tab !== undefined;
    this.settingsTab = tab ?? "general";
    this.settingsServer = server;
    this.settingsOpen = true;
  }

  openScheduleFor(sessionId: string) {
    this.scheduleFor = sessionId;
    this.openSettings("schedules");
  }

  openScheduleEdit(id: string) {
    this.scheduleEdit = id;
    this.openSettings("schedules");
  }
}
