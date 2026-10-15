import { describe, expect, test } from "bun:test";
import { parseNotification, parseNotificationRule } from "../src/lib/notification-contract";
import { firebaseResources } from "../scripts/prepare-android";
describe("structured notification contract", () => {
  test("accepts bounded data and returns a fresh object", () => {
    const input = { title: "요청", body: "확인해 주세요", kind: "user_request" as const, sessionId: "s", key: "once" };
    const result = parseNotification(input); expect(result).toEqual(input); expect(result).not.toBe(input);
    expect(parseNotification({ title: "완료" })).toEqual({ title: "완료" });
  });
  test("unknown keys, URLs/actions, malformed kinds, empty and oversized strings rejected", () => {
    for (const input of [null, [], "text", { title: "" }, { title: "x".repeat(101) }, { title: "t", body: "x".repeat(301) }, { title: "t", kind: "danger" }, { title: "t", url: "https://x" }, { title: "t", force: true }, { title: "t", sessionId: false }, { title: "t", key: "\0" }]) expect(() => parseNotification(input)).toThrow();
  });
  test("server rules cannot inspect transcripts or inject custom code", () => {
    expect(parseNotificationRule({ event: "run_finished", title: "완료" })).toEqual({ event: "run_finished", title: "완료" });
    for (const input of [{ event: "message_end", title: "no" }, { event: "run_finished", title: "ok", filter: "args" }, { event: "approval_requested", title: "ok", code: "alert(1)" }]) expect(() => parseNotificationRule(input)).toThrow();
  });
});
test("Firebase Android resources select the correct application and escape XML", () => {
  const config = { project_info: { project_number: "123", project_id: "test-project" }, client: [{ client_info: { android_client_info: { package_name: "wrong" }, mobilesdk_app_id: "wrong" }, api_key: [{ current_key: "wrong" }] }, { client_info: { android_client_info: { package_name: "work.pipaya.app" }, mobilesdk_app_id: "1:123:android:id" }, api_key: [{ current_key: "a&b" }] }] };
  const xml = firebaseResources(JSON.stringify(config)); expect(xml).toContain("1:123:android:id"); expect(xml).toContain("a&amp;b"); expect(xml).not.toContain("wrong");
  expect(() => firebaseResources("{}")).toThrow();
});

describe("device name", () => {
  test("a hostname that says nothing about the device is not used as its name", async () => {
    const { usefulHostname } = await import("../src/lib/device-name");
    for (const bad of ["localhost", "LOCALHOST", "localhost.localdomain", "android", "127.0.0.1", "::1", "0.0.0.0", "  ", "", null, undefined]) expect(usefulHostname(bad)).toBe("");
    expect(usefulHostname("my-MacBook-Air")).toBe("my-MacBook-Air");
    expect(usefulHostname("  desktop ")).toBe("desktop");
    expect(usefulHostname("localhost-dev-box")).toBe("localhost-dev-box"); // only the exact placeholder names are dropped
  });
});
