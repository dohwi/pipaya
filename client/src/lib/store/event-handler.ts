import type { ChatState } from "../chat.svelte";
import { workspaceViewer } from "../workspace-viewer.svelte";
import { appEventsOf, serverEventOf } from "../extensions/event-forward";
import { extensions } from "../extensions/host.svelte";
import { announces } from "../feedback.svelte";
import type { NotificationSpec } from "../notification-contract";
import { notifications } from "../notifications";
import { K, read } from "../persist";
import type { ServerLink } from "../server-link.svelte";
import { settleCompactionRunning, type CompactionReason } from "../server-link-model";
import type { TerminalInfo } from "../terminal";
import type { Group, PipayaEvent, Session, ToolsInfo, WorkdirInfo } from "../types";

export interface BackgroundCueCallbacks {
  cue: (kind: "done" | "failed" | "ask") => void;
  announce: (sessionId: string, kind: "done" | "failed", serverId: string) => void;
  isGoalActive?: (sessionId: string) => boolean;
}

/**
 * Sound and in-app strip for a server that is not in view, with the same rules as the one in view: a stopped run is
 * silent, and an agent-to-agent run is silent while that server's own "quiet peers" is on. Runs before
 * `applyLinkEvent`, which changes the counts it reads.
 */
export function cueBackgroundEvent(link: ServerLink, e: PipayaEvent, cb: BackgroundCueCallbacks): void {
  const sid = e.sessionId;
  if (!sid) return;
  if (e.type === "run_finished") {
    const quiet = (e.data.origin === "peer" && read<unknown>(`${K.quietPeers}.${link.id}`, null) !== false) || (e.data.status === "ok" && !!cb.isGoalActive?.(sid));
    if (e.data.status === "aborted" || quiet) return;
    const bad = e.data.status === "error";
    cb.cue(bad ? "failed" : "done");
    cb.announce(sid, bad ? "failed" : "done", link.id);
  } else if (e.type === "question_requested" && !link.data.awaiting[sid]) {
    cb.cue("ask");
  }
}

export interface OpenEventContext {
  activeId: string | null;
  quietPeers: boolean;
  sessions: Session[];
  closedSessions?: Session[];
  groups: Group[];
  terminals: TerminalInfo[];
  running: Record<string, boolean>;
  compacting: Record<string, CompactionReason>;
  awaiting: Record<string, number>;
  unread: Record<string, boolean>;
  failed: Record<string, boolean>;
  chats: Record<string, ChatState>;
  setSessions(next: Session[]): void;
  setClosedSessions?(next: Session[]): void;
  setGroups(next: Group[]): void;
  setToolsInfo(next: ToolsInfo): void;
  setWorkdirInfo(next: WorkdirInfo): void;
  neighbourOf(id: string): string | undefined;
  forgetInGroups(id: string): void;
  leave(next?: string): void;
  dropFull(groupId: string): void;
  dropTerminal(id: string): void;
  onSessionClosed?(id: string): void;
  onSessionDeleted?(id: string): void;
  onGroupDeleted?(id: string): void;
  cue(kind: "done" | "failed" | "ask"): void;
  announce(sessionId: string, kind: "done" | "failed"): void;
  bumpSkills(): void;
  bumpMcp(): void;
  bumpSchedules(): void;
  bumpGoals(): void;
  isGoalActive?(sessionId: string): boolean;
  bumpConfig(): void;
  bumpVoice(): void;
  refreshWorkspace(): void;
  refreshProviders(): void;
  refreshServerExtensions(): void;
  refreshActivity(): void;
  syncLocales(): void;
  onClientSettings(data: { key?: unknown; updatedAt?: unknown; origin?: unknown }): void;
  refreshUsage(chat: ChatState): void;
  flushHeld(chat: ChatState): void;
}

/** Dispatch an event belonging to the currently viewed server, updating reactive state and triggering side effects. */
export function handleOpenServerEvent(ctx: OpenEventContext, e: PipayaEvent): void {
  const sid = e.sessionId;
  workspaceViewer.onEvent(e);
  for (const ev of appEventsOf(e)) extensions.emit(ev);
  const fromServer = serverEventOf(e);
  if (fromServer) {
    if (fromServer.kind === "entry" && sid) {
      ctx.chats[sid]?.addEntry(e.data as { id: number; extension: string; type: string; data: unknown; createdAt?: number });
    }
    extensions.emitServer(fromServer);
  } else if (e.type === "extensions_updated") {
    ctx.refreshServerExtensions();
  }

  switch (e.type) {
    case "notification": {
      const data = e.data as { deviceId: string; notification: NotificationSpec & { id: string; at: number } };
      void notifications.receive(data.deviceId, data.notification).catch(() => {});
      break;
    }
    case "session_unread": {
      const u = e.data as { sessionId: string; kind: "done" | "failed" | null };
      delete ctx.unread[u.sessionId];
      delete ctx.failed[u.sessionId];
      if (u.kind === "done") ctx.unread[u.sessionId] = true;
      else if (u.kind === "failed") ctx.failed[u.sessionId] = true;
      break;
    }
    case "device_revoked": {
      notifications.revoked((e.data as { deviceId: string }).deviceId);
      break;
    }
    case "session_created": {
      const s = e.data as Session;
      if (s.closed) {
        if (ctx.closedSessions && ctx.setClosedSessions) {
          ctx.setClosedSessions([s, ...ctx.closedSessions.filter((x) => x.id !== s.id)]);
        }
      } else {
        if (ctx.closedSessions && ctx.setClosedSessions) {
          ctx.setClosedSessions(ctx.closedSessions.filter((x) => x.id !== s.id));
        }
        if (!ctx.sessions.some((x) => x.id === s.id)) ctx.sessions.unshift(s);
      }
      ctx.refreshWorkspace();
      break;
    }
    case "session_updated": {
      const s = e.data as Session;
      const hide = s.closed;
      const next = hide ? ctx.neighbourOf(s.id) : undefined;
      if (hide) ctx.forgetInGroups(s.id);
      const i = ctx.sessions.findIndex((x) => x.id === s.id);
      if (i >= 0) ctx.sessions.splice(i, 1);
      if (ctx.closedSessions && ctx.setClosedSessions) {
        ctx.setClosedSessions(
          s.closed
            ? [s, ...ctx.closedSessions.filter((x) => x.id !== s.id)]
            : ctx.closedSessions.filter((x) => x.id !== s.id),
        );
      }
      if (s.closed) {
        ctx.running[s.id] = false;
        delete ctx.compacting[s.id];
        ctx.awaiting[s.id] = 0;
        delete ctx.unread[s.id];
        delete ctx.failed[s.id];
        ctx.onSessionClosed?.(s.id);
        if (ctx.activeId === s.id) ctx.leave(next);
        break;
      }
      ctx.sessions.unshift(s);
      break;
    }
    case "group_created":
    case "group_updated": {
      const g = e.data as Group;
      const i = ctx.groups.findIndex((x) => x.id === g.id);
      if (i >= 0) ctx.groups[i] = g;
      else ctx.groups.push(g);
      break;
    }
    case "group_deleted": {
      const id = (e.data as { id: string }).id;
      ctx.setGroups(ctx.groups.filter((x) => x.id !== id));
      ctx.dropFull(id);
      ctx.onGroupDeleted?.(id);
      break;
    }
    case "terminal_created":
    case "terminal_updated": {
      const x = e.data as TerminalInfo;
      const i = ctx.terminals.findIndex((y) => y.id === x.id);
      if (i >= 0) ctx.terminals[i] = x;
      else ctx.terminals.push(x);
      break;
    }
    case "terminal_closed":
      ctx.dropTerminal((e.data as { id: string }).id);
      break;
    case "session_deleted": {
      const id = e.data.id as string;
      const next = ctx.neighbourOf(id);
      ctx.forgetInGroups(id);
      ctx.setSessions(ctx.sessions.filter((x) => x.id !== id));
      if (ctx.closedSessions && ctx.setClosedSessions) {
        ctx.setClosedSessions(ctx.closedSessions.filter((x) => x.id !== id));
      }
      delete ctx.running[id];
      delete ctx.compacting[id];
      delete ctx.awaiting[id];
      delete ctx.unread[id];
      delete ctx.failed[id];
      ctx.onSessionDeleted?.(id);
      if (ctx.activeId === id) ctx.leave(next);
      break;
    }
    case "compaction_started":
      if (sid) {
        const reason = (e.data as { reason?: unknown } | null)?.reason;
        ctx.compacting[sid] = reason === "manual" ? "manual" : "threshold";
        ctx.running[sid] = true;
      }
      break;
    case "compaction_finished":
    case "compaction_failed":
      if (sid && settleCompactionRunning(ctx.running, ctx.compacting, sid, ctx.chats[sid]?.running) === "unknown") {
        ctx.refreshActivity();
      }
      break;
    case "run_started":
      if (sid) {
        ctx.running[sid] = true;
        delete ctx.compacting[sid];
        delete ctx.failed[sid];
        const i = ctx.sessions.findIndex((x) => x.id === sid);
        if (i > 0) {
          const [s] = ctx.sessions.splice(i, 1);
          ctx.sessions.unshift({ ...s!, updatedAt: e.ts });
        }
      }
      break;
    case "run_finished":
      if (sid) {
        ctx.running[sid] = false;
        delete ctx.compacting[sid];
        ctx.awaiting[sid] = 0;
        const bad = e.data.status === "error";
        const quiet = (e.data.origin === "peer" && ctx.quietPeers) || (e.data.status === "ok" && !!ctx.isGoalActive?.(sid));
        if (e.data.status !== "aborted" && !quiet) ctx.cue(bad ? "failed" : "done");
        if (announces(sid, ctx.activeId, e.data.status, quiet)) ctx.announce(sid, bad ? "failed" : "done");
      }
      break;
    case "question_requested":
      if (sid) {
        const first = !ctx.awaiting[sid];
        ctx.awaiting[sid] = (ctx.awaiting[sid] ?? 0) + 1;
        if (first) ctx.cue("ask");
      }
      break;
    case "question_resolved":
      if (sid) ctx.awaiting[sid] = Math.max(0, (ctx.awaiting[sid] ?? 0) - 1);
      break;
    case "provider_updated":
      ctx.refreshProviders();
      break;
    case "skills_updated":
      ctx.bumpSkills();
      break;
    case "mcp_updated":
      ctx.bumpMcp();
      break;
    case "schedules_updated":
      ctx.bumpSchedules();
      break;
    case "goals_updated":
      ctx.bumpGoals();
      break;
    case "locales_updated":
      ctx.syncLocales();
      break;
    case "client_settings_updated":
      ctx.onClientSettings(e.data as { key?: unknown; updatedAt?: unknown; origin?: unknown });
      break;
    case "extension_settings_updated":
      void extensions.onSettingsEvent(e.data as { id?: unknown; action?: unknown; updatedAt?: unknown; origin?: unknown });
      break;
    case "configuration_updated": {
      ctx.bumpConfig();
      const scope = (e.data as { scope?: string } | undefined)?.scope;
      if (scope === "voice") ctx.bumpVoice();
      ctx.refreshProviders();
      if (scope === "tools") ctx.setToolsInfo(e.data as ToolsInfo);
      if (scope === "workdir") {
        ctx.setWorkdirInfo({
          saved: (e.data as WorkdirInfo).saved,
          effective: (e.data as WorkdirInfo).effective,
          fallback: (e.data as WorkdirInfo).fallback,
        });
        ctx.refreshWorkspace();
      }
      break;
    }
  }

  const chat = sid ? ctx.chats[sid] : undefined;
  if (chat) {
    chat.apply(e);
    if (e.type === "run_finished" || e.type === "compaction_finished") {
      ctx.refreshUsage(chat);
      void chat.refreshContext();
      if (e.type === "run_finished") void chat.loadCheckpoints();
    }
    if (e.type === "session_updated") void chat.refreshContext();
    if (e.type === "compaction_finished" || e.type === "compaction_failed") ctx.flushHeld(chat);
  }
}
