import { CONFIG_REQUIRED, type ExtensionHost, type InstalledExtension } from "./host.svelte";
import { LocalizedError, t } from "../i18n";
import type { ServerExtensionStore, StoredExtension } from "./server-store";
import type { ExtensionPackage } from "./schema";

/**
 * Where the extension pane reads and writes: the extension host (this device's extensions, and the open server's, which
 * run here) or the idle editor of another saved server's list (nothing runs; the choices wait for that server to open).
 * One shape for both, so the pane never has to ask which one it is talking to.
 */
export interface ExtensionRow {
	package: ExtensionPackage;
	scope: "server" | "device";
	enabled: boolean;
	/** "disabled" for a server that is not open: its extensions are not running here */
	state: InstalledExtension["state"];
	error?: string;
	settings: Record<string, unknown>;
	configured: boolean;
}

export interface ExtensionSource {
	/** True for the open server and the device: the extensions run here */
	readonly runs: boolean;
	list(scope: "server" | "device"): ExtensionRow[];
	unreadable(scope: "server" | "device"): { raw: unknown; id?: string; name?: string; reason: string; index: number }[];
	find(id: string): ExtensionRow | undefined;
	configRequired(id: string): boolean;
	settingsProblem(id: string): string;
	enable(id: string): Promise<void>;
	disable(id: string): void;
	install(pkg: ExtensionPackage, scope: "server" | "device"): string;
	remove(id: string, opts: { keepSettings: boolean }): void | Promise<void>;
	removeUnreadable(index: number, opts: { keepSettings: boolean }): void | Promise<void>;
	setSettings(id: string, settings: Record<string, unknown>): Promise<void>;
	canResume(pkg: ExtensionPackage): boolean;
	/** Failed to read the stored list */
	loadError(): string;
}

/** The host itself: every method is the host's own (the pane used to call it directly). */
export function hostSource(host: ExtensionHost): ExtensionSource {
	return {
		runs: true,
		list: (scope) => host.installed.filter((e) => e.scope === scope),
		unreadable: (scope) => host.unreadable.map((u, index) => ({ ...u, index })).filter((u) => (u.scope ?? "server") === scope),
		find: (id) => host.installed.find((e) => e.package.manifest.id === id),
		configRequired: (id) => host.configRequired(id),
		settingsProblem: (id) => host.settingsProblem(id),
		enable: (id) => host.enable(id),
		disable: (id) => host.disable(id),
		install: (pkg, scope) => host.install(pkg, scope),
		remove: (id, opts) => host.remove(id, opts),
		removeUnreadable: (index, opts) => host.removeUnreadable(index, opts),
		setSettings: (id, settings) => host.setSettings(id, settings),
		canResume: (pkg) => host.canResume(pkg),
		loadError: () => host.loadError,
	};
}

/**
 * A server that is not open. Its extensions are never running here (`state` stays "disabled"), "on" only records the
 * choice for the next time that server is opened. A device extension is never part of it: it lives in the host.
 */
export function storeSource(store: ServerExtensionStore, host: ExtensionHost): ExtensionSource {
	const row = (e: StoredExtension): ExtensionRow => ({ package: e.package, scope: "server", enabled: e.enabled, state: "disabled", settings: e.settings, configured: e.configured });
	/** Whose extension an id is: this server's idle list, else this device's (the client half of a pair lives in the host). */
	const mine = (id: string) => store.installed.some((e) => e.package.manifest.id === id);
	const deviceOnly = (u: { scope?: string }) => u.scope === "device";
	return {
		runs: false,
		list: (scope) => (scope === "server" ? store.installed.map(row) : host.installed.filter((e) => e.scope === "device")),
		unreadable: (scope) => (scope === "server" ? store.unreadable.map((u, index) => ({ ...u, index })) : host.unreadable.map((u, index) => ({ ...u, index })).filter(deviceOnly)),
		find: (id) => { const e = store.installed.find((x) => x.package.manifest.id === id); return e ? row(e) : host.installed.find((x) => x.scope === "device" && x.package.manifest.id === id); },
		configRequired: (id) => (mine(id) ? store.configRequired(id) : host.configRequired(id)),
		settingsProblem: (id) => (mine(id) ? store.settingsProblem(id) : host.settingsProblem(id)),
		enable: async (id) => {
			if (!mine(id)) return host.enable(id);
			if (store.configRequired(id)) throw new LocalizedError(t(CONFIG_REQUIRED));
			const problem = store.settingsProblem(id);
			if (problem) throw new Error(problem);
			store.setEnabled(id, true);
		},
		disable: (id) => (mine(id) ? store.setEnabled(id, false) : host.disable(id)),
		install: (pkg, scope) => (scope === "server" ? store.install(pkg) : host.install(pkg, "device")),
		remove: (id, opts) => (mine(id) ? store.remove(id, opts) : host.remove(id, opts)),
		removeUnreadable: (index, opts) => store.removeUnreadable(index, opts),
		setSettings: (id, settings) => (mine(id) ? store.setSettings(id, settings) : host.setSettings(id, settings)),
		canResume: (pkg) => (mine(pkg.manifest.id) ? false : host.canResume(pkg)),
		loadError: () => store.loadError,
	};
}
