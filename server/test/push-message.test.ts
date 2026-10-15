import { describe, expect, test } from "bun:test";
import { fcmMessage } from "../src/push.ts";

const payload = { id: "n1", at: 1, source: "harness", title: "Task completed", sessionId: "s1", kind: "task_completed" } as any;

describe("push message", () => {
  test("Android is told which status-bar icon to draw", () => {
    const m = fcmMessage("tok", payload, "android") as any;
    expect(m.android.notification.icon).toBe("ic_stat_harness");
    expect(m.android.notification.tag).toBe("s1");
  });
  test("Android is told to use the high-importance channel, so the push pops up with a sound", () => {
    const m = fcmMessage("tok", payload, "android") as any;
    expect(m.android.notification.channelId).toBe("harness_alerts");
    expect(m.android.priority).toBe("high");
  });
  test("carries only the title, an optional body and ids: nothing from the conversation", () => {
    const m = fcmMessage("tok", { ...payload, body: undefined }, "android") as any;
    expect(m.notification).toEqual({ title: "Task completed" });
    expect(Object.keys(m.data).sort()).toEqual(["kind", "notificationId", "sessionId", "source"]);
  });
  test("iOS gets no Android settings", () => {
    const m = fcmMessage("tok", payload, "ios") as any;
    expect(m.android).toBeUndefined(); expect(m.apns.payload.aps.threadId).toBe("s1");
  });
});
