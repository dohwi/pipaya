import { Api } from "./api";
import type { Server } from "./store-model";

/** What the guard needs of the store: the "This PC" server, the open one, and which sessions of the open one are busy. */
export interface CloseGuardEnv {
  local(): Server | undefined;
  openId(): string | null;
  openApi(): Api | null;
  busyIds(): string[];
}

/**
 * Closing the window while work is running: ask first. `confirm` stops the work, then lets the window close.
 * Only the "This PC" server dies with the window; other servers keep running in the background, so their work is left alone.
 */
export class CloseGuard {
  /** The confirmation on screen: `confirm` stops the work and closes, `cancel` keeps the window. null = none asked. */
  confirm = $state<{ count: number; confirm(): void; cancel(): void } | null>(null);

  constructor(private readonly env: CloseGuardEnv) {}

  /** Resolves true when the window may close now (nothing running, or the user confirmed and the work was stopped). */
  async request(): Promise<boolean> {
    if (this.confirm) return false;
    const local = this.env.local();
    if (!local) return true;
    const isOpen = local.id === this.env.openId();
    let api: Api;
    let ids: string[];
    if (isOpen) {
      const open = this.env.openApi();
      if (!open) return true;
      api = open;
      ids = this.env.busyIds();
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
      const done = (ok: boolean) => { this.confirm = null; resolve(ok); };
      this.confirm = {
        count: ids.length,
        cancel: () => done(false),
        confirm: () => {
          const targets = local.id === this.env.openId() ? this.env.busyIds() : ids;
          void Promise.allSettled(targets.map((id) => api.abort(id))).then(() => done(true));
        },
      };
    });
  }
}
