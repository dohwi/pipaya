/** Plain types and helpers for the app store: no reactive state, so they can be read (and tested) on their own. */
import { uid } from "./format";
import { K, read, write } from "./persist";
import { snapshotSettingsToDurable } from "./durable-storage";
import type { ApprovalPolicy, DefaultModelSelection, ThinkingLevel } from "./types";

export interface PaletteItem {
  id: string;
  title: string;
  sub?: string;
  /** Small right-aligned tag, e.g. "닫힘". */
  tag?: string;
  /** Tree depth (indentation). */
  depth?: number;
  current?: boolean;
  dim?: boolean;
}
/** A searchable list shown over the chat; opened by commands such as /resume and /tree. */
export interface PaletteSpec {
  title: string;
  items: PaletteItem[];
  empty: string;
  onpick: (item: PaletteItem) => void | Promise<void>;
  /** Optional handler to delete an item in place, showing an 'X' button on each row */
  ondelete?: (item: PaletteItem) => void | Promise<void>;
}

export interface Draft {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  approval: ApprovalPolicy;
}

export interface Server {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  /** The server bundled with the desktop app; its address and token are managed by the app. */
  local?: boolean;
}

/** Load saved servers, migrating the old single-connection format once. */
export function loadServers(): Server[] {
  const list = read<Server[]>(K.servers, []);
  if (list.length) {
    void snapshotSettingsToDurable();
    return list;
  }
  const legacy = read<{ baseUrl: string; token: string } | null>(
    K.legacyConn,
    null,
  );
  if (!legacy) return [];
  const migrated: Server = {
    id: uid(),
    name: "",
    baseUrl: legacy.baseUrl,
    token: legacy.token,
  };
  write(K.servers, [migrated]);
  write(K.currentServer, migrated.id);
  try {
    localStorage.removeItem(K.legacyConn);
  } catch {
    /* ignore */
  }
  return [migrated];
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const DEFAULT_THINKING: ThinkingLevel = "medium";

/** Old/missing/invalid values (including the removed "off") fall back to the default. */
export function normalizeThinking(v: unknown): ThinkingLevel {
  return THINKING_LEVELS.find((l) => l === v) ?? DEFAULT_THINKING;
}

/** What a new chat starts with when the server has a default: its model, and its strength if it names one. */
export function draftFromDefault(d: DefaultModelSelection): Partial<Draft> {
  return {
    provider: d.provider,
    model: d.model,
    ...(d.thinkingLevel ? { thinkingLevel: normalizeThinking(d.thinkingLevel) } : {}),
  };
}

export function readDraft(): Draft {
  const raw = read<Partial<Draft> | null>(K.draft, null);
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    // The model is not restored from the last run: new chats start from the server default
    // (see ensureDraftModel / newChat), not from whatever was used most recently.
    provider: "",
    model: "",
    thinkingLevel: normalizeThinking(o.thinkingLevel),
    approval:
      o.approval === "auto" || o.approval === "readonly" ? o.approval : "ask",
  };
}

/** Where to look for the server by default: same host as the page, port 8787. */
export const defaultServerUrl = (): string =>
  typeof location !== "undefined" &&
  /^https?:$/.test(location.protocol) &&
  location.hostname
    ? `http://${location.hostname}:8787`
    : "http://127.0.0.1:8787";
