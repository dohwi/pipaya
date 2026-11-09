import { CONFIG_REQUIRED, type ExtensionHost, type InstalledExtension } from "./host.svelte";
import { LocalizedError, t } from "../i18n";
import type { ServerExtensionStore, StoredExtension } from "./server-store";
import type { ExtensionPackage } from "./schema";

/**
 * Where the extension pane reads and writes: the extension host (the open server's extensions, which run here) or the
 * idle editor of another saved server's list (nothing runs; the choices wait for that server to open). One shape for
 * both, so the pane never has to ask which one it is talking to.
 */
export interface ExtensionRow {
	package: ExtensionPackage;
	enabled: boolean;
	/** "disabled" for a server that is not open: its extensions are not running here */
	state: InstalledExtension["state"];
	error?: string;
	settings: Record<string, unknown>;
	configured: boolean;
}

export interface ExtensionSource {
	/** True for the open server: its extensions run here */
	readonly runs: boolean;
	list(): ExtensionRow[];
	unreadable(): { raw: unknown; id?: string; name?: string; reason: string; index: number }[];
	find(id: string): ExtensionRow | undefined;
	configRequired(id: string): boolean;
	settingsProblem(id: string): string;
	enable(id: string): Promise<void>;
	disable(id: string): void;
	install(pkg: ExtensionPackage): string;
	remove(id: string, opts: { keepSettings: boolean }): void | Promise<void>;
	removeUnreadable(index: number, opts: { keepSettings: boolean }): void | Promise<void>;
	setSettings(id: string, settings: Record<string, unknown>): Promise<void>;
	/** True when this extension's settings stay on this device (its manifest says so, or the user switched it) */
	isSettingsLocal(id: string): boolean;
	/** Keep this extension's settings here, or put them back on the server */
	setSettingsLocal(id: string, local: boolean): void;
	canResume(pkg: ExtensionPackage): boolean;
	/** Failed to read the stored list */
	loadError(): string;
}

/** The host itself: every method is the host's own (the pane used to call it directly). */
export function hostSource(host: ExtensionHost): ExtensionSource {
	return {
		runs: true,
		list: () => host.installed,
		unreadable: () => host.unreadable.map((u, index) => ({ ...u, index })),
		find: (id) => host.installed.find((e) => e.package.manifest.id === id),
		configRequired: (id) => host.configRequired(id),
		settingsProblem: (id) => host.settingsProblem(id),
		enable: (id) => host.enable(id),
		disable: (id) => host.disable(id),
		install: (pkg) => host.install(pkg),
		remove: (id, opts) => host.remove(id, opts),
		removeUnreadable: (index, opts) => host.removeUnreadable(index, opts),
		setSettings: (id, settings) => host.setSettings(id, settings),
		isSettingsLocal: (id) => host.isSettingsLocal(id),
		setSettingsLocal: (id, local) => host.setSettingsLocal(id, local),
		canResume: (pkg) => host.canResume(pkg),
		loadError: () => host.loadError,
	};
}

/**
 * A server that is not open. Its extensions are never running here (`state` stays "disabled"), "on" only records the
 * choice for the next time that server is opened.
 */
export function storeSource(store: ServerExtensionStore): ExtensionSource {
	const row = (e: StoredExtension): ExtensionRow => ({ package: e.package, enabled: e.enabled, state: "disabled", settings: e.settings, configured: e.configured });
	return {
		runs: false,
		list: () => store.installed.map(row),
		unreadable: () => store.unreadable.map((u, index) => ({ ...u, index })),
		find: (id) => { const e = store.installed.find((x) => x.package.manifest.id === id); return e ? row(e) : undefined; },
		configRequired: (id) => store.configRequired(id),
		settingsProblem: (id) => store.settingsProblem(id),
		enable: async (id) => {
			if (store.configRequired(id)) throw new LocalizedError(t(CONFIG_REQUIRED));
			const problem = store.settingsProblem(id);
			if (problem) throw new Error(problem);
			store.setEnabled(id, true);
		},
		disable: (id) => store.setEnabled(id, false),
		install: (pkg) => store.install(pkg),
		remove: (id, opts) => store.remove(id, opts),
		removeUnreadable: (index, opts) => store.removeUnreadable(index, opts),
		setSettings: (id, settings) => store.setSettings(id, settings),
		isSettingsLocal: (id) => store.isSettingsLocal(id),
		setSettingsLocal: (id, local) => store.setSettingsLocal(id, local),
		canResume: () => false,
		loadError: () => store.loadError,
	};
}
