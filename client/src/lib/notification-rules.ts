import type { Api } from "./api";
import type { NotificationRule } from "./notification-contract";
const KEY = "pipaya.notification.revocations";
/** Offline revocations survive restart. Serialized per server/owner so an old DELETE cannot erase a new registration. */
export class NotificationRules {
  private queues = new Map<string, Promise<unknown>>();
  private pending: { server: string; owner: string }[] = (() => {
    try { const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x): x is { server: string; owner: string } => !!x && typeof x.server === "string" && typeof x.owner === "string").slice(0, 500) : []; } catch { return []; }
  })();
  private save() { localStorage.setItem(KEY, JSON.stringify(this.pending)); }
  private serial<T>(api: Api, owner: string, task: () => Promise<T>): Promise<T> {
    const key = `${api.baseUrl}\0${owner}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(task);
    this.queues.set(key, job);
    void job.finally(() => { if (this.queues.get(key) === job) this.queues.delete(key); }).catch(() => {});
    return job;
  }
  revoke(api: Api, owner: string): Promise<void> {
    if (!this.pending.some(p => p.server === api.baseUrl && p.owner === owner)) this.pending.push({ server: api.baseUrl, owner });
    this.save();
    return this.serial(api, owner, async () => {
      await api.revokeNotificationRules(owner);
      this.pending = this.pending.filter(p => p.server !== api.baseUrl || p.owner !== owner); this.save();
    });
  }
  register(api: Api, owner: string, id: string, rule: NotificationRule): Promise<void> {
    return this.serial(api, owner, async () => {
      if (this.pending.some(p => p.server === api.baseUrl && p.owner === owner)) {
        await api.revokeNotificationRules(owner);
        this.pending = this.pending.filter(p => p.server !== api.baseUrl || p.owner !== owner); this.save();
      }
      await api.setNotificationRule(owner, id, rule);
    });
  }
  remove(api: Api, owner: string, id: string): Promise<void> { return this.serial(api, owner, async () => { await api.removeNotificationRule(owner, id); }); }
  retry(api: Api) { for (const p of [...this.pending]) if (p.server === api.baseUrl) void this.revoke(api, p.owner).catch(() => {}); }
}
export const notificationRules = new NotificationRules();
