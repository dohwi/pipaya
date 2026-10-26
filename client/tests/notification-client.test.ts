import { beforeEach, describe, expect, test } from "bun:test";

/** A minimal browser: enough for NotificationClient to run unattended (no DOM, no Tauri). */
const listeners = new Map<string, Set<() => void>>();
const store = (): Storage => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage; };
const state = { visible: "hidden" as "hidden" | "visible", focus: false, permission: "granted" };
const shown: { title: string; tag?: string }[] = [];
Object.assign(globalThis, {
  localStorage: store(), sessionStorage: store(),
  navigator: { userAgent: "Linux x86_64", platform: "Linux", maxTouchPoints: 0 },
  document: { documentElement: {}, get visibilityState() { return state.visible; }, hasFocus: () => state.focus, addEventListener: (n: string, f: () => void) => { (listeners.get(n) ?? listeners.set(n, new Set()).get(n)!).add(f); }, removeEventListener: (n: string, f: () => void) => void listeners.get(n)?.delete(f) },
  window: { addEventListener: (n: string, f: () => void) => { (listeners.get(`w:${n}`) ?? listeners.set(`w:${n}`, new Set()).get(`w:${n}`)!).add(f); }, removeEventListener: () => {}, focus: () => {} },
  Notification: class { static get permission() { return state.permission; } static requestPermission = async () => state.permission; onclick: (() => void) | null = null; constructor(public title: string, o?: { tag?: string }) { shown.push({ title, tag: o?.tag }); } close() {} },
});
const { NotificationClient } = await import("../src/lib/notifications");

function fakeApi() {
  const calls = { presence: [] as { focused: boolean; enabled: boolean }[], received: [] as string[] };
  return {
    calls,
    api: {
      notificationPresence: async (_id: string, p: { focused: boolean; enabled: boolean }) => void calls.presence.push(p),
      notificationReceived: async (id: string) => void calls.received.push(id),
      testNotification: async () => ({ status: "sent", pushConfigured: false, providers: [], hasToken: false }),
      notificationStatus: async () => ({ pushConfigured: true, providers: ["fcm"] }),
    } as any,
  };
}
const payload = (id: string, over: object = {}) => ({ id, at: Date.now(), source: "pipaya", title: "Task completed", kind: "task_completed", sessionId: "s1", ...over });
beforeEach(() => { state.visible = "hidden"; state.focus = false; state.permission = "granted"; shown.length = 0; localStorage.clear(); });

describe("notification client", () => {
  test("a notice addressed to this device is shown, and the server is told it was shown", async () => {
    const c = new NotificationClient(); const { api, calls } = fakeApi(); c.connect(api); await c.setEnabled(true);
    await c.receive(c.id, payload("n1"));
    expect(shown).toHaveLength(1); expect(calls.received).toEqual(["n1"]);
  });

  test("a notice addressed to another device is ignored", async () => {
    const c = new NotificationClient(); const { api, calls } = fakeApi(); c.connect(api); await c.setEnabled(true);
    await c.receive("someone-else", payload("n2"));
    expect(shown).toHaveLength(0); expect(calls.received).toEqual([]);
  });

  test("looking at the app: no OS notice, but the server is told so the phone is not pushed", async () => {
    const c = new NotificationClient(); const { api, calls } = fakeApi(); c.connect(api); await c.setEnabled(true);
    state.visible = "visible"; state.focus = true;
    await c.receive(c.id, payload("n3"));
    expect(shown).toHaveLength(0); expect(calls.received).toEqual(["n3"]);
  });

  test("the same notice twice is shown once; a stale one (over a minute old) is not shown", async () => {
    const c = new NotificationClient(); const { api } = fakeApi(); c.connect(api); await c.setEnabled(true);
    await c.receive(c.id, payload("n4")); await c.receive(c.id, payload("n4"));
    await c.receive(c.id, payload("n5", { at: Date.now() - 61_000 }));
    expect(shown).toHaveLength(1);
  });

  test("switched off, or permission taken away: nothing is shown", async () => {
    const c = new NotificationClient(); const { api } = fakeApi(); c.connect(api);
    await c.receive(c.id, payload("n6")); expect(shown).toHaveLength(1); // on by default
    await c.setEnabled(false);
    await c.receive(c.id, payload("n6b")); expect(shown).toHaveLength(1); // switched off
    await c.setEnabled(true); state.permission = "denied";
    await c.receive(c.id, payload("n7")); expect(shown).toHaveLength(1);
  });

  test("reports never overtake each other: a slow older one cannot land after a newer one", async () => {
    const c = new NotificationClient(); const sent: boolean[] = []; let release!: () => void;
    const api = { notificationPresence: async (_id: string, p: { focused: boolean }) => { sent.push(p.focused); if (sent.length === 1) await new Promise<void>((r) => { release = r; }); }, notificationStatus: async () => ({ pushConfigured: false, providers: [] }) } as any;
    c.connect(api); await new Promise((r) => setTimeout(r, 20)); // first report (unfocused) is stuck in flight
    state.visible = "visible"; state.focus = true;
    const a = c.heartbeat(), b = c.heartbeat();
    await new Promise((r) => setTimeout(r, 20)); expect(sent).toEqual([false]); // nothing is sent while the older one is in flight
    release(); await Promise.all([a, b]);
    expect(sent).toEqual([false, true]); // one follow-up, carrying the state at that moment
  });

  test("the app reports whether it is being looked at, and says so the moment it is", async () => {
    const c = new NotificationClient(); const { api, calls } = fakeApi(); c.init(() => [], () => {}); c.connect(api); await c.setEnabled(true);
    const before = calls.presence.length;
    state.visible = "visible"; state.focus = true;
    for (const f of listeners.get("w:focus") ?? []) f();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.presence.length).toBeGreaterThan(before);
    expect(calls.presence.at(-1)!.focused).toBe(true);
    c.stop();
  });

  test("turning notifications on without OS permission is refused with a message", async () => {
    const c = new NotificationClient(); const { api } = fakeApi(); c.connect(api); await c.setEnabled(false); state.permission = "denied";
    await expect(c.setEnabled(true)).rejects.toThrow();
    expect(c.enabled).toBe(false);
  });

  test("a test notification is shown even when the window is in front", async () => {
    const c = new NotificationClient(); const { api } = fakeApi(); c.connect(api); await c.setEnabled(true);
    state.visible = "visible"; state.focus = true;
    await c.receive(c.id, payload("test-1"));
    expect(shown).toHaveLength(1);
  });

  test("a test is reported as shown once this device receives it", async () => {
    const c = new NotificationClient(); const { api } = fakeApi(); c.connect(api); await c.setEnabled(true);
    (api as any).testNotification = async () => { setTimeout(() => void c.receive(c.id, payload("test-2")), 5); return { status: "sent", pushConfigured: false, providers: [], hasToken: false }; };
    const r = await c.test();
    expect(r.step).toBe("shown"); expect(shown).toHaveLength(1);
  });

  test("a test names the step that stopped it", async () => {
    const off = new NotificationClient(); const a = fakeApi(); off.connect(a.api); await off.setEnabled(false);
    expect((await off.test()).step).toBe("not_enabled");
    const none = new NotificationClient(); expect((await none.test()).step).toBe("no_server");
    const c = new NotificationClient(); const { api } = fakeApi(); c.connect(api); await c.setEnabled(true);
    (api as any).testNotification = async () => ({ status: "unknown_device", pushConfigured: false, providers: [], hasToken: false });
    expect((await c.test()).step).toBe("server_unknown");
    (api as any).testNotification = async () => { throw new Error("404"); };
    expect((await c.test()).step).toBe("server_refused");
    state.permission = "denied";
    expect((await c.test()).step).toBe("no_permission");
  });

  test("the server is told which language this device reads, so a push written while the app is closed matches it", async () => {
    const c = new NotificationClient(); const { api, calls } = fakeApi(); c.connect(api); await c.setEnabled(true);
    await c.heartbeat();
    expect(["ko", "en"]).toContain((calls.presence.at(-1) as any).lang);
  });

  test("a notice from the server is shown exactly as it was written there", async () => {
    const c = new NotificationClient(); const { api } = fakeApi(); c.connect(api); await c.setEnabled(true);
    await c.receive(c.id, payload("n9", { title: "✅ 작업 완료 · 로그인 버그", body: "토큰 갱신을 고쳤습니다" }));
    expect(shown[0]!.title).toBe("✅ 작업 완료 · 로그인 버그");
  });
});

describe("device list identity", () => {
  test("a browser is called after its OS and browser, and reports both versions", async () => {
    const { deviceIdentity } = await import("../src/lib/notifications");
    expect(await deviceIdentity("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87", false))
      .toEqual({ name: "Windows · Edge 126", os: "Windows", app: "Edge 126" });
    expect(await deviceIdentity("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15", false))
      .toEqual({ name: "macOS · Safari 17", os: "macOS", app: "Safari 17" });
    expect(await deviceIdentity("", false)).toEqual({ name: "Web", os: "", app: "Web" });
  });
  test("an app that cannot reach the native side falls back to what the user agent says", async () => {
    const { deviceIdentity } = await import("../src/lib/notifications");
    expect(await deviceIdentity("Mozilla/5.0 (Linux; Android 14; SM-S938B) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36", true))
      .toEqual({ name: "Android app", os: "Android", app: "App" });
  });
  test("a removed device stops reporting to that server, and starts again once connected anew", async () => {
    const calls: unknown[] = [];
    const first = { notificationPresence: async (_id: string, p: unknown) => void calls.push(p), notificationStatus: async () => ({ pushConfigured: false, providers: [] }) } as never;
    const second = { notificationPresence: async (_id: string, p: unknown) => void calls.push(p), notificationStatus: async () => ({ pushConfigured: false, providers: [] }) } as never;
    const client = new NotificationClient();
    client.connect(first); await client.heartbeat(); const before = calls.length;
    client.revoked("someone-else"); await client.heartbeat(); expect(calls.length).toBe(before + 1);
    client.revoked(client.id); await client.heartbeat(); expect(calls.length).toBe(before + 1);
    client.connect(second); await client.heartbeat(); expect(calls.length).toBeGreaterThan(before + 1);
    client.stop();
  });

  test("a server not in view is still reported to (never as looked at), and its notice is shown", async () => {
    const view = fakeApi(), back = fakeApi();
    const c = new NotificationClient(); c.connect(view.api); await c.setEnabled(true);
    c.track([view.api, back.api]); await c.heartbeat();
    state.visible = "visible"; state.focus = true; await c.heartbeat();
    expect(back.calls.presence.length).toBeGreaterThan(0);
    expect(back.calls.presence.every((p) => p.focused === false && p.enabled)).toBe(true);
    await c.receive(c.id, payload("bg1"), back.api);
    expect(shown).toHaveLength(1); expect(back.calls.received).toEqual(["bg1"]);
  });
});
