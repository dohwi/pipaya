/**
 * Preferences that belong to one SERVER (starred models and folders, how long a PC notification may stay unread): kept per
 * server id in this browser and shared with every other client of that server through `ServerSettingsSync`.
 *
 * The store owns one instance and calls `load` / `clear` when the server in view changes; this class knows nothing else of it.
 */
import { DEFAULT_ESCALATE, ESCALATE_CHOICES } from "./notification-contract";
import type { SyncAdapter, SyncKey } from "./server-settings";
import { K, read, write } from "./persist";
import type { ModelInfo } from "./types";

const MAX_FAV_MODELS = 200;
const MAX_FAV_DIRS = 100;

const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);
const isChoice = (v: unknown): v is number => typeof v === "number" && (ESCALATE_CHOICES as readonly number[]).includes(v);
const modelKey = (provider: string, id: string) => `${provider}\u0000${id}`;

/** Every localStorage key this class keeps for a server (the store clears them when the server is removed). */
export const serverPrefKeys = (serverId: string): string[] => [`${K.favModels}.${serverId}`, `${K.favDirs}.${serverId}`, `${K.escalate}.${serverId}`];

export class ServerPrefs {
  /** Starred models of the open server: `<provider>\u0000<modelId>`. */
  favModels = $state<string[]>([]);
  /** Starred working directories (absolute paths) of the open server, shown in the directory picker. */
  favDirs = $state<string[]>([]);
  /** Minutes an unread PC notification waits before the phone is pushed too (the server acts on it). */
  escalateMinutes = $state<number>(DEFAULT_ESCALATE);

  private serverId: string | null = null;

  /**
   * @param changed told when a local edit should be uploaded
   * @param models the open server's models, to drop stars of models that are gone
   */
  constructor(private changed: (key: SyncKey) => void, private models: () => readonly ModelInfo[]) {}

  /** Read what this browser kept for `serverId`. */
  load(serverId: string) {
    this.serverId = serverId;
    this.favModels = strings(read<unknown>(`${K.favModels}.${serverId}`, []), MAX_FAV_MODELS);
    this.favDirs = strings(read<unknown>(`${K.favDirs}.${serverId}`, []), MAX_FAV_DIRS);
    const v = read<unknown>(`${K.escalate}.${serverId}`, null);
    this.escalateMinutes = isChoice(v) ? v : DEFAULT_ESCALATE;
  }

  /** No server is in view. */
  clear() {
    this.serverId = null;
    this.favModels = [];
    this.favDirs = [];
    this.escalateMinutes = DEFAULT_ESCALATE;
  }

  /** Starred models that still exist, in the order they were starred (the picker's order, and the quick-switch slots). */
  get favModelList(): ModelInfo[] {
    const all = this.models();
    return this.favModels.map((k) => all.find((m) => modelKey(m.provider, m.id) === k)).filter((m): m is ModelInfo => !!m);
  }
  isFavModel(provider: string, id: string) {
    return this.favModels.includes(modelKey(provider, id));
  }
  toggleFavModel(provider: string, id: string) {
    const k = modelKey(provider, id);
    this.favModels = this.favModels.includes(k) ? this.favModels.filter((x) => x !== k) : [...this.favModels, k];
    if (this.serverId) write(`${K.favModels}.${this.serverId}`, this.favModels);
    this.changed("favModels");
  }

  isFavDir(path: string) {
    return this.favDirs.includes(path);
  }
  toggleFavDir(path: string) {
    this.favDirs = this.favDirs.includes(path) ? this.favDirs.filter((x) => x !== path) : [...this.favDirs, path];
    if (this.serverId) write(`${K.favDirs}.${this.serverId}`, this.favDirs);
    this.changed("favDirs");
  }

  setEscalateMinutes(minutes: number) {
    if (!isChoice(minutes) || minutes === this.escalateMinutes) return;
    this.escalateMinutes = minutes;
    if (this.serverId) write(`${K.escalate}.${this.serverId}`, minutes);
    this.changed("notificationPolicy");
  }

  /** How each shared key reads from and writes to this browser, for `ServerSettingsSync`. */
  adapters(serverId: string): Partial<Record<SyncKey, SyncAdapter>> {
    const favKey = `${K.favModels}.${serverId}`;
    const favDirKey = `${K.favDirs}.${serverId}`;
    const escKey = `${K.escalate}.${serverId}`;
    return {
      favModels: {
        // undefined = this device has never had a list for this server, so there is nothing to offer yet
        read: () => (localStorage.getItem(favKey) !== null || this.favModels.length ? this.favModels : undefined),
        apply: (v) => {
          this.favModels = strings(v, MAX_FAV_MODELS);
          write(favKey, this.favModels);
        },
      },
      favDirs: {
        read: () => (localStorage.getItem(favDirKey) !== null || this.favDirs.length ? this.favDirs : undefined),
        apply: (v) => {
          this.favDirs = strings(v, MAX_FAV_DIRS);
          write(favDirKey, this.favDirs);
        },
      },
      notificationPolicy: {
        // only offer what the user actually chose on this device; otherwise the server's value (or its default) stands
        read: () => (localStorage.getItem(escKey) !== null ? { escalateMinutes: this.escalateMinutes } : undefined),
        apply: (v) => {
          const m = (v as { escalateMinutes?: unknown } | null)?.escalateMinutes;
          if (isChoice(m)) {
            this.escalateMinutes = m;
            write(escKey, m);
          }
        },
      },
    };
  }
}
