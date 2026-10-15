import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { applicationDefault, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { PushTransport, PushTransports } from "./notifications.ts";

type Payload = Parameters<PushTransport["send"]>[1];
type Platform = Parameters<PushTransport["send"]>[2];

/** The glyph drawn in the Android status bar. Without it Android shows a generic bubble (the launcher icon is not usable there). */
export const ANDROID_STATUS_ICON = "ic_stat_harness";
/** Channel made by the Android push plugin (high importance: sound and a pop-up). Keep in step with PushPlugin.kt. */
export const ANDROID_CHANNEL = "harness_alerts";

/** What FCM is asked to deliver. Kept apart from the network call so its shape can be tested. */
export function fcmMessage(token: string, payload: Payload, platform: Platform) {
  return {
    token,
    notification: { title: payload.title, ...(payload.body ? { body: payload.body } : {}) },
    data: { notificationId: payload.id, sessionId: payload.sessionId ?? "", kind: payload.kind ?? "info", source: payload.source },
    ...(platform === "android" ? { android: { priority: "high" as const, ttl: 300_000, collapseKey: payload.sessionId ?? payload.id, notification: { tag: payload.sessionId ?? payload.id, icon: ANDROID_STATUS_ICON, color: "#25262B", channelId: ANDROID_CHANNEL, defaultSound: true } } } : {}),
    ...(platform === "ios" ? { apns: { headers: { "apns-expiration": String(Math.floor(Date.now() / 1000) + 300), "apns-push-type": "alert", "apns-priority": "10" }, payload: { aps: { sound: "default", threadId: payload.sessionId ?? "harness" } } } } : {}),
  };
}

/** FCM supports Android and iOS (when Firebase has an APNs key). Direct APNs can be injected separately. */
export function createPushTransports(enabled: boolean): { transports: PushTransports; close(): Promise<void> } {
  if (!enabled) return { transports: {}, close: async () => {} };
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.HOME) {
    const defaultSecret = resolve(process.env.HOME, ".secrets/harness/firebase-adminsdk.json");
    if (existsSync(defaultSecret)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = defaultSecret;
    }
  }
  // No credentials (a fresh install without a Firebase key): stay off, so pushConfigured does not claim a push that cannot be sent.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS || !existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) return { transports: {}, close: async () => {} };
  const app: App = initializeApp({ credential: applicationDefault() }, `harness-${crypto.randomUUID()}`);
  const fcm: PushTransport = {
    async send(token, payload, platform) {
      try {
        await getMessaging(app).send(fcmMessage(token, payload, platform));
        return "sent";
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") return "invalid";
        throw new Error("push delivery failed");
      }
    },
  };
  return { transports: { fcm }, close: async () => { const { deleteApp } = await import("firebase-admin/app"); await deleteApp(app); } };
}
