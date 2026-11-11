import type { Api } from "./api";
import { extensions } from "./extensions/host.svelte";
import { ServerExtensionStore } from "./extensions/server-store";
import { notifications } from "./notifications";
import { ServerSettingsSync } from "./server-settings";

export interface ClientExtensionRow { id: string; name: string; version: string; live: boolean; enabled: boolean }

/**
 * Editors of the client extensions of saved servers that are NOT the open one (settings can show any server). Each has its
 * own connection and its own sync, so a change reaches the server it was made on and never the open one.
 *
 * The store owns one instance. It tells this class which server is open and how to reach a server's api; nothing else.
 */
export class IdleExtensionStores {
  /** Bumped whenever one of those editors changed, so what shows them reads again. */
  tick = $state(0);
  /** Resolves when the editor of the server just opened has sent its last edits. */
  private handover: Promise<void> = Promise.resolve();
  private editors = new Map<string, { store: ServerExtensionStore; sync: ServerSettingsSync; api: Api }>();

  constructor(private readonly env: { openId: () => string | null; apiOf: (serverId: string) => Api | null }) {}

  /** The editor of a server's client extensions, or null for the open server (its host has them) and for one not attached yet. */
  of(serverId: string | null | undefined): ServerExtensionStore | null {
    void this.tick;
    if (!serverId || serverId === this.env.openId()) return null;
    return this.editors.get(serverId)?.store ?? null;
  }

  /** Make the editor of this server ready (read its stored list, then what the server holds) and keep it in step. */
  async attach(serverId: string): Promise<void> {
    if (serverId === this.env.openId()) return;
    const api = this.env.apiOf(serverId);
    if (!api) return;
    const old = this.editors.get(serverId);
    if (old && old.api === api) return;
    void this.drop(serverId);
    const holder: { sync?: ServerSettingsSync } = {};
    const store: ServerExtensionStore = new ServerExtensionStore({
      serverId,
      api: () => this.env.apiOf(serverId),
      storage: localStorage,
      changed: (key) => holder.sync?.changed(key),
      updated: () => { this.tick++; },
    });
    const sync = new ServerSettingsSync({
      api,
      origin: notifications.id,
      storage: localStorage,
      storageKey: `pipaya.settings-sync.${serverId}`,
      adapters: {
        extensions: { read: () => store.packages(), apply: (v) => store.applyPackages(v) },
        extensionStates: { read: () => store.states(), apply: (v) => store.applyStates(v) },
      },
    });
    holder.sync = sync;
    this.editors.set(serverId, { store, sync, api });
    this.tick++;
    try { await sync.pull(); } catch { /* unreachable: the stored copy stays and is uploaded on the next try */ }
    if (this.editors.get(serverId)?.sync !== sync) return;
    await store.loadRemoteSettings();
    this.tick++;
  }

  /** Stop editing a server's list apart from the host (it was opened, or removed). Pending changes are sent first. */
  drop(serverId: string): Promise<void> {
    const e = this.editors.get(serverId);
    if (!e) return Promise.resolve();
    this.editors.delete(serverId);
    this.tick++;
    // Its last edits reach the server before anything else reads that server again (the host pulls when it opens it).
    return e.sync.flush().catch(() => {}).finally(() => e.sync.dispose());
  }

  /** The server was opened: its idle editor hands its edits over, and `settled` waits for that. */
  handOver(serverId: string): void {
    this.handover = this.drop(serverId);
  }
  /** Resolves when the editor handed over last has sent its last edits. */
  get settled(): Promise<void> {
    return this.handover;
  }

  /** A `client_settings_updated` event of a server that is not open: the editor of that server follows it. */
  onEvent(serverId: string, data: { key?: unknown; updatedAt?: unknown; origin?: unknown }): void {
    void this.editors.get(serverId)?.sync.onEvent(data);
  }

  /**
   * The client extensions as one server sees them: the host's when it is open, the idle editor's otherwise. Never
   * another server's: the host only holds the open server's.
   */
  clientsOf(serverId: string | null | undefined): ClientExtensionRow[] {
    const open = !serverId || serverId === this.env.openId();
    const row = (e: { package: { manifest: { id: string; name: string; version: string } }; enabled: boolean }, live: boolean): ClientExtensionRow =>
      ({ id: e.package.manifest.id, name: e.package.manifest.name, version: e.package.manifest.version, live, enabled: e.enabled });
    const own = open ? extensions.installed.map((e) => row(e, e.state === "active" || e.state === "starting")) : [];
    const idle = open ? [] : (this.of(serverId)?.installed ?? []).filter((e) => !own.some((o) => o.id === e.package.manifest.id));
    return [...own, ...idle.map((e) => row(e, e.enabled))];
  }
}
