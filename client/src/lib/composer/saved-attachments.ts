import type { Attachment } from "../images";
import { uploadFileToDraft, type FileDraft } from "../files";

/**
 * Pictures and files attached to the composer's unsent message, kept on this device so they survive a restart. They are
 * too big for localStorage (megabytes of base64), so they live in IndexedDB, per session ("" = new chat) like the text
 * in saved-drafts.ts. Previews are not stored: they are rebuilt from the data (a data: URL for a picture, a blob: URL for
 * a file's thumbnail).
 */
export interface StoredAttachments {
	images: { id: string; name: string; data: string; mimeType: string }[];
	files: { id: string; name: string; data: string; size: number; mimeType: string }[];
	/** Last change, ms since epoch: old entries are dropped. */
	at: number;
}

/** Where the entries are kept: IndexedDB in the app, a Map in tests. */
export interface AttachmentStore {
	get(key: string): Promise<unknown>;
	put(key: string, value: StoredAttachments): Promise<void>;
	delete(key: string): Promise<void>;
	entries(): Promise<[string, unknown][]>;
}

/** Same limits as the text drafts. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 50;

/** A short fingerprint of what is attached: saving is skipped while it does not change. */
export const attachmentsSignature = (images: readonly { id: string }[], files: readonly { id: string }[]): string =>
	[...images.map((x) => x.id), "|", ...files.map((x) => x.id)].join(",");

export function toStored(images: readonly Attachment[], files: readonly FileDraft[], at: number): StoredAttachments {
	return {
		images: images.map(({ id, name, data, mimeType }) => ({ id, name, data, mimeType })),
		files: files.map(({ id, name, data, size, mimeType }) => ({ id, name, data, size, mimeType })),
		at,
	};
}

const isStored = (v: unknown): v is StoredAttachments => {
	if (!v || typeof v !== "object") return false;
	const s = v as Partial<StoredAttachments>;
	const ok = (x: unknown) => !!x && typeof x === "object" && typeof (x as { data?: unknown }).data === "string" && typeof (x as { mimeType?: unknown }).mimeType === "string";
	return typeof s.at === "number" && Array.isArray(s.images) && Array.isArray(s.files) && s.images.every(ok) && s.files.every(ok);
};

/** Back to what the composer holds, previews rebuilt. Null for a broken or empty entry. */
export function fromStored(v: unknown): { images: Attachment[]; files: FileDraft[] } | null {
	if (!isStored(v) || (!v.images.length && !v.files.length)) return null;
	return {
		images: v.images.map((x) => ({ ...x, preview: `data:${x.mimeType};base64,${x.data}` })),
		files: v.files.map((f) => uploadFileToDraft(f, f.id)),
	};
}

/** The keys to delete: broken, stale, and all but the most recent `MAX_ENTRIES`. */
export function staleKeys(entries: [string, unknown][], now: number): string[] {
	const good = entries.filter((e): e is [string, StoredAttachments] => isStored(e[1]) && now - e[1].at < MAX_AGE_MS).sort((a, b) => b[1].at - a[1].at);
	const keep = new Set(good.slice(0, MAX_ENTRIES).map(([k]) => k));
	return entries.map(([k]) => k).filter((k) => !keep.has(k));
}

/* ---------- IndexedDB ---------- */

const DB_NAME = "pipaya_composer_drafts";
const STORE = "attachments";

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") return Promise.resolve(null);
	return (dbPromise ??= new Promise((resolve) => {
		try {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	}));
}

/** One request in its own transaction; resolves with its result, or the fallback when storage is unavailable or fails. */
async function run<T>(mode: IDBTransactionMode, fallback: T, make: (s: IDBObjectStore) => IDBRequest): Promise<T> {
	const d = await db();
	if (!d) return fallback;
	return new Promise((resolve) => {
		try {
			const req = make(d.transaction(STORE, mode).objectStore(STORE));
			req.onsuccess = () => resolve((req.result as T) ?? fallback);
			req.onerror = () => resolve(fallback);
		} catch {
			resolve(fallback);
		}
	});
}

const idb: AttachmentStore = {
	get: (key) => run<unknown>("readonly", null, (s) => s.get(key)),
	put: (key, value) => run<void>("readwrite", undefined, (s) => s.put(value, key)),
	delete: (key) => run<void>("readwrite", undefined, (s) => s.delete(key)),
	entries: async () => {
		const keys = await run<IDBValidKey[]>("readonly", [], (s) => s.getAllKeys());
		const values = await run<unknown[]>("readonly", [], (s) => s.getAll());
		return keys.length === values.length ? keys.map((k, i) => [String(k), values[i]] as [string, unknown]) : [];
	},
};

let store: AttachmentStore = idb;
let pruned: Promise<void> | null = null;

/** Tests only: use another store. */
export function useAttachmentStore(s: AttachmentStore): void {
	store = s;
	pruned = null;
}

/** Old entries go once per app start, before the first read. */
function prune(): Promise<void> {
	return (pruned ??= store
		.entries()
		.then((all) => Promise.all(staleKeys(all, Date.now()).map((k) => store.delete(k))))
		.then(
			() => undefined,
			() => undefined,
		));
}

export async function loadAttachments(key: string): Promise<{ images: Attachment[]; files: FileDraft[] } | null> {
	await prune();
	try {
		return fromStored(await store.get(key));
	} catch {
		return null;
	}
}

/** Save what is attached under `key`; nothing attached deletes the entry. */
export async function saveAttachments(key: string, images: readonly Attachment[], files: readonly FileDraft[]): Promise<void> {
	try {
		if (!images.length && !files.length) await store.delete(key);
		else await store.put(key, toStored(images, files, Date.now()));
	} catch {
		/* storage full or unavailable: the attachments just do not survive a restart */
	}
}

export function forgetAttachments(key: string): void {
	void store.delete(key).catch(() => undefined);
}
