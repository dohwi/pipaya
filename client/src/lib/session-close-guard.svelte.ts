/** Why closing a tab needs a confirmation: a conversation is working/asking, or the tab is pinned. */
export type CloseHold = "working" | "asking" | "pinned" | "pinned-terminal";

/**
 * Closing a tab that needs a confirmation first: a conversation still at work (closing stops that work or drops its
 * pending question), or a pinned conversation/terminal (closing unpins it, and stops a terminal's shell). Unpinned idle
 * tabs close at once. One question at a time: a second close asked while the first is on screen is refused rather than
 * queued behind it.
 */
export class SessionCloseGuard {
  /** The confirmation on screen: `confirm` lets the close go ahead, `cancel` keeps the tab open. null = none asked. */
  ask = $state<{ id: string; serverId: string; title: string; hold: CloseHold; confirm(): void; cancel(): void } | null>(null);

  constructor(
    private readonly holdOf: (id: string, serverId: string) => CloseHold | null,
    private readonly titleOf: (id: string, serverId: string) => string,
  ) {}

  /** Resolves true when `id` on `serverId` may close now (no confirmation needed, or the user confirmed). */
  request(id: string, serverId: string): Promise<boolean> {
    const hold = this.holdOf(id, serverId);
    if (!hold) return Promise.resolve(true);
    if (this.ask) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.ask = null;
        resolve(ok);
      };
      this.ask = { id, serverId, title: this.titleOf(id, serverId), hold, confirm: () => done(true), cancel: () => done(false) };
    });
  }

  /** Cancel a pending confirmation belonging to a server that was removed. */
  cancelServer(serverId: string): void {
    if (this.ask?.serverId === serverId) this.ask.cancel();
  }

  /** Cancel a pending confirmation when its target tab was already closed or deleted elsewhere. */
  cancelTarget(serverId: string, id: string): void {
    if (this.ask?.serverId === serverId && this.ask.id === id) this.ask.cancel();
  }
}
