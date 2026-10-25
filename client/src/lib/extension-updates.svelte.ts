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
	private server = $state<{ name: string; version?: string }[]>([]);
	private checkedAt = 0;
	/** The open server answered, so "this server lacks X" is a fact and not just a missing connection. */
	private serverKnown = $state(false);

	/** Ids of server extensions (by name) with a newer git entry in the catalog. */
	serverNames = $derived.by(() => {
		const out = new Set<string>();
		for (const e of this.server) {
			const m = this.catalog?.extensions.find((x) => x.id === e.name && x.kind === "server");
			if (m && e.version && m.source.type === "git" && compareVersions(m.version, e.version) > 0) out.add(e.name);
		}
		return out;
	});
	/** The marketplace server extension that carries this client extension as its client half, when the open server lacks it. */
	missingServerFor = (clientId: string): { id: string; name: string } | undefined => {
		if (!this.serverKnown) return undefined;
		const m = this.catalog?.extensions.find((x) => x.kind === "server" && x.companion === clientId);
		if (!m || this.server.some((s) => s.name === m.id)) return undefined;
		return { id: m.id, name: m.name };
	};
	/** Ids of installed client extensions with a newer entry, per scope. */
	clientIds = (scope: "device" | "server"): Set<string> => {
		const out = new Set<string>();
		for (const e of extensions.installed) {
			if (e.scope !== scope) continue;
			const m = this.catalog?.extensions.find((x) => x.id === e.package.manifest.id && x.kind === "client");
			if (m && compareVersions(m.version, e.package.manifest.version) > 0) out.add(e.package.manifest.id);
		}
		return out;
	};
	get serverCount(): number {
		return this.serverNames.size + this.clientIds("server").size;
	}
	get deviceCount(): number {
		return this.clientIds("device").size;
	}
	get any(): boolean {
		return this.serverCount + this.deviceCount > 0;
	}

	/** Reads the open server's extensions each time; the catalog at most every 30 minutes. */
	async refresh(api: Api | null, force = false): Promise<void> {
		if (api) {
			try { this.server = (await api.serverExtensions()).extensions.map((e) => ({ name: e.name, version: e.version })); this.serverKnown = true; } catch { this.server = []; this.serverKnown = false; }
		} else { this.server = []; this.serverKnown = false; }
		if (!force && this.catalog && Date.now() - this.checkedAt < RECHECK_MS) return;
		try {
			this.catalog = await fetchCatalog(DEFAULT_MARKETPLACE_URL);
			this.checkedAt = Date.now();
		} catch { /* offline: no update hints */ }
	}
}

export const extensionUpdates = new ExtensionUpdates();
