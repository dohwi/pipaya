import type { Database } from "bun:sqlite";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** pi-ai CredentialStore backed by SQLite so API keys survive restarts. */
export class SqliteCredentialStore implements CredentialStore {
	private chains = new Map<string, Promise<unknown>>();

	constructor(private db: Database) {}

	/** Serialises work per provider; the entry leaves the map once nothing newer is queued behind it. */
	private enqueue<T>(providerId: string, work: () => Promise<T>): Promise<T> {
		const next = (this.chains.get(providerId) ?? Promise.resolve()).catch(() => {}).then(work);
		this.chains.set(providerId, next);
		void next.then(() => {}, () => {}).then(() => {
			if (this.chains.get(providerId) === next) this.chains.delete(providerId);
		});
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const row = this.db.query("SELECT data FROM credentials WHERE provider_id = $id").get({ id: providerId }) as {
			data: string;
		} | null;
		return row ? (JSON.parse(row.data) as Credential) : undefined;
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const rows = this.db.query("SELECT provider_id, data FROM credentials").all() as { provider_id: string; data: string }[];
		return rows.map((r) => ({ providerId: r.provider_id, type: (JSON.parse(r.data) as Credential).type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.enqueue(providerId, async () => {
			const updated = await fn(await this.read(providerId));
			if (updated) {
				this.db
					.query("INSERT INTO credentials (provider_id, data) VALUES ($id, $data) ON CONFLICT(provider_id) DO UPDATE SET data = $data")
					.run({ id: providerId, data: JSON.stringify(updated) });
				return updated;
			}
			return this.read(providerId);
		});
	}

	async delete(providerId: string): Promise<void> {
		return this.deleteWithCleanup(providerId);
	}

	/** Optional synchronous cleanup participates in the same SQLite transaction as key deletion. */
	async deleteWithCleanup(providerId: string, cleanup?: () => void): Promise<void> {
		await this.enqueue(providerId, async () => {
			this.db.transaction(() => {
				cleanup?.();
				this.db.query("DELETE FROM credentials WHERE provider_id = $id").run({ id: providerId });
			})();
		});
	}
}
