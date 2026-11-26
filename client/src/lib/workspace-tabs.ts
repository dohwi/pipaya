import { removeDurableSetting, setDurableSetting } from "./durable-storage";

export const WORKSPACE_TABS_KEY = "pipaya.workspace.tabs";
export const MAX_STORED_WORKSPACE_DIRS = 50;

function readMap(): Record<string, string[]> {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(WORKSPACE_TABS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string[]>) : {};
	} catch {
		return {};
	}
}

function writeMap(map: Record<string, string[]>): void {
	if (typeof localStorage === "undefined") return;
	try {
		if (Object.keys(map).length > 0) {
			const json = JSON.stringify(map);
			localStorage.setItem(WORKSPACE_TABS_KEY, json);
			void setDurableSetting(WORKSPACE_TABS_KEY, json);
		} else {
			localStorage.removeItem(WORKSPACE_TABS_KEY);
			void removeDurableSetting(WORKSPACE_TABS_KEY);
		}
	} catch { /* ignore storage errors */ }
}

export function readStoredWorkspaceTabs(key: string): string[] {
	if (!key) return [];
	const list = readMap()[key];
	return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/** Save open file tabs for `key`, refreshing MRU order and capping stored directories to `MAX_STORED_WORKSPACE_DIRS`. */
export function writeStoredWorkspaceTabs(key: string, openFiles: readonly string[]): void {
	if (!key) return;
	const map = readMap();
	delete map[key];
	if (openFiles.length > 0) map[key] = [...openFiles];
	const keys = Object.keys(map);
	if (keys.length > MAX_STORED_WORKSPACE_DIRS) {
		for (const oldKey of keys.slice(0, keys.length - MAX_STORED_WORKSPACE_DIRS)) delete map[oldKey];
	}
	writeMap(map);
}

/** Drop saved workspace open-file tabs for a removed server's baseUrl. */
export function forgetServerWorkspaceTabs(baseUrl: string): void {
	if (!baseUrl) return;
	const map = readMap();
	const prefix = `${baseUrl}\0`;
	let changed = false;
	for (const key of Object.keys(map)) {
		if (key.startsWith(prefix)) {
			delete map[key];
			changed = true;
		}
	}
	if (changed) writeMap(map);
}
