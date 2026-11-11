import { untrack, type Component } from "svelte";
import type { Api } from "../api";
import { errorText } from "../api";
import { extensions } from "./host.svelte";
import { ownUiFingerprint, ownUiKey, ownUiPackage, OWN_PAGE_PART, readOwnUiConsent, writeOwnUiConsent, type ConsentStorage, type OwnUiSources } from "./own-ui";
import type { ExtensionPackage } from "./schema";

/** What a server extension's own page draws with, once agreed to and loaded. */
export interface OwnUi {
	/** Components for the slot `extension.page.top`, in order */
	mounts: { key: string; component: Component<any> }[];
	/** The component that replaces the settings section (`extension.settings`), if any */
	settings?: Component<any>;
	/** Every component by name, for a settings field's `component` */
	components: Record<string, Component<any>>;
}

export type OwnUiState =
	| { status: "off" }
	/** Not asked yet, or the server's code changed since the user agreed: needs the user's yes. `names` are what would run */
	| { status: "ask" | "changed"; names: string[] }
	| { status: "ready"; ui: OwnUi }
	| { status: "error"; message: string };

type Loader = () => Promise<{ load(pkg: ExtensionPackage, settings: () => Record<string, unknown>): Record<string, Component<any>> }>;

/** The compiler is large: loaded on first use, with the kit, like the components of a client extension. */
const defaultLoader: Loader = async () => {
	const [{ loadComponents }, { kit }] = await Promise.all([import("./components"), import("./kit")]);
	return { load: (pkg, settings) => loadComponents(pkg, kit(pkg.manifest.id, () => null, settings, pkg.assets ?? {})) };
};

/**
 * The Svelte pages of server extensions, per (server, extension): the agreement of this device, the sources fetched from
 * that server, and the compiled components. Independent of the open server: a page shown for any saved server works with
 * that server's connection.
 */
export class OwnPageUis {
	private states = $state.raw<Record<string, OwnUiState>>({});
	private consent: Record<string, string>;
	/** The settings the components read as `ext.settings`, by key: kept current by the page showing them */
	private settings = $state.raw<Record<string, Record<string, unknown>>>({});
	/** Fetched sources by key, so agreeing does not fetch again */
	private seen = new Map<string, { sources: OwnUiSources; fp: string }>();
	private runs = new Map<string, number>();

	constructor(private readonly env: { storage: ConsentStorage; safeMode: () => boolean; loader?: Loader } = {
		// Without a browser there is nowhere to keep an agreement, so nothing is ever agreed to.
		storage: typeof localStorage === "undefined" ? { getItem: () => null, setItem: () => {} } : localStorage,
		safeMode: () => extensions.safeMode,
	}) {
		this.consent = readOwnUiConsent(env.storage);
	}

	stateOf(serverId: string, name: string): OwnUiState {
		return this.states[ownUiKey(serverId, name)] ?? { status: "off" };
	}

	/** The page shows these settings to its components (`ext.settings`). */
	setSettings(serverId: string, name: string, value: Record<string, unknown>): void {
		// Called from an effect of the page: reading what it then writes must not make the effect depend on it.
		this.settings = { ...untrack(() => this.settings), [ownUiKey(serverId, name)]: value };
	}

	private put(key: string, state: OwnUiState) {
		this.states = { ...untrack(() => this.states), [key]: state };
	}

	/**
	 * Called when a page with `pipaya.components` is shown. Runs the code only when this device agreed to exactly these
	 * sources; otherwise it says what is waiting for the user's yes. Never runs in safe mode.
	 */
	async ensure(serverId: string, api: Api, name: string, id: string): Promise<void> {
		const key = ownUiKey(serverId, name);
		if (this.env.safeMode()) { this.put(key, { status: "off" }); return; }
		const run = (this.runs.get(key) ?? 0) + 1;
		this.runs.set(key, run);
		try {
			const sources = await api.serverExtensionUi(name);
			if (this.runs.get(key) !== run) return;
			const fp = ownUiFingerprint(sources);
			this.seen.set(key, { sources, fp });
			const names = Object.keys(sources.components ?? {});
			if (!Object.hasOwn(this.consent, key)) { this.put(key, { status: "ask", names }); return; }
			if (this.consent[key] !== fp) { this.put(key, { status: "changed", names }); return; }
			await this.start(key, id, name, sources, run);
		} catch (cause) {
			if (this.runs.get(key) === run) this.put(key, { status: "error", message: errorText(cause) });
		}
	}

	/** The user said yes to what `ensure` last fetched for this page. */
	async allow(serverId: string, name: string, id: string): Promise<void> {
		const key = ownUiKey(serverId, name);
		const seen = this.seen.get(key);
		if (!seen || this.env.safeMode()) return;
		this.consent = { ...this.consent, [key]: seen.fp };
		writeOwnUiConsent(this.env.storage, this.consent);
		const run = (this.runs.get(key) ?? 0) + 1;
		this.runs.set(key, run);
		await this.start(key, id, name, seen.sources, run);
	}

	/** The user took it back: the code stops and the agreement is forgotten. */
	revoke(serverId: string, name: string): void {
		const key = ownUiKey(serverId, name);
		const { [key]: _gone, ...rest } = this.consent;
		this.consent = rest;
		writeOwnUiConsent(this.env.storage, this.consent);
		this.runs.set(key, (this.runs.get(key) ?? 0) + 1);
		const seen = this.seen.get(key);
		this.put(key, seen ? { status: "ask", names: Object.keys(seen.sources.components) } : { status: "off" });
	}

	private async start(key: string, id: string, name: string, sources: OwnUiSources, run: number): Promise<void> {
		try {
			const pkg = ownUiPackage(id, name, sources);
			const { load } = await (this.env.loader ?? defaultLoader)();
			if (this.runs.get(key) !== run) return;
			const components = load(pkg, () => this.settings[key] ?? {});
			const mounts = (pkg.mounts ?? []).map((m, i) => ({ key: `${key}:${i}`, order: m.order ?? 0, component: components[m.component]! })).sort((a, b) => a.order - b.order).map(({ key: k, component }) => ({ key: k, component }));
			const wanted = pkg.replaces?.[OWN_PAGE_PART];
			this.put(key, { status: "ready", ui: { mounts, ...(wanted ? { settings: components[wanted] } : {}), components } });
		} catch (cause) {
			if (this.runs.get(key) === run) this.put(key, { status: "error", message: cause instanceof Error ? cause.message.slice(0, 300) : String(cause) });
		}
	}
}

export const ownPageUis = new OwnPageUis();
