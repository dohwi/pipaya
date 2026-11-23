/**
 * Short-lived feedback: toasts (a message, optionally about one session) and done-notices (a strip saying another
 * session finished). Each removes itself after its time; where it is drawn (globally or inside a pane) is decided by
 * the caller, which knows what is on screen.
 */

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "warn" | "error" | "ok";
  /** The session it is about: shown inside that session's pane while it is on screen, else as a normal strip. */
  sid?: string;
  /** How long it stays, for the ring on its close button. */
  ms: number;
  /** A link beside the message (e.g. "fix it in Settings"); running it also closes the toast. */
  action?: { label: string; run: () => void };
}

/** A strip under the nav saying a session other than the focused one finished; a tap jumps to it. */
export interface Notice {
  id: number;
  sid: string;
  /** The server the session lives on; left out = the one in view. */
  server?: string;
  tone: "done" | "failed";
  /** how long it stays, in ms (also the length of the countdown ring) */
  ms: number;
}
export const NOTICE_MS = 6000;

/**
 * Does a finished run get a strip? Any session but the focused one: another pane of the group, another tab, another
 * folder (its pane is not on screen at all, so the strip is the only thing that says so). A stopped run is the user's
 * own doing and a quiet agent-to-agent run says nothing.
 */
export function announces(sid: string, focused: string | null, status: string | undefined, quiet: boolean): boolean {
  return !quiet && sid !== focused && status !== "aborted";
}
/** Strips shown at once; a newer one pushes the oldest out. */
export const NOTICE_MAX = 3;

let seq = 1;

interface ToastTimer {
  timer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  remaining: number;
  paused: boolean;
}

export class Feedback {
  toasts = $state<Toast[]>([]);
  notices = $state<Notice[]>([]);
  private toastTimers = new Map<number, ToastTimer>();
  private noticeTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** `sid`: the session the message is about, so it appears inside that session's pane (see SessionToasts). */
  toast(text: string, tone: Toast["tone"] = "info", sid?: string | null, action?: Toast["action"]) {
    const id = seq++;
    const ms = tone === "error" || tone === "warn" ? 6000 : 4000; // a warning is a whole sentence: as long to read as an error
    this.toasts.push({ id, text, tone, ms, ...(sid ? { sid } : {}), ...(action ? { action } : {}) });
    const entry: ToastTimer = {
      startedAt: Date.now(),
      remaining: ms,
      paused: false,
      timer: setTimeout(() => this.dismissToast(id), ms),
    };
    this.toastTimers.set(id, entry);
  }

  /** Pause a toast's auto-dismiss timer while the user hovers or expands the stack to read it. */
  pauseToast(id: number) {
    const entry = this.toastTimers.get(id);
    if (!entry || entry.paused) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
    entry.paused = true;
  }

  /** Resume a paused toast with whatever time was left when it was paused. */
  resumeToast(id: number) {
    const entry = this.toastTimers.get(id);
    if (!entry || !entry.paused) return;
    entry.paused = false;
    if (entry.remaining <= 0) {
      this.dismissToast(id);
      return;
    }
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => this.dismissToast(id), entry.remaining);
  }

  dismissToast(id: number) {
    clearTimeout(this.toastTimers.get(id)?.timer);
    this.toastTimers.delete(id);
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  announce(sid: string, tone: Notice["tone"], server?: string) {
    // one strip per session: a fresh result replaces the old one and restarts its countdown
    for (const n of this.notices) if (n.sid === sid && n.server === server) this.dismissNotice(n.id);
    const id = seq++;
    this.notices = [{ id, sid, tone, ms: NOTICE_MS, ...(server ? { server } : {}) }, ...this.notices];
    this.noticeTimers.set(id, setTimeout(() => this.dismissNotice(id), NOTICE_MS));
    for (const old of this.notices.slice(NOTICE_MAX)) this.dismissNotice(old.id);
  }

  dismissNotice(id: number) {
    clearTimeout(this.noticeTimers.get(id));
    this.noticeTimers.delete(id);
    this.notices = this.notices.filter((n) => n.id !== id);
  }

  /** Toasts shown as a global strip: not about a session, or about one that is not on screen right now. */
  global(visible: string[]): Toast[] {
    return this.toasts.filter((x) => !x.sid || !visible.includes(x.sid));
  }

  /** Toasts shown inside the pane of session `id`. */
  of(id: string | null, visible: string[]): Toast[] {
    return id && visible.includes(id) ? this.toasts.filter((x) => x.sid === id) : [];
  }
}
