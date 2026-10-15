/**
 * Short-lived feedback: toasts (a message, optionally about one session) and done-notices (a strip saying another
 * session finished). Each removes itself after its time; where it is drawn (globally or inside a pane) is decided by
 * the caller, which knows what is on screen.
 */

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "ok";
  /** The session it is about: shown inside that session's pane while it is on screen, else as a normal strip. */
  sid?: string;
  /** How long it stays, for the ring on its close button. */
  ms: number;
}

/** A strip under the nav saying another session (or another pane of the open group) finished; a tap jumps to it. */
export interface Notice {
  id: number;
  sid: string;
  tone: "done" | "failed";
  /** how long it stays, in ms (also the length of the countdown ring) */
  ms: number;
}
export const NOTICE_MS = 6000;
/** Strips shown at once; a newer one pushes the oldest out. */
export const NOTICE_MAX = 3;

let seq = 1;

export class Feedback {
  toasts = $state<Toast[]>([]);
  notices = $state<Notice[]>([]);
  private toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private noticeTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** `sid`: the session the message is about, so it appears inside that session's pane (see SessionToasts). */
  toast(text: string, tone: Toast["tone"] = "info", sid?: string | null) {
    const id = seq++;
    const ms = tone === "error" ? 6000 : 4000;
    this.toasts.push({ id, text, tone, ms, ...(sid ? { sid } : {}) });
    this.toastTimers.set(id, setTimeout(() => this.dismissToast(id), ms));
  }

  dismissToast(id: number) {
    clearTimeout(this.toastTimers.get(id));
    this.toastTimers.delete(id);
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  announce(sid: string, tone: Notice["tone"]) {
    // one strip per session: a fresh result replaces the old one and restarts its countdown
    for (const n of this.notices) if (n.sid === sid) this.dismissNotice(n.id);
    const id = seq++;
    this.notices = [{ id, sid, tone, ms: NOTICE_MS }, ...this.notices];
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
