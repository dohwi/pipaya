/** Why closing a tab needs a confirmation: a conversation is working/asking, has active scheduled tasks, or the tab is pinned. */
export type CloseHold = "working" | "asking" | "scheduled" | "pinned" | "pinned-terminal";

/** Rich hold details so the modal can also warn when a working or pinned conversation has scheduled tasks. */
export interface CloseHoldInfo {
  hold: CloseHold;
  scheduledCount?: number;
  pinned?: boolean;
}

export type CloseHoldInput = CloseHold | CloseHoldInfo | null;

export interface CloseAsk {
  id: string;
  serverId: string;
  title: string;
  hold: CloseHold;
  scheduledCount: number;
  pinned: boolean;
  confirm(): void;
  cancel(): void;
}

export interface CloseHoldState {
  terminal: boolean;
  pinned: boolean;
  awaiting: number;
  running: boolean;
  compacting: boolean;
  scheduledCount: number;
}

/** Decide whether closing a tab requires confirmation and why: asking > working > scheduled > pinned. */
export function decideCloseHold(s: CloseHoldState): CloseHoldInfo | null {
  if (s.terminal) return s.pinned ? { hold: "pinned-terminal", pinned: true } : null;
  const scheduledCount = Math.max(0, s.scheduledCount);
  if (s.awaiting > 0) return { hold: "asking", scheduledCount, pinned: s.pinned };
  if (s.running || s.compacting) return { hold: "working", scheduledCount, pinned: s.pinned };
  if (scheduledCount > 0) return { hold: "scheduled", scheduledCount, pinned: s.pinned };
  return s.pinned ? { hold: "pinned", pinned: true } : null;
}

function normalizeHold(raw: CloseHoldInput): { hold: CloseHold; scheduledCount: number; pinned: boolean } | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    return { hold: raw, scheduledCount: 0, pinned: raw === "pinned" || raw === "pinned-terminal" };
  }
  return {
    hold: raw.hold,
    scheduledCount: Math.max(0, raw.scheduledCount ?? 0),
    pinned: raw.pinned ?? (raw.hold === "pinned" || raw.hold === "pinned-terminal"),
  };
}

/**
 * Closing a tab that needs a confirmation first: a conversation still at work (closing stops that work or drops its
 * pending question), a conversation with active scheduled tasks (due runs are skipped while closed), or a pinned
 * conversation/terminal (closing unpins it, and stops a terminal's shell). Unpinned idle tabs without active schedules
 * close at once. One question at a time: a second close asked while the first is pending or on screen is refused rather
 * than queued behind it.
 */
export class SessionCloseGuard {
  /** The confirmation on screen: `confirm` lets the close go ahead, `cancel` keeps the tab open. null = none asked. */
  ask = $state<CloseAsk | null>(null);
  private pending: { id: string; serverId: string; cancelled: boolean } | null = null;

  constructor(
    private readonly holdOf: (id: string, serverId: string) => CloseHoldInput | Promise<CloseHoldInput>,
    private readonly titleOf: (id: string, serverId: string) => string,
  ) {}

  /** Resolves true when `id` on `serverId` may close now (no confirmation needed, or the user confirmed). */
  request(id: string, serverId: string): Promise<boolean> {
    if (this.ask || this.pending) return Promise.resolve(false);
    let raw: CloseHoldInput | Promise<CloseHoldInput>;
    try {
      raw = this.holdOf(id, serverId);
    } catch {
      return Promise.resolve(false);
    }
    if (raw && typeof (raw as PromiseLike<CloseHoldInput>).then === "function") {
      const token = { id, serverId, cancelled: false };
      this.pending = token;
      return Promise.resolve(raw).then(
        (resolved) => {
          if (this.pending === token) this.pending = null;
          if (token.cancelled || this.ask) return false;
          return this.prompt(id, serverId, normalizeHold(resolved));
        },
        () => {
          if (this.pending === token) this.pending = null;
          return false;
        },
      );
    }
    return this.prompt(id, serverId, normalizeHold(raw as CloseHoldInput));
  }

  private prompt(
    id: string,
    serverId: string,
    info: { hold: CloseHold; scheduledCount: number; pinned: boolean } | null,
  ): Promise<boolean> {
    if (!info) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.ask = null;
        resolve(ok);
      };
      this.ask = {
        id,
        serverId,
        title: this.titleOf(id, serverId),
        hold: info.hold,
        scheduledCount: info.scheduledCount,
        pinned: info.pinned,
        confirm: () => done(true),
        cancel: () => done(false),
      };
    });
  }

  /** Cancel a pending confirmation belonging to a server that was removed. */
  cancelServer(serverId: string): void {
    if (this.pending?.serverId === serverId) this.pending.cancelled = true;
    if (this.ask?.serverId === serverId) this.ask.cancel();
  }

  /** Cancel a pending confirmation when its target tab was already closed or deleted elsewhere. */
  cancelTarget(serverId: string, id: string): void {
    if (this.pending?.serverId === serverId && this.pending.id === id) this.pending.cancelled = true;
    if (this.ask?.serverId === serverId && this.ask.id === id) this.ask.cancel();
  }
}
