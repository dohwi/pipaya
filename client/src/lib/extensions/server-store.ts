import { describeSettingErrors, parsePackage, resolveSettings, type ExtensionPackage } from "./schema";
import { canonical } from "./fingerprint";
import { SETTINGS_SOURCE } from "./configuration";
import { clone, identify, plain, within } from "./host-values";
import { LocalizedError, t } from "../i18n";
import type { ServerSettingsSync } from "../server-settings";
import type { Api } from "../api";

/** Same key the open server's list lives under (`ExtensionHost`), so both always read and write the one stored list. */
export const SERVER_LIST_KEY = "pipaya.extensions.v1";
const MAX_ENTRIES = 50;
const PUT_MS = 10000;
const FETCH_MS = 3000;

/** One client extension installed on a server, as this device keeps it (never run: running is the open server's host). */
export interface StoredExtension {
	package: ExtensionPackage;
	/** The user's choice: start it when this server is opened */
	enabled: boolean;
	settings: Record<string, unknown>;
	configured: boolean;
}
export interface StoredUnreadable { raw: unknown; id?: string; name?: string; reason: string }

/** The little bit of `Storage` the store uses; tests pass a Map-backed one. */
export interface ListStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface ServerStoreOptions {
	serverId: string;
	api: () => Api | null;
	storage: ListStorage;
	/** Called when the list or the on/off choices changed here, so the server (and its other devices) hear about it */
	changed: (key: "extensions" | "extensionStates") => void;
	/** Anything in the lists changed (by the user here, or by what the server sent): views read them again */
	updated?: () => void;
}

/**
 * The client extensions of ONE saved server, read and edited without that server being the open one. Nothing here runs:
 * code only runs in the open server's `ExtensionHost`, which takes over this same stored list when the server is opened.
 * Every request goes to this server's own connection, never the open one's.
 */
export class ServerExtensionStore {
	installed: StoredExtension[] = [];
	unreadable: StoredUnreadable[] = [];
	loadError = "";
	/** Settings per extension id as the server holds them */
	private remote: Record<string, unknown> = {};
	/** What the user chose per extension (true = on), shared with the server: only ids with a real choice are in it. */
	private wanted: Record<string, boolean> = {};
	/** The user keeps extension settings on this device only: nothing about them goes to the server. */
	private localSettings() { return this.o.storage.getItem(SETTINGS_SOURCE) === "local"; }

	constructor(private o: ServerStoreOptions) {
		this.load();
	}

	get serverId() { return this.o.serverId; }
	private get key() { return `${SERVER_LIST_KEY}.${this.o.serverId}`; }

	/** Read the stored list again (another store instance or the open host may have written it). */
	load() {
		this.installed = []; this.unreadable = []; this.loadError = "";
		const text = this.o.storage.getItem(this.key);
		let raw: unknown;
		try { raw = JSON.parse(text ?? "[]"); } catch (e) { this.loadError = e instanceof Error ? e.message : String(e); return; }
		if (!Array.isArray(raw) || raw.length > MAX_ENTRIES) { this.loadError = t("잘못된 확장 목록"); return; }
		for (const item of raw) {
			try {
				const entry = plain(item);
				if (!entry) throw new LocalizedError(t("객체가 필요합니다"));
				const pkg = parsePackage(entry.package);
				if (this.installed.some((e) => e.package.manifest.id === pkg.manifest.id)) throw new LocalizedError(t("중복 확장 ID"));
				this.installed.push({ package: pkg, enabled: entry.enabled === true, configured: entry.configured !== false, settings: plain(entry.settings) ?? {} });
			} catch (e) { this.unreadable.push({ raw: item, ...identify(item), reason: e instanceof Error ? e.message : String(e) }); }
		}
	}

	/** Write the list back; entries this version cannot read are written unchanged. */
	private save() {
		this.o.storage.setItem(this.key, JSON.stringify([
			...this.installed.map((e) => ({ package: e.package, enabled: e.enabled, settings: e.settings, configured: e.configured })),
			...this.unreadable.map((u) => u.raw),
		]));
		this.o.updated?.();
	}

	find(id: string): StoredExtension {
		const e = this.installed.find((x) => x.package.manifest.id === id);
		if (!e) throw new LocalizedError(t("확장을 찾을 수 없습니다"));
		return e;
	}

	/** The packages the server shares between its devices, in the same stable order the open host uses. */
	packages(): unknown[] | undefined {
		// like the open host: a server this device never kept a list for has nothing worth uploading
		if (this.o.storage.getItem(this.key) === null && !this.installed.length) return undefined;
		return this.installed.map((e) => clone(e.package)).sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1));
	}
	/** True while a package with a settings schema still waits for its first explicit save. */
	configRequired(id: string): boolean {
		const e = this.find(id);
		return !!e.package.manifest.settings && !e.configured;
	}
	/** Reason the extension cannot be switched on because of its settings schema, or "". */
	settingsProblem(id: string): string {
		const e = this.find(id);
		const fields = e.package.manifest.settings;
		if (!fields) return "";
		const { ok, errors } = resolveSettings(fields, e.settings);
		return ok ? "" : t("필수 설정을 확인하세요 — {detail}", { detail: describeSettingErrors(fields, errors) });
	}
	/** On/off choices (true = on), or undefined while none was ever made. */
	states(): Record<string, boolean> | undefined {
		const out: Record<string, boolean> = {};
		for (const e of this.installed) { const id = e.package.manifest.id; if (Object.hasOwn(this.wanted, id)) out[id] = this.wanted[id]!; }
		return Object.keys(out).length ? out : undefined;
	}
	private choose(id: string, on: boolean) {
		if (this.wanted[id] === on) return;
		this.wanted[id] = on;
		this.o.changed("extensionStates");
	}

	/** Add or replace a package. A replacement loses its on-switch: the new code needs the user's consent again. */
	install(input: unknown): string {
		const pkg = parsePackage(input);
		const id = pkg.manifest.id;
		const old = this.installed.find((e) => e.package.manifest.id === id);
		if (old) {
			const was = old.enabled;
			old.package = pkg; old.enabled = false;
			if (was) this.choose(id, false);
		} else {
			if (this.installed.length + this.unreadable.length >= MAX_ENTRIES) throw new LocalizedError(t("확장은 최대 50개까지 설치할 수 있습니다"));
			const remote = pkg.manifest.settingsScope !== "local" ? plain(this.remote[id]) : undefined;
			const fields = pkg.manifest.settings;
			this.installed.push({ package: pkg, enabled: false, configured: !fields || remote !== undefined, settings: remote ? clone(remote) : {} });
		}
		this.save();
		this.o.changed("extensions");
		return id;
	}

	/** Remember that the extension should start the next time this server is opened (or stay off). */
	setEnabled(id: string, on: boolean) {
		const e = this.find(id);
		e.enabled = on;
		this.save();
		this.choose(id, on);
	}

	/** Remove the package; `keepSettings` false also deletes its settings on THIS server. */
	async remove(id: string, opts: { keepSettings: boolean }) {
		this.find(id);
		this.installed = this.installed.filter((e) => e.package.manifest.id !== id);
		this.save();
		this.o.changed("extensions");
		if (Object.hasOwn(this.wanted, id)) { delete this.wanted[id]; this.o.changed("extensionStates"); }
		if (opts.keepSettings === false) await this.deleteRemote(id);
	}
	async removeUnreadable(index: number, opts: { keepSettings: boolean }) {
		const item = this.unreadable[index];
		if (!item) throw new LocalizedError(t("확장을 찾을 수 없습니다"));
		this.unreadable = this.unreadable.filter((_, i) => i !== index);
		this.save();
		this.o.changed("extensions");
		if (opts.keepSettings === false && item.id && !this.installed.some((e) => e.package.manifest.id === item.id)) await this.deleteRemote(item.id);
	}

	/**
	 * Send the settings to this server and keep them here once it took them. When the server cannot be reached nothing
	 * changes: a copy kept only here would later be replaced by the server's, and the user would lose it unnoticed.
	 */
	async setSettings(id: string, input: Record<string, unknown>) {
		const e = this.find(id);
		let next = clone(input);
		if (JSON.stringify(next).length > 16000) throw new LocalizedError(t("설정은 최대 16KB입니다"));
		const fields = e.package.manifest.settings;
		if (fields) {
			const { values, errors, ok } = resolveSettings(fields, next);
			if (!ok) throw new LocalizedError(t("설정이 올바르지 않습니다 — {detail}", { detail: describeSettingErrors(fields, errors) }));
			next = { ...values };
		}
		if (e.package.manifest.settingsScope !== "local" && !this.localSettings()) {
			const api = this.o.api();
			if (!api) throw new LocalizedError(t("서버에 연결되어 있지 않습니다."));
			await within(PUT_MS, (signal) => api.saveExtensionSettings(id, next, signal));
			this.remote[id] = clone(next);
		}
		e.settings = next; e.configured = true;
		this.save();
	}

	/** Read what the server holds for each extension's settings (after which a newly listed package starts from them). */
	async loadRemoteSettings() {
		const api = this.o.api();
		if (!api || this.localSettings()) return;
		try {
			const res = await within(FETCH_MS, (signal) => api.extensionSettings(signal));
			if (!res || typeof res.settings !== "object" || !res.settings || Array.isArray(res.settings)) return;
			this.remote = res.settings;
			let changed = false;
			for (const e of this.installed) {
				const value = plain(this.remote[e.package.manifest.id]);
				if (value && e.package.manifest.settingsScope !== "local") { e.settings = clone(value); e.configured = true; changed = true; }
			}
			if (changed) this.save();
		} catch { /* unreachable: the stored copy stays */ }
	}

	private async deleteRemote(id: string) {
		delete this.remote[id];
		const api = this.o.api();
		if (!api || this.localSettings()) return;
		await within(PUT_MS, (signal) => api.deleteExtension(id, signal)).catch(() => {});
	}

	/** Take the server's list: new packages arrive switched off, changed ones lose their on-switch, removed ones go. */
	applyPackages(value: unknown) {
		if (!Array.isArray(value) || value.length > MAX_ENTRIES) return;
		const wanted = new Map<string, ExtensionPackage>();
		for (const item of value) { try { const pkg = parsePackage(item); wanted.set(pkg.manifest.id, pkg); } catch { /* a package this version cannot read stays out */ } }
		for (const e of this.installed) if (!wanted.has(e.package.manifest.id)) delete this.wanted[e.package.manifest.id];
		this.installed = this.installed.filter((e) => wanted.has(e.package.manifest.id));
		for (const [id, pkg] of wanted) {
			const old = this.installed.find((e) => e.package.manifest.id === id);
			if (old && canonical(old.package) === canonical(pkg)) continue;
			if (old) { old.package = pkg; old.enabled = false; continue; }
			if (this.installed.length + this.unreadable.length >= MAX_ENTRIES) continue;
			this.installed.push({ package: pkg, enabled: false, configured: !pkg.manifest.settings, settings: {} });
		}
		this.save();
	}
	applyStates(value: unknown) {
		const states = plain(value);
		if (!states) return;
		this.wanted = {};
		for (const [id, on] of Object.entries(states)) if (typeof on === "boolean" && /^[a-z][a-z0-9.-]*$/.test(id)) this.wanted[id] = on;
		for (const e of this.installed) { const id = e.package.manifest.id; if (Object.hasOwn(this.wanted, id)) e.enabled = this.wanted[id]!; }
		this.save();
	}
}

/** The sync engine of a server that is not open, so a change here reaches that server and is not lost until it is opened. */
export type StoreSync = Pick<ServerSettingsSync, "changed" | "pull" | "flush" | "dispose" | "onEvent">;
