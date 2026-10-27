import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { questionText, lang as toLang, runText, testText, type Lang, type Text } from "./notification-text.ts";
import type { EventBus, PipayaEvent } from "./events.ts";

export type DevicePlatform = "desktop" | "android" | "ios" | "web";
export type PushProvider = "fcm" | "apns";
export interface PushRegistration { provider: PushProvider; token: string }
export interface DevicePresence { platform: DevicePlatform; focused: boolean; enabled: boolean; visibleSessionIds: string[]; /** The focused pane, when it differs from the other visible ones (split view): only it counts as read */ activeSessionId?: string; lang?: string; /** What the device calls itself ("MacBook Air"), shown in the device list */ name?: string; /** "macOS 15.1 · arm64" */ os?: string; /** "Desktop app 0.1.42", "Chrome 126" */ app?: string }
/** One connected device as the device list shows it. `live`: heard from within the lease. `push`: can receive a push while the app is closed. */
export interface DeviceInfo { id: string; platform: DevicePlatform; name: string | null; os: string | null; app: string | null; enabled: boolean; live: boolean; push: boolean; lastSeen: number | null }
export interface NotificationInput { title: string; body?: string; kind?: string; sessionId?: string; key?: string; /** Built-in notices: the facts the text is written from, once per language. Extension notices have none. */ facts?: BuiltinFacts }
/** What a built-in notice is about. The words are chosen per receiving device, so one event can read in two languages. */
export type BuiltinFacts =
  | { type: "run"; title: string; status: "ok" | "error"; answer?: string; error?: string | null; durationMs?: number }
  | { type: "question"; title: string; question: string };
/** Wording for one device. Anything that is not a built-in notice keeps the title and body it was sent with. */
export function wording(p: { title: string; body?: string; facts?: BuiltinFacts }, l: Lang): Text {
  if (p.facts?.type === "run") return runText(p.facts, l);
  if (p.facts?.type === "question") return questionText(p.facts, l);
  return { title: p.title, ...(p.body ? { body: p.body } : {}) };
}
export interface NotificationPayload extends NotificationInput { id: string; at: number; source: string }
/** The kinds of notice the server can raise (also what `ctx.notify` accepts). */
export const NOTIFICATION_KINDS = ["task_completed", "task_failed", "user_request", "info"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Which bus events raise a notice, and of what kind. This table is the one place that says so: the rule API accepts exactly its
 * keys, and `onEvent` looks events up in it. To notify about another event, add a row (and, for a built-in notice, its wording).
 */
export const NOTIFYING_EVENTS = {
  /** A run ended: an error is a failure, an abort is silent, anything else is a completion. */
  run_finished: { kind: (data: { status?: string }): NotificationKind | null => (data.status === "aborted" ? null : data.status === "error" ? "task_failed" : "task_completed") },
  /** The agent asked the user something. */
  question_requested: { kind: (): NotificationKind | null => "user_request" },
} as const;
export type NotifyingEvent = keyof typeof NOTIFYING_EVENTS;
export const NOTIFYING_EVENT_TYPES = Object.keys(NOTIFYING_EVENTS) as NotifyingEvent[];
const isNotifying = (type: string): type is NotifyingEvent => Object.hasOwn(NOTIFYING_EVENTS, type);

export interface NotificationRule { event: NotifyingEvent; title: string; body?: string }
export interface PushTransport {
  send(token: string, payload: NotificationPayload, platform: DevicePlatform): Promise<"sent" | "invalid">;
  /** Silently asks a phone to take this session's notification out of its notification shade. Android only. */
  clear?(token: string, sessionId: string, platform: DevicePlatform): Promise<"sent" | "invalid">;
}
export type PushTransports = Partial<Record<PushProvider, PushTransport>>;
/** What the notifier needs to know about a chat, without depending on the whole session store. */
export interface SessionFacts { title(sessionId: string): string; lastAnswer(sessionId: string): string | undefined }
export const DEFAULT_TITLES: Record<string, string> = { user_request: "Answer needed", task_failed: "Task failed", task_completed: "Task completed" };
const LEASE_MS = 45_000;
/** How long to wait for a PC/browser to confirm it showed a notification before pushing to the phone. A receipt normally takes well under a second. */
const MOBILE_DELAY_MS = 5_000;
/** Grace before a push to a phone nobody can show a local notification on, so a run that restarts at once can still cancel it. */
const DIRECT_PUSH_GRACE_MS = 1_000;
/**
 * A phone that reported "focused" counts as being looked at for this long only. When the user switches to another app Android freezes
 * the WebView, so the "no longer focused" report may never leave the phone; without this limit that stale report would silence every
 * notification for the rest of the (longer) presence lease.
 */
const MOBILE_FOCUS_MS = 25_000;
/** An escalation that came due this long ago (the server was down) is stale news, not worth a push. */
const STALE_ESCALATION_MS = 10 * 60_000;
/** A phone notification older than this is left to the user: the push is no longer worth tracking. */
const CLEAR_WINDOW_MS = 24 * 60 * 60_000;

/** A push waiting to go out. `first`: is a live device going to show it? `escalate`: it was shown on a PC; send to the phone if nobody looks. */
interface Pending { payload: NotificationPayload; target: DevicePlatform | null; phase: "first" | "escalate"; looksAtStart: number }

/** The server token is the account boundary: every connected device belongs to that user. */
export class NotificationService {
  private presence = new Map<string, DevicePresence & { at: number }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queued = new Map<string, Pending>();
  /** Counts the moments a window was looked at. A notification remembers the count when it came up; a higher count later means somebody looked. */
  private looks = 0;
  private pending = new Set<Promise<unknown>>();
  private receipts = new Set<string>();
  /** Sessions a phone was pushed about, so reading one elsewhere can take it out of the phone's shade again. */
  private pushed = new Map<string, number>();
  private rates = new Map<string, number[]>();
  private unsubscribe: () => void;
  /** Called with the sessions a focused device is showing (they count as read). */
  onLook?: (sessionIds: string[]) => void;
  /** Is a focused device showing this session right now? */
  watching(sessionId: string) {
    return this.live().some(([, p]) => p.focused && (p.activeSessionId ? p.activeSessionId === sessionId : p.visibleSessionIds.includes(sessionId)) && (p.platform === "desktop" || p.platform === "web" || this.now() - p.at < MOBILE_FOCUS_MS));
  }
  /**
   * `escalateMs()`: how long a notification shown on a PC may go unread before it is also pushed to the phone (Discord style).
   * 0 turns that off: a PC that showed it is then enough. Read on every notification so a changed setting applies at once.
   */
  constructor(private db: Database, private bus: EventBus, private push: PushTransports = {}, private now = Date.now, private mobileDelayMs = MOBILE_DELAY_MS, private escalateMs: () => number = () => 0, private sessions?: SessionFacts) {
    this.unsubscribe = bus.subscribe(e => this.onEvent(e));
    this.restore();
  }
  /** Escalations that were waiting when the server last stopped */
  private restore() {
    if (!this.pushConfigured) return;
    const rows = this.db.query("SELECT id, due_at, payload FROM notification_escalations").all() as { id: string; due_at: number; payload: string }[];
    for (const row of rows) {
      if (row.due_at < this.now() - STALE_ESCALATION_MS) { this.db.query("DELETE FROM notification_escalations WHERE id = ?").run(row.id); continue; }
      try { this.queued.set(row.id, { payload: JSON.parse(row.payload) as NotificationPayload, target: null, phase: "escalate", looksAtStart: this.looks }); } catch { this.db.query("DELETE FROM notification_escalations WHERE id = ?").run(row.id); continue; }
      this.schedule(row.id, Math.max(0, row.due_at - this.now()));
    }
  }
  /** A report that leaves out what the device is called, runs or is (older clients, a browser) must not erase what an earlier one said. */
  private known(id: string, now: DevicePresence): Pick<DevicePresence, "name" | "os" | "app"> {
    const before = this.presence.get(id);
    return { name: now.name ?? before?.name, os: now.os ?? before?.os, app: now.app ?? before?.app };
  }
  get providers() { return Object.keys(this.push) as PushProvider[]; }
  get pushConfigured() { return this.providers.length > 0; }
  heartbeat(id: string, presence: DevicePresence, registration?: PushRegistration | null) {
    if (presence.focused) { this.looks++; this.clearPushed(presence.visibleSessionIds, id); this.onLook?.(presence.activeSessionId ? [presence.activeSessionId] : presence.visibleSessionIds); }
    for (const [key, p] of this.presence) if (this.now() - p.at >= LEASE_MS) this.presence.delete(key);
    if (this.presence.size >= 100 && !this.presence.has(id)) throw new Error("live device limit reached");
    if (presence.platform === "desktop" || presence.platform === "web") {
      this.presence.set(id, { ...presence, ...this.known(id, presence), at: this.now() });
      return; // Browser refreshes must not exhaust the durable mobile registration limit.
    }
    const count = (this.db.query("SELECT COUNT(*) AS n FROM notification_devices").get() as { n: number }).n;
    if (count >= 100 && !this.db.query("SELECT id FROM notification_devices WHERE id = ?").get(id)) throw new Error("device limit reached");
    // A rotated/reinstalled native device must not leave two registrations for the same token.
    if (registration) this.db.query("UPDATE notification_devices SET token = NULL WHERE token = ? AND provider = ? AND id != ?").run(registration.token, registration.provider, id);
    this.presence.set(id, { ...presence, ...this.known(id, presence), at: this.now() });
    this.db.query("INSERT INTO notification_devices (id, platform, enabled, token, provider, lang, name, os, app, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, enabled = excluded.enabled, lang = COALESCE(excluded.lang, lang), name = COALESCE(excluded.name, name), os = COALESCE(excluded.os, os), app = COALESCE(excluded.app, app), last_seen = excluded.last_seen, token = CASE WHEN ? THEN excluded.token ELSE token END, provider = CASE WHEN ? THEN excluded.provider ELSE provider END")
      .run(id, presence.platform, presence.enabled ? 1 : 0, registration?.token ?? null, registration?.provider ?? "fcm", presence.lang ?? null, presence.name ?? null, presence.os ?? null, presence.app ?? null, this.now(), registration !== undefined ? 1 : 0, registration !== undefined ? 1 : 0);
  }
  /**
   * Every device this server's token has been used from: the registered phones (kept across restarts) and the PC / browser windows
   * that are connected right now (kept in memory only, so they drop out once they stop reporting).
   */
  devices(): DeviceInfo[] {
    const live = new Map(this.live());
    const out = new Map<string, DeviceInfo>();
    const rows = this.db.query("SELECT id, platform, enabled, token IS NOT NULL AS has_token, name, os, app, last_seen FROM notification_devices").all() as { id: string; platform: DevicePlatform; enabled: number; has_token: number; name: string | null; os: string | null; app: string | null; last_seen: number | null }[];
    for (const r of rows) {
      const p = live.get(r.id);
      out.set(r.id, { id: r.id, platform: r.platform, name: p?.name ?? r.name, os: p?.os ?? r.os, app: p?.app ?? r.app, enabled: !!r.enabled, live: !!p, push: !!r.has_token, lastSeen: p?.at ?? r.last_seen });
    }
    for (const [id, p] of live) if (!out.has(id)) out.set(id, { id, platform: p.platform, name: p.name ?? null, os: p.os ?? null, app: p.app ?? null, enabled: p.enabled, live: true, push: false, lastSeen: p.at });
    return [...out.values()].sort((a, b) => Number(b.live) - Number(a.live) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  }
  /** Removes a device. Returns false when this server never knew it. Tells the device itself so it can stop reporting. */
  forget(id: string): boolean {
    const known = this.presence.has(id) || !!this.db.query("SELECT id FROM notification_devices WHERE id = ?").get(id);
    this.presence.delete(id); this.db.query("DELETE FROM notification_devices WHERE id = ?").run(id);
    if (known) this.bus.publish(null, "device_revoked", { deviceId: id }, { ephemeral: true });
    return known;
  }
  setRule(owner: string, id: string, rule: NotificationRule) {
    const count = (this.db.query("SELECT COUNT(*) AS n FROM notification_rules WHERE owner = ?").get(owner) as { n: number }).n;
    if (count >= 5 && !this.db.query("SELECT id FROM notification_rules WHERE owner = ? AND id = ?").get(owner, id)) throw new Error("rule limit reached");
    this.db.query("INSERT INTO notification_rules (owner, id, data) VALUES (?, ?, ?) ON CONFLICT(owner, id) DO UPDATE SET data = excluded.data").run(owner, id, JSON.stringify(rule));
  }
  removeRules(owner: string) {
    this.db.query("DELETE FROM notification_rules WHERE owner = ?").run(owner);
    this.cancelQueued(payload => payload.source === owner);
  }
  private cancelQueued(match: (payload: NotificationPayload) => boolean) {
    for (const [id, pending] of this.queued) if (match(pending.payload)) this.drop(id);
  }
  /** Forget a waiting push for good (sent, cancelled or no longer needed) */
  private drop(id: string) {
    clearTimeout(this.timers.get(id)); this.timers.delete(id); this.queued.delete(id); this.receipts.delete(id);
    this.db.query("DELETE FROM notification_escalations WHERE id = ?").run(id);
  }
  private schedule(id: string, ms: number) {
    const timer = setTimeout(() => this.fire(id), ms);
    timer.unref?.(); this.timers.set(id, timer);
  }
  private fire(id: string) {
    this.timers.delete(id);
    const pending = this.queued.get(id);
    if (!pending) return;
    if (pending.phase === "first" && this.receipts.has(id)) {
      // A live device showed it. A phone showing it is the end of the story; a PC showing it may still go unseen.
      const wait = this.escalateMs();
      if ((pending.target === "desktop" || pending.target === "web") && wait > 0) {
        pending.phase = "escalate";
        const due = pending.payload.at + wait;
        this.db.query("INSERT OR REPLACE INTO notification_escalations (id, due_at, payload) VALUES (?, ?, ?)").run(id, due, JSON.stringify(pending.payload));
        this.schedule(id, Math.max(0, due - this.now()));
      } else this.drop(id);
      return;
    }
    this.drop(id);
    this.track(this.deliverPush(pending));
  }
  removeRule(owner: string, id: string) { this.db.query("DELETE FROM notification_rules WHERE owner = ? AND id = ?").run(owner, id); }
  private live() { return [...this.presence.entries()].filter(([, p]) => this.now() - p.at < LEASE_MS); }
  private attended() {
    return this.live().some(([, p]) => p.focused && (p.platform === "desktop" || p.platform === "web" || this.now() - p.at < MOBILE_FOCUS_MS));
  }
  /** A phone with a usable push token is reached through the OS push, which works while the app is in the background; its WebView may be frozen. */
  private pushable(id: string, p: DevicePresence) {
    if (!this.pushConfigured || (p.platform !== "android" && p.platform !== "ios")) return false;
    const row = this.db.query("SELECT provider FROM notification_devices WHERE id = ? AND token IS NOT NULL").get(id) as { provider: PushProvider } | null;
    return !!row && !!this.push[row.provider];
  }
  send(source: string, input: NotificationInput) {
    const key = input.key ? `${source}:${input.key}` : randomUUID();
    const previous = this.db.query("SELECT id FROM notification_dedupe WHERE key = ? AND at > ?").get(key, this.now() - 86_400_000) as { id: string } | null;
    if (previous) return { id: previous.id, delivered: 0, suppressed: true };
    // The limit exists to stop an extension from flooding the user. The server's own notices come from real events
    // (a run ended, the agent asks something), so dropping the sixth one in ten seconds would lose something that mattered.
    if (source !== "pipaya") {
      const times = (this.rates.get(source) ?? []).filter(at => this.now() - at < 10_000);
      if (times.length >= 5) throw new Error("notifications limited to five per ten seconds");
      this.rates.set(source, [...times, this.now()]);
    }
    const payload: NotificationPayload = { ...input, id: randomUUID(), at: this.now(), source };
    this.db.query("DELETE FROM notification_dedupe WHERE at < ?").run(this.now() - 86_400_000);
    this.db.query("INSERT OR REPLACE INTO notification_dedupe (key, id, at) VALUES (?, ?, ?)").run(key, payload.id, payload.at);
    if (this.attended()) return { id: payload.id, delivered: 0, suppressed: true };
    // Only one live window gets a local OS notification, never every tab/device.
    // Phones that can be pushed are left out: a backgrounded app cannot be trusted to show a local notification, the OS push can.
    const target = this.live().filter(([id, p]) => p.enabled && !this.pushable(id, p)).sort((a, b) => (a[1].platform === "desktop" ? 0 : 1) - (b[1].platform === "desktop" ? 0 : 1) || b[1].at - a[1].at)[0];
    if (target) this.bus.publish(input.sessionId ?? null, "notification", { deviceId: target[0], notification: this.forDevice(payload, target[1].lang) }, { ephemeral: true });
    // Stale sockets without a receipt fall back to a delayed push; a PC that did show it gets until escalateMs() to be looked at.
    if (this.pushConfigured) {
      this.queued.set(payload.id, { payload, target: target?.[1].platform ?? null, phase: "first", looksAtStart: this.looks });
      // Nothing local to wait for: push straight away. Otherwise give the PC/browser a moment to confirm it showed the notice.
      this.schedule(payload.id, target ? this.mobileDelayMs : Math.min(this.mobileDelayMs, DIRECT_PUSH_GRACE_MS));
    }
    return { id: payload.id, delivered: target ? 1 : 0, suppressed: false };
  }
  /**
   * Checks the path to one device, ignoring "is anyone looking": the person is on the settings screen when they ask.
   * Says which step stops it, so a missing notification can be traced instead of guessed at.
   */
  test(deviceId: string) {
    const live = this.live().find(([id]) => id === deviceId)?.[1];
    const stored = this.db.query("SELECT token IS NOT NULL AS has_token, enabled FROM notification_devices WHERE id = ?").get(deviceId) as { has_token: number; enabled: number } | null;
    const base = { pushConfigured: this.pushConfigured, providers: this.providers, hasToken: !!stored?.has_token };
    if (!live) return { ...base, status: "unknown_device" as const };
    if (!live.enabled) return { ...base, status: "disabled" as const };
    // "test-" ids are only ever made here: the client shows these even while the window is in front.
    const lang = toLang((this.db.query("SELECT lang FROM notification_devices WHERE id = ?").get(deviceId) as { lang: string | null } | null)?.lang ?? live.lang);
    const payload: NotificationPayload = { id: `test-${randomUUID()}`, at: this.now(), source: "pipaya", ...testText(lang), kind: "info" };
    this.bus.publish(null, "notification", { deviceId, notification: payload }, { ephemeral: true });
    return { ...base, status: "sent" as const, id: payload.id };
  }
  acknowledge(notificationId: string) { if (this.timers.has(notificationId)) this.receipts.add(notificationId); }
  private track(job: Promise<unknown>) { this.pending.add(job); void job.catch(() => {}).finally(() => this.pending.delete(job)); }
  private async deliverPush({ payload, looksAtStart }: Pending) {
    // Someone has looked at a window since this notification came up: it has been seen, wherever it was shown.
    if (!this.pushConfigured || this.attended() || this.looks > looksAtStart) return;
    const devices = this.db.query("SELECT id, token, platform, provider, lang FROM notification_devices WHERE platform IN ('android', 'ios') AND enabled = 1 AND token IS NOT NULL").all() as { id: string; token: string; platform: DevicePlatform; provider: PushProvider; lang: string | null }[];
    for (const device of devices) {
      if (this.attended()) continue;
      try {
        const transport = this.push[device.provider];
        if (!transport) continue;
        const text = wording(payload, toLang(device.lang));
        const result = await transport.send(device.token, { ...payload, ...text, facts: undefined }, device.platform);
        if (result === "invalid") this.db.query("UPDATE notification_devices SET token = NULL WHERE id = ? AND token = ?").run(device.id, device.token);
        else if (payload.sessionId) this.pushed.set(payload.sessionId, this.now());
      } catch { /* Never leak tokens into logs or interrupt agent runs. Retry on the next notification. */ }
    }
  }
  /**
   * The sessions were looked at on `reader`: the phones that were pushed about them drop those notifications.
   * The reader itself is left out, since it clears its own shade. Each push is withdrawn once.
   */
  private clearPushed(sessionIds: string[], reader: string | null) {
    for (const [sid, at] of this.pushed) if (this.now() - at > CLEAR_WINDOW_MS) this.pushed.delete(sid);
    const ids = sessionIds.filter(sid => this.pushed.delete(sid));
    if (!ids.length || !this.pushConfigured) return;
    const devices = this.db.query("SELECT id, token, platform, provider FROM notification_devices WHERE platform = 'android' AND token IS NOT NULL").all() as { id: string; token: string; platform: DevicePlatform; provider: PushProvider }[];
    for (const device of devices) {
      if (device.id === reader) continue;
      const clear = this.push[device.provider]?.clear;
      if (!clear) continue;
      for (const sid of ids) this.track((async () => {
        try { if (await clear.call(this.push[device.provider], device.token, sid, device.platform) === "invalid") this.db.query("UPDATE notification_devices SET token = NULL WHERE id = ? AND token = ?").run(device.id, device.token); } catch { /* best effort: a notification left in the shade is harmless */ }
      })());
    }
  }
  private onEvent(e: PipayaEvent) {
    if (e.type === "question_resolved") { this.cancelQueued(p => p.sessionId === e.sessionId && p.kind === "user_request"); if (e.sessionId) this.clearPushed([e.sessionId], null); }
    if (e.type === "run_started") { this.cancelQueued(p => p.sessionId === e.sessionId && ["task_completed", "task_failed"].includes(p.kind ?? "")); if (e.sessionId) this.clearPushed([e.sessionId], null); }
    if (!e.sessionId || !isNotifying(e.type)) return;
    const kind = NOTIFYING_EVENTS[e.type].kind((e.data ?? {}) as { status?: string });
    if (!kind) return;
    const rules = (this.db.query("SELECT owner, id, data FROM notification_rules").all() as { owner: string; id: string; data: string }[])
      .map(row => ({ ...row, rule: JSON.parse(row.data) as NotificationRule })).filter(row => row.rule.event === e.type);
    try {
      if (!rules.length) {
        const facts = this.factsFor(e, kind);
        this.send("pipaya", { ...wording({ title: "", facts }, "en"), kind, sessionId: e.sessionId, key: `event-${e.id}`, facts });
      }
    } catch { /* rate limit must not break event processing */ }
    for (const row of rules) {
      try { this.send(row.owner, { title: `[${row.owner}] ${row.rule.title}`, body: row.rule.body, kind, sessionId: e.sessionId, key: `${row.id}-${e.id}` }); } catch { /* same */ }
    }
  }
  /** The notice as the receiving device should read it: built-in notices are rewritten in its language, facts are not sent on. */
  private forDevice(p: NotificationPayload, lang: string | undefined): NotificationPayload {
    if (!p.facts) return p;
    const { facts: _facts, ...rest } = p;
    return { ...rest, ...wording(p, toLang(lang)) };
  }
  /** What a built-in notice is about, read from the session and its last answer. */
  private factsFor(e: PipayaEvent, kind: NotificationKind): BuiltinFacts {
    const title = this.sessions?.title(e.sessionId!) ?? "";
    if (kind === "user_request") {
      const d = e.data as { question?: unknown };
      return { type: "question", title, question: typeof d.question === "string" ? d.question : "" };
    }
    const d = e.data as { error?: string | null; durationMs?: number };
    return { type: "run", title, status: kind === "task_failed" ? "error" : "ok", answer: kind === "task_completed" ? this.sessions?.lastAnswer(e.sessionId!) : undefined, error: d.error, durationMs: d.durationMs };
  }
  /** Shutting down keeps durable escalations in the database: they resume at the next start */
  async close() { this.unsubscribe(); for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); this.queued.clear(); this.receipts.clear(); await Promise.allSettled(this.pending); }
}
