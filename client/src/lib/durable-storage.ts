/**
 * Durable browser storage backed by IndexedDB.
 *
 * LocalStorage can be cleared by WebView profile directory changes, updates, or disk cleanup.
 * IndexedDB provides an independent, durable key-value store for all `pipaya.*` settings so
 * servers, connections, themes, shortcuts, and preferences survive any update or LocalStorage wipe.
 */

const DB_NAME = "pipaya_durable_settings";
const DB_VERSION = 1;
const STORE_NAME = "settings";

function openDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") return Promise.resolve(null);
	return new Promise((resolve) => {
		try {
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

/** Save a key-value setting to durable IndexedDB storage. */
export async function setDurableSetting(key: string, value: string): Promise<void> {
	const db = await openDb();
	if (!db) return;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, "readwrite");
			const store = tx.objectStore(STORE_NAME);
			store.put(value, key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		} catch {
			resolve();
		}
	});
}

/** Remove a key from durable IndexedDB storage. */
export async function removeDurableSetting(key: string): Promise<void> {
	const db = await openDb();
	if (!db) return;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, "readwrite");
			const store = tx.objectStore(STORE_NAME);
			store.delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		} catch {
			resolve();
		}
	});
}

/** Read all durable settings from IndexedDB. */
export async function getAllDurableSettings(): Promise<Record<string, string>> {
	const db = await openDb();
	if (!db) return {};
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, "readonly");
			const store = tx.objectStore(STORE_NAME);
			const out: Record<string, string> = {};
			const req = store.openCursor();
			req.onsuccess = () => {
				const cursor = req.result;
				if (cursor) {
					if (typeof cursor.key === "string" && typeof cursor.value === "string") {
						out[cursor.key] = cursor.value;
					}
					cursor.continue();
				} else {
					resolve(out);
				}
			};
			req.onerror = () => resolve({});
		} catch {
			resolve({});
		}
	});
}

/**
 * Sync all current localStorage `pipaya.*` settings into durable IndexedDB.
 */
export async function snapshotSettingsToDurable(): Promise<void> {
	if (typeof localStorage === "undefined") return;
	const db = await openDb();
	if (!db) return;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, "readwrite");
			const store = tx.objectStore(STORE_NAME);
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i);
				if (k && k.startsWith("pipaya.")) {
					const val = localStorage.getItem(k);
					if (val !== null) store.put(val, k);
				}
			}
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		} catch {
			resolve();
		}
	});
}

/**
 * Rehydrate missing localStorage keys from durable IndexedDB storage.
 * Returns true if any keys were restored.
 */
export async function rehydrateSettingsFromDurable(): Promise<boolean> {
	if (typeof localStorage === "undefined") return false;
	const durable = await getAllDurableSettings();
	const keys = Object.keys(durable);
	if (!keys.length) return false;

	// Only restore if localStorage is missing essential keys (e.g. servers)
	const currentServers = localStorage.getItem("pipaya.servers");
	const hasServers = currentServers && currentServers !== "[]";
	if (hasServers) {
		// localStorage is healthy; sync any newer keys into durable storage
		void snapshotSettingsToDurable();
		return false;
	}

	// LocalStorage lost its servers! Rehydrate from durable storage.
	let restored = false;
	for (const [k, v] of Object.entries(durable)) {
		if (k.startsWith("pipaya.")) {
			try {
				localStorage.setItem(k, v);
				restored = true;
			} catch {
				/* ignore */
			}
		}
	}
	return restored;
}
