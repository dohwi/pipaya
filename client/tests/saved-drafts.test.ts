import { beforeEach, describe, expect, test } from "bun:test";
import { K } from "../src/lib/persist";
import { forgetDraft, loadDraft, MAX_AGE_MS, MAX_CHARS, MAX_DRAFTS, pruneDrafts, resetDraftCache, saveDraft } from "../src/lib/composer/saved-drafts";

const store = new Map<string, string>();
let writes = 0;

beforeEach(() => {
	store.clear();
	writes = 0;
	(globalThis as any).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => { writes++; store.set(k, v); },
		removeItem: (k: string) => void store.delete(k),
	};
	(globalThis as any).indexedDB = undefined;
	resetDraftCache();
});

describe("saved drafts", () => {
	test("survive a restart (a fresh cache reads storage)", () => {
		saveDraft("s1", "hello", { text: "quoted", who: "Claude" });
		saveDraft("", "new chat text", null);
		resetDraftCache();
		expect(loadDraft("s1")).toMatchObject({ text: "hello", reply: { text: "quoted", who: "Claude" } });
		expect(loadDraft("")?.text).toBe("new chat text");
		expect(loadDraft("other")).toBeNull();
	});

	test("an empty input forgets the draft", () => {
		saveDraft("s1", "hello", null);
		saveDraft("s1", "   ", null);
		resetDraftCache();
		expect(loadDraft("s1")).toBeNull();
		saveDraft("s2", "x", null);
		forgetDraft("s2");
		resetDraftCache();
		expect(loadDraft("s2")).toBeNull();
	});

	test("a reply alone is kept", () => {
		saveDraft("s1", "", { text: "quoted" });
		resetDraftCache();
		expect(loadDraft("s1")?.reply?.text).toBe("quoted");
	});

	test("unchanged input does not write again", () => {
		saveDraft("s1", "hello", null);
		const n = writes;
		saveDraft("s1", "hello", null);
		forgetDraft("never-saved");
		expect(writes).toBe(n);
	});

	test("oversized text is not saved", () => {
		saveDraft("s1", "x".repeat(MAX_CHARS + 1), null);
		resetDraftCache();
		expect(loadDraft("s1")).toBeNull();
	});

	test("broken storage reads as empty", () => {
		store.set(K.drafts, "{not json");
		expect(loadDraft("s1")).toBeNull();
		saveDraft("s1", "ok", null);
		resetDraftCache();
		expect(loadDraft("s1")?.text).toBe("ok");
	});
});

describe("pruneDrafts", () => {
	const now = 1_000_000_000_000;
	test("drops stale, malformed and empty entries", () => {
		const out = pruneDrafts({
			fresh: { text: "a", reply: null, at: now - 1000 },
			stale: { text: "b", reply: null, at: now - MAX_AGE_MS - 1 },
			empty: { text: " ", reply: null, at: now },
			bad: { text: 3, at: now },
			badReply: { text: "c", reply: "x", at: now },
		}, now);
		expect(Object.keys(out)).toEqual(["fresh"]);
		expect(pruneDrafts(null, now)).toEqual({});
		expect(pruneDrafts("x", now)).toEqual({});
	});

	test("keeps only the most recent drafts", () => {
		const many = Object.fromEntries(Array.from({ length: MAX_DRAFTS + 5 }, (_, i) => [`s${i}`, { text: "t", reply: null, at: now - i }]));
		const out = pruneDrafts(many, now);
		expect(Object.keys(out).length).toBe(MAX_DRAFTS);
		expect(out.s0).toBeDefined();
		expect(out[`s${MAX_DRAFTS}`]).toBeUndefined();
	});
});
