/**
 * Focused browser `localStorage` persistence helpers for `ExtensionHost`.
 * Isolates key formats, safe JSON parsing, and best-effort storage cleanup from runtime orchestration.
 */
import { read as readStore } from "../persist";

export const EXT_STORAGE_KEYS = {
  list: "pipaya.extensions.v1",
  safe: "pipaya.extensions.safe",
  boot: "pipaya.extensions.booting",
  kept: "pipaya.extensions.kept",
  corrupt: "pipaya.extensions.v1.corrupt",
  legacyDevice: "pipaya.extensions.device.v1",
  shortcutKeys: "pipaya.extensions.shortcut-keys",
  storePrefix: "pipaya.extension.storage.",
  localIds: "pipaya.extensions.local-ids",
  legacySource: "pipaya.extensions.settings-source",
  pending: "pipaya.extensions.pending",
} as const;

export const MAX_KEPT_ENTRIES = 50;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The user's extension shortcut overrides: `{ "<extension id>:<shortcut id>": combo | "" }`. */
export function readExtensionShortcuts(storage?: Storage): Record<string, string> {
  let raw: Record<string, unknown> | null = null;
  if (storage) {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(EXT_STORAGE_KEYS.shortcutKeys) ?? "null");
      if (isPlainRecord(parsed)) raw = parsed;
    } catch {
      raw = null;
    }
  } else {
    raw = readStore<Record<string, unknown> | null>(EXT_STORAGE_KEYS.shortcutKeys, null);
  }
  const out: Record<string, string> = {};
  if (isPlainRecord(raw)) {
    for (const [key, combo] of Object.entries(raw)) {
      if (/^[a-z][a-z0-9.-]*:[a-z][a-z0-9-]*$/.test(key) && typeof combo === "string") {
        out[key] = combo.slice(0, 40);
      }
    }
  }
  return out;
}

export function readBootingIds(storage: Storage = localStorage): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(EXT_STORAGE_KEYS.boot) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function writeBootingIds(ids: string[], storage: Storage = localStorage): void {
  try {
    if (ids.length) storage.setItem(EXT_STORAGE_KEYS.boot, JSON.stringify(ids));
    else storage.removeItem(EXT_STORAGE_KEYS.boot);
  } catch {
    /* ignore storage limit / privacy mode errors */
  }
}

export function readKeptSettingsMap(storage: Storage = localStorage): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  try {
    const stored: unknown = JSON.parse(storage.getItem(EXT_STORAGE_KEYS.kept) ?? "{}");
    if (!isPlainRecord(stored)) return out;
    for (const [id, value] of Object.entries(stored)) {
      if (isPlainRecord(value)) out.set(id, value);
    }
  } catch {
    /* treat corrupt data as empty */
  }
  return out;
}

export function writeKeptSettingsMap(
  map: Map<string, Record<string, unknown>>,
  storage: Storage = localStorage,
): void {
  try {
    if (map.size) storage.setItem(EXT_STORAGE_KEYS.kept, JSON.stringify(Object.fromEntries(map)));
    else storage.removeItem(EXT_STORAGE_KEYS.kept);
  } catch {
    /* best effort */
  }
}

export function pruneKeptSettings(
  map: Map<string, Record<string, unknown>>,
  maxEntries = MAX_KEPT_ENTRIES,
): void {
  for (const key of [...map.keys()]) {
    if (map.size <= maxEntries) break;
    map.delete(key);
  }
}

export function dropLegacyLocalSwitches(serverId: string | null, storage: Storage = localStorage): void {
  try {
    storage.removeItem(serverId ? `${EXT_STORAGE_KEYS.localIds}.${serverId}` : EXT_STORAGE_KEYS.localIds);
    storage.removeItem(EXT_STORAGE_KEYS.legacySource);
  } catch {
    /* no storage */
  }
}

export function readSafeModeFlag(storage: Storage = localStorage, search = typeof location !== "undefined" ? location.search : ""): boolean {
  try {
    return storage.getItem(EXT_STORAGE_KEYS.safe) === "1" || new URLSearchParams(search).get("extensions") === "off";
  } catch {
    return false;
  }
}

export function writeSafeModeFlag(on: boolean, storage: Storage = localStorage): void {
  storage.setItem(EXT_STORAGE_KEYS.safe, on ? "1" : "0");
}
