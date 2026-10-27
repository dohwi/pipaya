import { beforeEach, expect, test } from "bun:test";
import { ConfigurationManager, parseConfiguration, parseKeybindings, publicSettings, CONFIGURATION_BACKUP } from "../src/lib/extensions/configuration";
const store = new Map<string, string>();
beforeEach(() => { store.clear(); Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } }); });
const pkg = { manifest: { id: "example.theme", name: "Theme", version: "1.0.0", sdkVersion: 1, permissions: [], settings: [{ key: "token", type: "string", label: "Token" }, { key: "mode", type: "string", label: "Mode" }] }, theme: { dark: { "--bg": "#111" } } };
const document = () => parseConfiguration({ schemaVersion: 1, servers: [{ name: "Work", baseUrl: "http://100.64.0.1:8787" }], extensions: [{ package: pkg, enabled: true, settings: { token: "private", mode: "compact", unknown: "private" } }], preferences: { theme: "dark" } }, "example.owner");
const flush = () => new Promise(r => setTimeout(r, 0));
test("secret and undeclared values excluded in both directions", () => {
  expect(publicSettings({ apiKey: "secret", custom: "secret", mode: "compact" }, [{ key: "apiKey", type: "string", label: "Key" }, { key: "custom", type: "string", label: "Custom", secret: true }, { key: "mode", type: "string", label: "Mode" }])).toEqual({ mode: "compact" });
  expect(document().extensions[0]!.settings).toEqual({ mode: "compact" });
});
test("package, owner, duplicate, URL and preferences validation", () => {
  const d = document();
  expect(() => parseConfiguration({ ...d, servers: [{ name: "bad", baseUrl: "https://a.test?token=secret" }] })).toThrow();
  expect(() => parseConfiguration(d, "example.theme")).toThrow();
  expect(() => parseConfiguration({ ...d, extensions: [...d.extensions, ...d.extensions] })).toThrow();
  expect(() => parseConfiguration({ ...d, preferences: { volume: -1 } })).toThrow();
});
function manager() {
  let resolve = (_: boolean) => {};
  const calls: unknown[] = [];
  const manager = new ConfigurationManager({ capture: document, apply: d => calls.push(d), backup: () => ({ before: true }), restore: d => calls.push(d), confirm: () => new Promise<boolean>(r => { resolve = r; }) });
  return { manager, calls, approve: (b: boolean) => resolve(b) };
}
test("export returns nothing before approval, apply backs up, restore is approved", async () => {
  const { manager: m, calls, approve } = manager();
  m.start("export", "example.owner"); expect(m.status()?.document).toBeUndefined(); approve(true); await flush(); expect(m.status()?.document).toEqual(document());
  m.start("apply", "example.owner", document()); expect(calls).toHaveLength(0); approve(true); await flush(); expect(store.get(CONFIGURATION_BACKUP)).toBe('{"before":true}'); expect(calls).toHaveLength(1);
  m.start("restore", "example.owner"); approve(true); await flush(); expect(calls[1]).toEqual({ before: true });
});
test("cancel, concurrent jobs and dead generation cause no changes", async () => {
  const { manager: m, calls, approve } = manager();
  m.start("apply", "example.owner", document()); expect(() => m.start("export", "example.owner")).toThrow(); approve(false); await flush(); expect(m.status()?.state).toBe("cancelled");
  m.start("apply", "example.owner", document()); m.cleanup(); approve(true); await flush(); expect(calls).toHaveLength(0); expect(m.status()).toBeNull();
});

import { CONFIGURATION_BACKUP_AT, applyWithBackup, backupSavedAt, hasBackup, planConfiguration, planSummary, restoreBackup, saveBackup } from "../src/lib/extensions/configuration";
const current = (over: Partial<Parameters<typeof planConfiguration>[1]> = {}) => ({ servers: [], extensions: [], unreadable: [], preferences: {}, ...over });

test("plan: servers merge by URL, extensions install or replace, preferences only when different", () => {
  const d = document();
  const fresh = planConfiguration(d, current());
  expect(fresh.servers.add).toEqual([{ name: "Work", baseUrl: "http://100.64.0.1:8787" }]);
  expect(fresh.extensions.install.map(e => e.id)).toEqual(["example.theme"]);
  expect(fresh.preferences).toEqual(["테마: 다크"]);
  expect(fresh.empty).toBe(false);

  const same = planConfiguration(d, current({
    servers: [{ name: "Work", baseUrl: "http://100.64.0.1:8787" }],
    extensions: [{ id: "example.theme", name: "Theme", version: "1.0.0" }],
    preferences: { theme: "dark" },
  }));
  expect(same.servers.keep).toBe(1);
  expect(same.extensions.replace).toHaveLength(1); // a same-id package is always swapped in (and loses consent)
  expect(same.servers.add).toHaveLength(0);
  expect(same.preferences).toEqual([]);

  const renamed = planConfiguration(d, current({ servers: [{ name: "Old", baseUrl: "http://100.64.0.1:8787" }] }));
  expect(renamed.servers.rename).toEqual([{ baseUrl: "http://100.64.0.1:8787", from: "Old", to: "Work" }]);
});

test("plan: an empty document changes nothing; the 50-extension limit blocks", () => {
  const none = planConfiguration(parseConfiguration({ schemaVersion: 1, servers: [], extensions: [], preferences: {} }), current());
  expect(none.empty).toBe(true);
  expect(planSummary(none)).toEqual([]);
  const full = Array.from({ length: 50 }, (_, i) => ({ id: `x.e${i}`, name: `E${i}`, version: "1.0.0" }));
  const blocked = planConfiguration(document(), current({ extensions: full }));
  expect(blocked.blocked).toContain("50");
  // an unreadable entry with the same id is taken over, not added
  const takeover = planConfiguration(document(), current({ extensions: full.slice(0, 49), unreadable: [{ id: "example.theme" }] }));
  expect(takeover.blocked).toBeNull();
});

test("plan summary lists each kind of change once", () => {
  expect(planSummary(planConfiguration(document(), current()))).toEqual(["서버 1개 추가", "확장 1개 설치", "앱 설정 1개 변경"]);
});

test("backup keeps its time; a failed apply puts the backup back", () => {
  expect(hasBackup()).toBe(false);
  expect(backupSavedAt()).toBeNull();
  saveBackup({ a: 1 }, 1700000000000);
  expect(hasBackup()).toBe(true);
  expect(backupSavedAt()).toBe(1700000000000);
  store.delete(CONFIGURATION_BACKUP_AT);
  expect(backupSavedAt()).toBeNull(); // an older backup without a time is still restorable
  expect(hasBackup()).toBe(true);

  const restored: unknown[] = [];
  expect(() => applyWithBackup({ backup: () => ({ before: 1 }), apply: () => { throw new Error("boom"); }, restore: v => restored.push(v) }, document())).toThrow("boom");
  expect(restored).toEqual([{ before: 1 }]);
  const back: unknown[] = [];
  restoreBackup({ restore: v => back.push(v) });
  expect(back).toEqual([{ before: 1 }]);
});

test("the owner's own slot is reserved only when there is an owner", () => {
  const many = (n: number) => ({ schemaVersion: 1, servers: [], preferences: {}, extensions: Array.from({ length: n }, (_, i) => ({ package: { ...pkg, manifest: { id: `x.e${i}`, name: `E${i}`, version: "1.0.0", sdkVersion: 1, permissions: [] } }, enabled: false, settings: {} })) });
  expect(() => parseConfiguration(many(50))).not.toThrow(); // the user can bring all 50
  expect(() => parseConfiguration(many(50), "x.owner")).toThrow(); // an extension may bring 49: it occupies one slot itself
  expect(() => parseConfiguration(many(49), "x.owner")).not.toThrow();
});

test("keybindings in a file: known rebindable actions are kept, unknown ones ignored, bad values refused", () => {
  expect(parseKeybindings({ newChat: "Mod+K", toggleSidebar: "" })).toEqual({ newChat: "Mod+K", toggleSidebar: "" });
  expect(parseKeybindings({ fromTheFuture: "Mod+Q" })).toEqual({});
  expect(() => parseKeybindings({ newChat: 5 })).toThrow();
  expect(() => parseKeybindings({ newChat: "x".repeat(81) })).toThrow();
  expect(() => parseKeybindings([])).toThrow();
});
test("a file without keybindings (an older export) is still valid", () => {
  const d = parseConfiguration({ schemaVersion: 1, servers: [], extensions: [], preferences: {} });
  expect(d.keybindings).toBeUndefined();
  expect(parseConfiguration({ schemaVersion: 1, servers: [], extensions: [], preferences: {}, keybindings: { newChat: "Mod+K" } }).keybindings).toEqual({ newChat: "Mod+K" });
});
test("the import preview lists shortcuts that would change, and nothing for ones already the same", () => {
  const d = parseConfiguration({ schemaVersion: 1, servers: [], extensions: [], preferences: {}, keybindings: { newChat: "Mod+K", toggleSidebar: "Mod+J" } });
  const p = planConfiguration(d, { servers: [], extensions: [], unreadable: [], keybindings: { toggleSidebar: "Mod+J" } });
  expect(p.keybindings).toEqual([{ id: "newChat", from: "", to: "Mod+K" }]);
  expect(p.empty).toBe(false);
  expect(planConfiguration(d, { servers: [], extensions: [], unreadable: [], keybindings: { newChat: "Mod+K", toggleSidebar: "Mod+J" } }).empty).toBe(true);
});
