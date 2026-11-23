/** Why closing a conversation needs a confirmation: it is working (a run or a compaction), or a question waits for the user. */
export type CloseHold = "working" | "asking";

/**
 * Closing a conversation that is still at work: ask first, since closing stops that work (or drops the question it is
 * waiting on). An idle conversation closes at once. One question at a time: a second close asked while the first is on
 * screen is refused rather than queued behind it.
 */
export class SessionCloseGuard {
  /** The confirmation on screen: `confirm` lets the close go ahead, `cancel` keeps the conversation open. null = none asked. */
  ask = $state<{ id: string; serverId: string; title: string; hold: CloseHold; confirm(): void; cancel(): void } | null>(null);

  constructor(
    private readonly holdOf: (id: string, serverId: string) => CloseHold | null,
    private readonly titleOf: (id: string, serverId: string) => string,
  ) {}

  /** Resolves true when `id` on `serverId` may close now (nothing at work, or the user confirmed). */
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
}
