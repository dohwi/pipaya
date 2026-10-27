import { LocalizedError, t } from "./i18n";
/** Minutes a notification shown on a PC may stay unread before the phone is pushed too. Server scope: the server acts on it. */
export const ESCALATE_CHOICES = [0, 1, 2, 3, 5, 10, 15, 30, 60] as const;
export const DEFAULT_ESCALATE = 3;
/** Data-only notification contract shared by the host and extension SDK. */
export const NOTIFICATION_KINDS = ["task_completed", "task_failed", "user_request", "info"] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export interface NotificationSpec {
  title: string;
  body?: string;
  kind?: NotificationKind;
  sessionId?: string;
  /** Idempotency key, scoped to the extension on the server. */
  key?: string;
}
export interface NotificationResult { id: string; delivered: number; suppressed: boolean }
export interface NotificationStatus { enabled: boolean; permission: "granted" | "denied" | "default" | "unsupported"; pushConfigured: boolean }
/** What the server could tell about a test notification; the app adds what happened on this device. */
export interface NotificationTestResult {
  status: "sent" | "disabled" | "unknown_device";
  id?: string;
  pushConfigured: boolean;
  providers: ("fcm" | "apns")[];
  hasToken: boolean;
}
/** One device the server knows, as GET /notifications/devices reports it. `live`: heard from in the last moments. `push`: reachable with the app closed. */
export interface NotificationDevice {
  id: string;
  platform: "desktop" | "android" | "ios" | "web";
  /** Hostname on a desktop ("my-MacBook-Air"); "OS · browser" in a browser */
  name: string | null;
  /** "macOS 15.1 · aarch64" */
  os: string | null;
  /** "App 0.1.42", "Chrome 126" */
  app: string | null;
  enabled: boolean;
  live: boolean;
  push: boolean;
  lastSeen: number | null;
}
export type NotificationTrigger = "run_finished" | "question_requested";
export interface NotificationRule { event: NotificationTrigger; title: string; body?: string }

export function parseNotification(value: unknown): NotificationSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalizedError(t("알림 객체가 필요합니다"));
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["title", "body", "kind", "sessionId", "key"].includes(k))) throw new LocalizedError(t("지원하지 않는 알림 필드"));
  const text = (key: string, max: number, required = false): string | undefined => {
    const x = v[key];
    if (x === undefined && !required) return undefined;
    if (typeof x !== "string" || !x.trim() || x.length > max || /[\x00-\x08\x0b-\x1f]/.test(x)) throw new LocalizedError(t("잘못된 알림 {key}", { key }));
    return x;
  };
  const title = text("title", 100, true)!;
  const body = text("body", 300), sessionId = text("sessionId", 80), key = text("key", 80);
  if (v.kind !== undefined && !NOTIFICATION_KINDS.includes(v.kind as NotificationKind)) throw new LocalizedError(t("잘못된 알림 종류"));
  return { title, ...(body === undefined ? {} : { body }), ...(sessionId === undefined ? {} : { sessionId }), ...(key === undefined ? {} : { key }), ...(v.kind === undefined ? {} : { kind: v.kind as NotificationKind }) };
}
export function parseNotificationRule(value: unknown): NotificationRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalizedError(t("알림 규칙 객체가 필요합니다"));
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["event", "title", "body"].includes(k)) || !["run_finished", "question_requested"].includes(v.event as string)) throw new LocalizedError(t("잘못된 알림 규칙"));
  const spec = parseNotification({ title: v.title, ...(v.body === undefined ? {} : { body: v.body }) });
  return { event: v.event as NotificationTrigger, ...spec };
}
