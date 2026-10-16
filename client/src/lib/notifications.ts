import { usefulHostname } from "./device-name";
import { Api } from "./api";
import { uid } from "./format";
import { isTauri } from "./tauri";
import { notificationRules } from "./notification-rules";
import type { NotificationSpec, NotificationStatus, NotificationTestResult } from "./notification-contract";
import { getLang, LocalizedError, t } from "./i18n";
export type Platform = "desktop" | "android" | "ios" | "web";
export interface PushRegistration { provider: "fcm" | "apns"; token: string }
/** Native mobile adapters supply registration/rotation and cold-start tap metadata. No credentials enter the SDK. */
export interface NativePushAdapter {
  register(): Promise<PushRegistration | null>;
  onTokenChanged(handler: (registration: PushRegistration) => void): Promise<() => void>;
  /** Takes these sessions' notifications out of the phone's notification shade. */
  clear?(sessionIds: string[]): Promise<void>;
  onTap(handler: (data: { sessionId?: string; notificationId?: string }) => void): Promise<() => void>;
}
const isWindows = (): boolean => /Windows/i.test(navigator.userAgent);
export function notificationPlatform(): Platform {
  if (/Android/i.test(navigator.userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  return isTauri() ? "desktop" : "web";
}
/** What the user agent says about the operating system, for places that have nothing better (a browser, or before the native answer arrives). */
export function osFromAgent(ua: string = navigator.userAgent): string {
  return /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Linux|X11/i.test(ua) ? "Linux" : "";
}
export function browserFromAgent(ua: string = navigator.userAgent): string {
  const v = (re: RegExp) => ua.match(re)?.[1];
  const pick = (name: string, re: RegExp) => { const n = v(re); return n ? `${name} ${n}` : name; };
  return /Edg\//.test(ua) ? pick("Edge", /Edg\/(\d+)/) : /Firefox\//.test(ua) ? pick("Firefox", /Firefox\/(\d+)/) : /Chrome\//.test(ua) ? pick("Chrome", /Chrome\/(\d+)/) : /Safari\//.test(ua) ? pick("Safari", /Version\/(\d+)/) : "";
}
async function androidDeviceName(): Promise<string> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const r = await invoke<{ name?: string } | null>("plugin:pipaya-push|device_name");
    return typeof r?.name === "string" ? r.name.trim().slice(0, 60) : "";
  } catch { return ""; }
}
/** What a device tells a server about itself so the device list can tell two of them apart. */
export interface DeviceIdentity { name: string; os: string; app: string }
/**
 * The device's own name ("my-MacBook-Air" — the hostname), what it runs ("macOS 15.1 · arm64") and which client it is ("App 0.1.42" or
 * "Chrome 126"). A browser cannot read a hostname, so it is called after its OS and browser. Computed once; the answer never changes.
 */
export function deviceIdentity(ua: string = navigator.userAgent, tauri: boolean = isTauri()): Promise<DeviceIdentity> {
  const fallbackOs = osFromAgent(ua);
  const browser = browserFromAgent(ua);
  const generic: DeviceIdentity = tauri
    ? { name: fallbackOs ? `${fallbackOs} app` : "App", os: fallbackOs, app: "App" }
    : { name: [fallbackOs, browser].filter(Boolean).join(" · ") || "Web", os: fallbackOs, app: browser || "Web" };
  if (!tauri) return Promise.resolve(generic);
  return (async () => {
    try {
      const [os, app] = await Promise.all([import("@tauri-apps/plugin-os"), import("@tauri-apps/api/app")]);
      const label = { macos: "macOS", windows: "Windows", linux: "Linux", ios: "iOS", android: "Android" }[os.type()] ?? fallbackOs;
      // A phone's hostname is just "localhost" (and never the name its owner gave it), so Android is asked for that name.
      const phone = notificationPlatform() === "android" ? await androidDeviceName() : "";
      const host = phone || usefulHostname((await os.hostname().catch(() => null))?.trim());
      const version = await app.getVersion().catch(() => "");
      return {
        name: host || generic.name,
        os: [[label, os.version()].filter(Boolean).join(" "), os.arch()].filter(Boolean).join(" · ").slice(0, 60),
        app: ["App", version].filter(Boolean).join(" "),
      };
    } catch { return generic; }
  })();
}
/** Minutes a notification shown on a PC may stay unread before the phone is pushed too. Server scope: the server acts on it. */
export const ESCALATE_CHOICES = [0, 1, 2, 3, 5, 10, 15, 30, 60] as const;
export const DEFAULT_ESCALATE = 3;
export interface NotificationPolicy { escalateMinutes: number }
/** Where a test notification stopped, from the server to the operating system. */
export type TestStep = "no_server" | "not_enabled" | "no_permission" | "server_unknown" | "server_refused" | "not_received" | "os_error" | "shown";
export interface TestOutcome { step: TestStep; detail?: string; server?: NotificationTestResult }
export const attended = () => document.visibilityState === "visible" && document.hasFocus();
const ENABLED = "pipaya.notifications";
const DEVICE = "pipaya.notification.device";
const newDeviceId = () => typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : uid();
function deviceId() {
  let id = sessionStorage.getItem(DEVICE);
  if (!id) { id = newDeviceId(); sessionStorage.setItem(DEVICE, id); }
  return id;
}
/** Presence is per window; durable push identity is supplied by a native adapter. */
export class NotificationClient {
  // On by default; only an explicit opt-out ("0") turns it off. OS permission is still requested/checked separately.
  enabled = localStorage.getItem(ENABLED) !== "0";
  readonly id = isTauri() && ["android", "ios"].includes(notificationPlatform()) ? (() => {
    let id = localStorage.getItem(DEVICE);
    if (!id) { id = newDeviceId(); localStorage.setItem(DEVICE, id); }
    return id;
  })() : deviceId();
  private identityOnce?: Promise<DeviceIdentity>;
  /** Sent with every report (the server keeps the latest), but only worked out once. */
  private identity() { return this.identityOnce ??= deviceIdentity(); }
  private api: Api | null = null;
  /** The connection the user removed this device from. Reporting to it again would put the device straight back in the list. */
  private revokedOn: Api | null = null;
  private visible: () => string[] = () => [];
  private timer?: ReturnType<typeof setInterval>;
  private registration?: PushRegistration | null;
  private seen = new Set<string>();

  private cleanup: (() => void)[] = [];
  private navigate: (sessionId: string) => void = () => {};
  private pendingSession: string | null = null;
  private lastShown: { sid: string; at: number } | null = null;
  private openSession(sid: string) { if (this.api) this.navigate(sid); else this.pendingSession = sid; }
  private native?: NativePushAdapter;
  private providers: ("fcm" | "apns")[] = [];
  init(visible: () => string[], navigate: (sessionId: string) => void, native?: NativePushAdapter) {
    this.visible = visible; this.navigate = navigate; this.native = native;
    const update = () => { void this.heartbeat(); };
    // Desktop Tauri gives no click event for system notifications. Clicking one brings the window to the front,
    // so a focus shortly after a notification was shown is treated as the click.
    const onFocus = () => {
      const shown = this.lastShown; this.lastShown = null;
      if (shown && Date.now() - shown.at < 120_000) this.openSession(shown.sid);
    };
    window.addEventListener("focus", onFocus);
    this.cleanup.push(() => window.removeEventListener("focus", onFocus));
    window.addEventListener("focus", update); window.addEventListener("blur", update); window.addEventListener("pagehide", update); document.addEventListener("visibilitychange", update);
    this.cleanup.push(() => { window.removeEventListener("focus", update); window.removeEventListener("blur", update); window.removeEventListener("pagehide", update); document.removeEventListener("visibilitychange", update); });
    // Shorter than the server's phone focus window (25 s), so a phone that stays in front keeps counting as looked at.
    this.timer = setInterval(update, 10_000);
    if (isTauri() && isWindows()) void import("@tauri-apps/api/event").then(async ev => {
      const off = await ev.listen<string>("pipaya://open-session", e => { if (e.payload) this.openSession(e.payload); });
      this.cleanup.push(off);
    }).catch(() => {});
    if (isTauri()) void import("@tauri-apps/plugin-notification").then(async plugin => {
      const listener = await plugin.onAction(event => {
        const sid = event.notification?.extra?.sessionId;
        if (typeof sid === "string" && sid) this.openSession(sid);
      });
      this.cleanup.push(() => { void listener.unregister(); });
    }).catch(() => {});
    if (native) void (async () => {
      this.cleanup.push(await native.onTokenChanged(reg => { if (this.enabled) { this.registration = reg; void this.heartbeat(); } }));
      this.cleanup.push(await native.onTap(data => { if (data.sessionId) this.openSession(data.sessionId); }));
      if (this.enabled) { this.registration = await native.register(); await this.heartbeat(); }
    })().catch(() => {});
  }
  connect(api: Api | null) {
    const old = this.api;
    if (old && old !== api) void old.notificationPresence(this.id, { platform: notificationPlatform(), focused: false, enabled: this.enabled, visibleSessionIds: [] }).catch(() => {});
    this.api = api; this.providers = []; if (api !== this.revokedOn) this.revokedOn = null;
    if (api) {
      notificationRules.retry(api);
      if (this.pendingSession) { const sid = this.pendingSession; this.pendingSession = null; this.navigate(sid); }
      void api.notificationStatus().then(status => { if (this.api === api) this.providers = status.providers; }).catch(() => {});
      void this.heartbeat();
    }
  }
  async permission(): Promise<NotificationStatus["permission"]> {
    if (isTauri()) {
      try { return await (await import("@tauri-apps/plugin-notification")).isPermissionGranted() ? "granted" : "default"; } catch { return "unsupported"; }
    }
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  }
  async status(): Promise<NotificationStatus> {
    return { enabled: this.enabled, permission: await this.permission(), pushConfigured: !!this.native && !!this.registration && this.providers.includes(this.registration.provider) };
  }
  /** Called only from a user gesture in settings, never from an extension/agent. */
  async setEnabled(enabled: boolean) {
    if (enabled) {
      let granted = await this.permission() === "granted";
      if (!granted) {
        if (isTauri()) granted = await (await import("@tauri-apps/plugin-notification")).requestPermission() === "granted";
        else if (typeof Notification !== "undefined") granted = await Notification.requestPermission() === "granted";
      }
      if (!granted) throw new LocalizedError(t("운영체제 알림 권한을 허용해 주세요"));
      if (this.native) { try { this.registration = await this.native.register(); } catch { this.registration = null; } }
    }
    this.enabled = enabled; localStorage.setItem(ENABLED, enabled ? "1" : "0");
    await this.heartbeat();
  }
  /** The server dropped this device from its list ("device_revoked"): stop reporting until the app is connected again. */
  revoked(deviceId: string) {
    if (deviceId === this.id && this.api) this.revokedOn = this.api;
  }
  /** A session was opened or marked read here: clear its notification from this phone now, and tell the server so other phones follow. */
  read(sessionId: string) {
    if (!attended()) return;
    void this.native?.clear?.([sessionId]).catch(() => {});
    void this.heartbeat();
  }
  async heartbeat() {
    const api = this.api;
    if (!api || api === this.revokedOn) return;
    // Looking at a session reads it: its notification in this phone's shade goes away (other devices are told by the server).
    if (attended()) void this.native?.clear?.(this.visible().slice(0, 20)).catch(() => {});
    try {
      await api.notificationPresence(this.id, { platform: notificationPlatform(), focused: attended(), enabled: this.enabled && await this.permission() === "granted", visibleSessionIds: this.visible().slice(0, 20), lang: getLang(), ...await this.identity(), ...(this.registration === undefined ? {} : { push: this.registration }) });
    } catch { /* older/offline server: notifications do not break the app */ }
  }
  /**
   * Asks the server to send this device a notification, then reports the step where it stopped.
   * The test is shown even while the window is in front, since the person is looking at settings.
   */
  async test(): Promise<TestOutcome> {
    const api = this.api;
    if (!api) return { step: "no_server" };
    if (!this.enabled) return { step: "not_enabled" };
    if (await this.permission() !== "granted") return { step: "no_permission" };
    await this.heartbeat(); // the server only knows devices it has heard from recently
    const arrived = new Promise<{ ok: boolean; detail?: string }>((resolve) => {
      const wait = setTimeout(() => resolve({ ok: false }), 6000);
      this.pendingTest = (r) => { clearTimeout(wait); resolve(r); };
    });
    let server: NotificationTestResult;
    try { server = await api.testNotification(this.id); }
    catch (e) { this.pendingTest = undefined; return { step: "server_refused", detail: e instanceof Error ? e.message : String(e) }; }
    if (server.status === "unknown_device") { this.pendingTest = undefined; return { step: "server_unknown", server }; }
    if (server.status === "disabled") { this.pendingTest = undefined; return { step: "not_enabled", server }; }
    const result = await arrived;
    this.pendingTest = undefined;
    if (!result.ok && result.detail === undefined) return { step: "not_received", server };
    return result.ok ? { step: "shown", server } : { step: "os_error", detail: result.detail, server };
  }
  private pendingTest?: (r: { ok: boolean; detail?: string }) => void;
  async receive(device: string, payload: NotificationSpec & { id: string; at: number; source?: string }) {
    if (device !== this.id || this.seen.has(payload.id) || Date.now() - payload.at > 60_000) return;
    const isTest = payload.id.startsWith("test-");
    if (!this.enabled && !isTest) return;
    this.seen.add(payload.id); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    if (!isTest && attended()) { await this.api?.notificationReceived(payload.id).catch(() => {}); return; }
    if (await this.permission() !== "granted") { this.pendingTest?.({ ok: false, detail: "permission" }); return; }
    // The server writes built-in notices in this device's language (it is told in every presence report), so what arrives is shown as is.
    const title = payload.title;
    try {
      if (isTauri() && isWindows()) {
        // Our own toast: clicking it raises the window and opens the session (the plugin's toast has no click handler).
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("show_toast", { title, body: payload.body ?? null, sessionId: payload.sessionId ?? null });
        // no lastShown here: the click is handled exactly by the toast, not guessed from a later focus
      } else if (isTauri()) {
        const plugin = await import("@tauri-apps/plugin-notification");
        // "ic_stat_pipaya" is the status-bar glyph made by scripts/make-icons.py; Android's own default is a generic "i" bubble
        plugin.sendNotification({ title, body: payload.body, icon: "ic_stat_pipaya", extra: { sessionId: payload.sessionId ?? "", notificationId: payload.id }, autoCancel: true });
        if (payload.sessionId && !["android", "ios"].includes(notificationPlatform())) this.lastShown = { sid: payload.sessionId, at: Date.now() };
      } else {
        const notification = new Notification(title, { body: payload.body, tag: payload.sessionId ?? payload.id });
        notification.onclick = () => { window.focus(); if (payload.sessionId) this.openSession(payload.sessionId); notification.close(); };
      }
    } catch (e) { this.pendingTest?.({ ok: false, detail: e instanceof Error ? e.message : String(e) }); return; }
    this.pendingTest?.({ ok: true });
    await this.api?.notificationReceived(payload.id).catch(() => {});
  }
  stop() { clearInterval(this.timer); for (const fn of this.cleanup.splice(0)) fn(); this.connect(null); }
}

export const notifications = new NotificationClient();
