import { describe, expect, test } from "bun:test";
import { fetchLocalePacks } from "../src/lib/locale-sync";

const pack = (tag: string, updatedAt: number) => ({ tag, name: tag, messages: {}, updatedAt });

describe("fetchLocalePacks", () => {
	test("downloads only the packs that changed, keeps the held copy of the rest", async () => {
		const asked: string[] = [];
		const api = {
			locales: async () => [{ tag: "ja", updatedAt: 1 }, { tag: "fr", updatedAt: 5 }],
			locale: async (tag: string) => (asked.push(tag), pack(tag, 5)),
		};
		const held = { versions: () => ({ ja: 1, fr: 4 }), pack: (tag: string) => pack(tag, tag === "ja" ? 1 : 4) };
		const out = await fetchLocalePacks(api, held);
		expect(asked).toEqual(["fr"]);
		expect(out).toEqual([pack("ja", 1), pack("fr", 5)]);
	});
	test("a failed download keeps the held copy, or drops a pack never held", async () => {
		const api = {
			locales: async () => [{ tag: "ja", updatedAt: 2 }, { tag: "ko-x", updatedAt: 1 }],
			locale: async () => { throw new Error("down"); },
		};
		const held = { versions: () => ({ ja: 1 }), pack: (tag: string) => (tag === "ja" ? pack("ja", 1) : undefined) };
		expect(await fetchLocalePacks(api, held)).toEqual([pack("ja", 1)]);
	});
	test("an unreadable list throws, so the caller keeps its cache", async () => {
		const api = { locales: async () => { throw new Error("offline"); }, locale: async () => undefined };
		await expect(fetchLocalePacks(api, { versions: () => ({}), pack: () => undefined })).rejects.toThrow("offline");
	});
});
