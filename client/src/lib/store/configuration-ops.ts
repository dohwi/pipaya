import { parseConfiguration, parseKeybindings, type ConfigurationDocument } from "../extensions/configuration";
import { LocalizedError, t } from "../i18n";
import type { Server } from "../store-model";

export interface ParsedAppBackup {
  servers: Server[];
  preferences: ConfigurationDocument["preferences"];
  bindings: Record<string, string> | null;
}

/** Validate and normalize a full app backup JSON payload before applying it to store state. */
export function parseAppBackup(value: unknown): ParsedAppBackup {
  const raw = value as {
    servers: Server[];
    preferences: ConfigurationDocument["preferences"];
    bindings?: Record<string, string>;
  };
  if (!raw || !Array.isArray(raw.servers)) throw new LocalizedError(t("잘못된 앱 백업"));
  const checked = parseConfiguration({
    schemaVersion: 1,
    servers: raw.servers.map((s) => ({ name: s.name, baseUrl: s.baseUrl })),
    extensions: [],
    preferences: raw.preferences,
  });
  if (raw.servers.some((s) => typeof s.id !== "string" || typeof s.token !== "string")) {
    throw new LocalizedError(t("잘못된 서버 백업"));
  }
  return {
    servers: raw.servers.map((s, i) => ({ ...checked.servers[i]!, id: s.id, token: s.token })),
    preferences: checked.preferences,
    bindings: raw.bindings && typeof raw.bindings === "object" ? parseKeybindings(raw.bindings) : null,
  };
}
