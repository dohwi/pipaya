import type { Api } from "./api";
import { compareVersions, fetchCatalog, DEFAULT_MARKETPLACE_URL, type MarketCatalog } from "./extensions/marketplace";
import { extensions } from "./extensions/host.svelte";

const RECHECK_MS = 30 * 60 * 1000;

/**
 * Which installed extensions have a newer marketplace version. Read quietly in the background so the sidebar and the
 * settings window can point at "서버 확장" / "확장" without the extension pane being open.
 */
class ExtensionUpdates {
	private catalog = $state<MarketCatalog | null>(null);
	/** Each saved server's extensions, by server id; a server that did not answer is absent. */
	private servers = $state<Record<string, { name: string; version?: string }[]>>({});
	private checkedAt = 0;

	/** Names of one server's extensions with a newer git entry in the catalog. */
	serverNames = (serverId: string | null | undefined): Set<string> => {
		const out = new Set<string>();
		for (const e of (serverId && this.servers[serverId]) || []) {
			const m = this.catalog?.extensions.find((x) => x.id === e.name && x.kind === "server");
			if (m && e.version && m.source.type === "git" && compareVersions(m.version, e.version) > 0) out.add(e.name);
		}
		return out;
	};
	/** Display name of a client extension from the catalog, so an id is never shown where a name exists. */
	clientName = (id: string): string | undefined => this.catalog?.extensions.find((x) => x.id === id && x.kind === "client")?.name;
	/** The marketplace server extension that carries this client extension as its client half, when that server lacks it. */
	missingServerFor = (clientId: string, serverId: string | null | undefined): { id: string; name: string } | undefined => {
		const have = serverId ? this.servers[serverId] : undefined;
		if (!have) return undefined;
		const m = this.catalog?.extensions.find((x) => x.kind === "server" && x.companion === clientId);
		if (!m || have.some((s) => s.name === m.id)) return undefined;
		return { id: m.id, name: m.name };
	};
	/** Ids, among `have`, of client extensions with a newer catalog entry. */
	newerClients = (have: readonly { id: string; version: string }[]): Set<string> => {
		const out = new Set<string>();
		for (const e of have) {
			const m = this.catalog?.extensions.find((x) => x.id === e.id && x.kind === "client");
			if (m && compareVersions(m.version, e.version) > 0) out.add(e.id);
		}
		return out;
	};
	/** Ids of this device's client extensions with a newer entry. */
	clientIds = (scope: "device" | "server", serverId?: string | null): Set<string> => {
		if (scope === "device") return this.newerClients(extensions.installed.filter((e) => e.scope === "device").map((e) => ({ id: e.package.manifest.id, version: e.package.manifest.version })));
		return this.newerClients(this.clientsOf(serverId).filter((e) => e.scope === "server"));
	};
	/** The client extensions of a server, set by whoever owns the stores (the app store): the open server's host, or an idle editor. */
	clientsOf: (serverId: string | null | undefined) => readonly { id: string; version: string; scope: "server" | "device" }[] = () => [];
	serverCount(serverId: string | null | undefined): number {
		return this.serverNames(serverId).size + this.clientIds("server", serverId).size;
	}
	get deviceCount(): number {
		return this.clientIds("device").size;
	}
	/** Anything to update on this device or on any saved server. */
	get any(): boolean {
		return this.deviceCount > 0 || Object.keys(this.servers).some((id) => this.serverCount(id) > 0);
	}

	/** Reads every saved server's extensions each time (`apis`: server id to its connection); the catalog at most every 30 minutes. */
	async refresh(apis: Record<string, Api | null | undefined>, force = false): Promise<void> {
		const next: Record<string, { name: string; version?: string }[]> = {};
		await Promise.all(Object.entries(apis).map(async ([id, api]) => {
			if (!api) return;
			try { next[id] = (await api.serverExtensions()).extensions.map((e) => ({ name: e.name, version: e.version })); } catch { /* unreachable: nothing known */ }
		}));
		this.servers = next;
		if (!force && this.catalog && Date.now() - this.checkedAt < RECHECK_MS) return;
		try {
			this.catalog = await fetchCatalog(DEFAULT_MARKETPLACE_URL);
			this.checkedAt = Date.now();
		} catch { /* offline: no update hints */ }
	}
}

export const extensionUpdates = new ExtensionUpdates();
