import { beforeEach, describe, expect, test } from "bun:test";
import {
	attachmentsSignature,
	forgetAttachments,
	fromStored,
	loadAttachments,
	MAX_AGE_MS,
	MAX_ENTRIES,
	saveAttachments,
	staleKeys,
	toStored,
	useAttachmentStore,
	type StoredAttachments,
} from "../src/lib/composer/saved-attachments";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const image = { id: "i1", name: "dot.png", preview: `data:image/png;base64,${PNG}`, data: PNG, mimeType: "image/png" };
const file = { id: "f1", name: "note.txt", data: btoa("a note"), size: 6, mimeType: "text/plain", preview: undefined };
const picFile = { id: "f2", name: "photo.png", data: PNG, size: 70, mimeType: "image/png", preview: "blob:old" };

let mem: Map<string, unknown>;
beforeEach(() => {
	mem = new Map();
	useAttachmentStore({
		get: async (k) => mem.get(k) ?? null,
		put: async (k, v) => void mem.set(k, structuredClone(v)),
		delete: async (k) => void mem.delete(k),
		entries: async () => [...mem.entries()],
	});
});

describe("saved attachments", () => {
	test("round trip rebuilds previews and keeps the data", async () => {
		await saveAttachments("s1", [image], [file, picFile]);
		const back = await loadAttachments("s1");
		expect(back?.images).toEqual([image]);
		expect(back?.files.map((f) => [f.id, f.name, f.data, f.size, f.mimeType])).toEqual([
			["f1", "note.txt", file.data, 6, "text/plain"],
			["f2", "photo.png", PNG, 70, "image/png"],
		]);
		expect(back?.files[0]?.preview).toBeUndefined();
		expect(back?.files[1]?.preview).toStartWith("blob:");
		expect(back?.files[1]?.preview).not.toBe("blob:old"); // a stored blob URL would be dead after a restart
	});

	test("previews are not stored", async () => {
		await saveAttachments("s1", [image], [picFile]);
		const raw = mem.get("s1") as StoredAttachments;
		expect(JSON.stringify(raw)).not.toContain("preview");
	});

	test("nothing attached deletes the entry", async () => {
		await saveAttachments("s1", [image], []);
		await saveAttachments("s1", [], []);
		expect(mem.has("s1")).toBe(false);
		await saveAttachments("s2", [image], []);
		forgetAttachments("s2");
		await Promise.resolve();
		expect(mem.has("s2")).toBe(false);
		expect(await loadAttachments("missing")).toBeNull();
	});

	test("a failing store never throws", async () => {
		useAttachmentStore({
			get: async () => { throw new Error("x"); },
			put: async () => { throw new Error("quota"); },
			delete: async () => { throw new Error("x"); },
			entries: async () => { throw new Error("x"); },
		});
		await saveAttachments("s1", [image], []);
		expect(await loadAttachments("s1")).toBeNull();
		forgetAttachments("s1");
	});

	test("loading first drops stale entries", async () => {
		mem.set("old", { ...toStored([image], [], Date.now() - MAX_AGE_MS - 1) });
		mem.set("broken", { images: "x" });
		mem.set("fresh", toStored([image], [], Date.now()));
		expect(await loadAttachments("fresh")).not.toBeNull();
		expect([...mem.keys()]).toEqual(["fresh"]);
	});
});

describe("helpers", () => {
	test("fromStored refuses broken or empty entries", () => {
		expect(fromStored(null)).toBeNull();
		expect(fromStored({ images: [], files: [], at: 1 })).toBeNull();
		expect(fromStored({ images: [{ name: "x" }], files: [], at: 1 })).toBeNull();
		expect(fromStored({ images: [], files: [], at: "1" })).toBeNull();
	});

	test("staleKeys keeps only the most recent entries", () => {
		const now = 1_000_000_000_000;
		const entries = Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => [`s${i}`, toStored([image], [], now - i)] as [string, unknown]);
		const gone = staleKeys(entries, now);
		expect(gone).toEqual(["s50", "s51", "s52"]);
	});

	test("the signature follows the ids and their order", () => {
		expect(attachmentsSignature([image], [file])).toBe(attachmentsSignature([{ ...image }], [{ ...file }]));
		expect(attachmentsSignature([image], [])).not.toBe(attachmentsSignature([], [image]));
		expect(attachmentsSignature([], [file, picFile])).not.toBe(attachmentsSignature([], [picFile, file]));
	});
});
