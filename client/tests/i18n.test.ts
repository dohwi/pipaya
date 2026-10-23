import { afterEach, describe, expect, test } from "bun:test";
import {
	LocalizedError, PACKS_KEY, addLocalPack, cleanPack, format, getLang, languageName, languages, localeTag, msg, remotePackVersions, removeLocalPacks,
	resolveLang, setLang, setLangPref, setRemotePacks, systemLang, t, tc, translate,
} from "../src/lib/i18n";
import { en } from "../src/lib/locales/en";
import { sourceKeys } from "../scripts/extract-i18n.cjs";

afterEach(() => {
	setRemotePacks([]);
	removeLocalPacks("ext.a");
	removeLocalPacks("ext.b");
	setLang("ko");
});

const ja = { tag: "ja", name: "日本語", messages: { "설정": "設定", "닫기": "閉じる" }, updatedAt: 5 };

describe("language detection", () => {
	test("follows the first supported language the browser prefers", () => {
		expect(systemLang(["ko-KR", "en-US"])).toBe("ko");
		expect(systemLang(["en-GB", "ko"])).toBe("en");
		expect(systemLang(["fr-FR", "en-US"])).toBe("en");
		expect(systemLang(["KO_kr"])).toBe("ko");
	});
	test("an unsupported-only list reads as English, an unknown one as Korean (the source language)", () => {
		expect(systemLang(["ja-JP", "fr"])).toBe("en");
		expect(systemLang([])).toBe("ko");
		expect(systemLang(undefined)).toBe("ko");
	});
	test("an explicit choice wins over the system", () => {
		expect(resolveLang("en", ["ko"])).toBe("en");
		expect(resolveLang("ko", ["en"])).toBe("ko");
		expect(resolveLang("system", ["en"])).toBe("en");
	});
});

describe("t()", () => {
	test("Korean returns the source string, English the dictionary entry", () => {
		expect(t("설정")).toBe("설정");
		setLang("en");
		expect(t("설정")).toBe("Settings");
		expect(getLang()).toBe("en");
		expect(localeTag()).toBe("en-US");
	});
	test("a missing entry falls back to the Korean instead of going blank", () => {
		setLang("en");
		expect(t("사전에 없는 문장")).toBe("사전에 없는 문장");
		expect(t("사전에 없는 {n}개", { n: 3 })).toBe("사전에 없는 3개");
	});
	test("substitutes parameters, leaving unknown placeholders alone", () => {
		setLang("en");
		expect(t("Can't reach {url}", { url: "x" })).toBe("Can't reach x");
		expect(format("{a} {b}", { a: 1 })).toBe("1 {b}");
	});
	test("English plural forms follow the count", () => {
		setLang("en");
		expect(t("모델 {n}개", { n: 1 })).toBe("1 model");
		expect(t("모델 {n}개", { n: 2 })).toBe("2 models");
		expect(t("모델 {n}개", { n: 0 })).toBe("0 models");
		expect(t("대화 {n}개", { n: 1 })).toBe("1 chat");
		// Korean has no plural: the source string just takes the number
		setLang("ko");
		expect(t("모델 {n}개", { n: 2 })).toBe("모델 2개");
	});
	test("tc() picks the context entry and falls back to the plain one", () => {
		setLang("en");
		expect(t("선택")).toBe("Select");
		expect(tc("optional", "선택")).toBe("optional");
		expect(tc("nothing-registered", "선택")).toBe("Select");
		setLang("ko");
		expect(tc("optional", "선택")).toBe("선택");
	});
	test("msg() leaves the text alone so it can be translated where it is shown", () => {
		const label = msg("닫기");
		expect(label).toBe("닫기");
		setLang("en");
		expect(t(label)).toBe("Close");
		expect(t("확인")).toBe("OK");
	});
	test("translate() works for a language other than the current one", () => {
		expect(translate("en", "저장")).toBe("Save");
		expect(translate("ko", "저장")).toBe("저장");
	});
});

describe("LocalizedError", () => {
	test("is an Error that code can recognise as its own, user-ready message", () => {
		const e = new LocalizedError(t("저장"));
		expect(e).toBeInstanceOf(Error);
		expect(e).toBeInstanceOf(LocalizedError);
		expect(e.message).toBe("저장");
		expect(new Error("x")).not.toBeInstanceOf(LocalizedError);
	});
});

describe("dictionary", () => {
	test("covers every string used in the source and has nothing unused", () => {
		const used = new Set(sourceKeys().keys());
		const have = new Set(Object.keys(en));
		expect([...used].filter((k) => !have.has(k))).toEqual([]);
		expect([...have].filter((k) => !used.has(k))).toEqual([]);
	});
	test("no entry is empty, and each keeps the placeholders of its Korean source", () => {
		const names = (s: string) => [...s.matchAll(/\{(\w+)(?:#[^|}]*\|[^}]*)?\}/g)].map((m) => m[1]!).sort();
		for (const [ko, english] of Object.entries(en)) {
			expect(english.trim(), ko).not.toBe("");
			const key = ko.split("\u0004")[0]!;
			// the English may omit a count already implied by the sentence, but must never invent a placeholder
			const sourceNames = names(key);
			for (const n of names(english)) expect(sourceNames, `${ko} -> ${english}`).toContain(n);
		}
	});
	test("English plural markers are well formed", () => {
		for (const english of Object.values(en)) expect(english).not.toMatch(/\{\w+#[^|}]*\}/);
	});
	test("English text is English (no leftover Hangul)", () => {
		for (const [ko, english] of Object.entries(en)) expect(english, ko).not.toMatch(/[가-힣]/);
	});
});

describe("language packs", () => {
	test("a server pack becomes a language, and its entries are used", () => {
		expect(languages().map((l) => l.tag)).toEqual(["ko", "en"]);
		setRemotePacks([ja]);
		expect(languages()).toEqual([{ tag: "ko", name: "한국어", builtIn: true }, { tag: "en", name: "English", builtIn: true }, { tag: "ja", name: "日本語", builtIn: false }]);
		setLang("ja");
		expect(t("설정")).toBe("設定");
		expect(languageName("ja")).toBe("日本語");
		expect(remotePackVersions()).toEqual({ ja: 5 });
	});
	test("an untranslated entry falls back to English, then to the Korean source", () => {
		setRemotePacks([ja]);
		setLang("ja");
		expect(t("저장")).toBe("Save");
		expect(t("사전에 없는 문장")).toBe("사전에 없는 문장");
		expect(tc("optional", "선택")).toBe("optional");
		expect(t("모델 {n}개", { n: 2 })).toBe("2 models");
	});
	test("a pack cannot replace a built-in language or carry malformed data", () => {
		setRemotePacks([{ ...ja, tag: "en", messages: { "설정": "hacked" } }, { ...ja, tag: "ko" }, { ...ja, tag: "J" }, { ...ja, name: "" }, { ...ja, messages: [] }, null, "x"]);
		expect(languages().map((l) => l.tag)).toEqual(["ko", "en"]);
		setLang("en");
		expect(t("설정")).toBe("Settings");
		expect(cleanPack({ ...ja, messages: { a: "b", c: 1, d: "" } })?.messages).toEqual({ a: "b" });
	});
	test("a prototype-polluting key is just a harmless entry", () => {
		const p = cleanPack(JSON.parse('{"tag":"ja","name":"x","messages":{"__proto__":"y","a":"b"},"updatedAt":1}'));
		expect(({} as any).y).toBeUndefined();
		expect(p?.messages.a).toBe("b");
	});
	test("an extension's own pack wins over the server's, and leaves with the extension", () => {
		setRemotePacks([ja]);
		expect(addLocalPack("ext.a", { tag: "ja", name: "日本語 (ext)", messages: { "설정": "せってい" } })).toBe(true);
		setLang("ja");
		expect(t("설정")).toBe("せってい");
		removeLocalPacks("ext.a");
		expect(t("설정")).toBe("設定");
		expect(addLocalPack("ext.a", { tag: "ko", name: "x", messages: { a: "b" } })).toBe(false);
	});
	test("the later extension wins when two carry the same language", () => {
		addLocalPack("ext.a", { tag: "ja", name: "A", messages: { "설정": "A" } });
		addLocalPack("ext.b", { tag: "ja", name: "B", messages: { "설정": "B" } });
		expect(translate("ja", "설정")).toBe("B");
		removeLocalPacks("ext.b");
		expect(translate("ja", "설정")).toBe("A");
	});
	test("system language picks a pack by exact tag, base language, or a sibling region", () => {
		setRemotePacks([ja, { ...ja, tag: "pt-br", name: "Português" }]);
		expect(systemLang(["ja-JP"])).toBe("ja");
		expect(systemLang(["pt-BR"])).toBe("pt-br");
		expect(systemLang(["pt-PT"])).toBe("pt-br");
		expect(systemLang(["fr", "ja"])).toBe("ja");
		expect(systemLang(["ko-KR", "ja"])).toBe("ko");
		expect(systemLang(["fr"])).toBe("en");
		expect(resolveLang("system", ["ja"])).toBe("ja");
	});
	test("a chosen language whose pack is gone reads as system, and returns when the pack does", () => {
		setRemotePacks([ja]);
		setLangPref("ja");
		expect(getLang()).toBe("ja");
		setRemotePacks([]);
		expect(getLang()).not.toBe("ja");
		setRemotePacks([ja]);
		expect(getLang()).toBe("ja");
		setLangPref("system");
	});
	test("locale tag for Intl follows the language", () => {
		setRemotePacks([{ ...ja, tag: "pt-br" }]);
		setLang("pt-br");
		expect(localeTag()).toBe("pt-BR");
		setLang("en");
		expect(localeTag()).toBe("en-US");
	});
	test("packs are cached so they work on the next start without the server", () => {
		const store = new Map<string, string>();
		(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
		try {
			setRemotePacks([ja]);
			expect(JSON.parse(store.get(PACKS_KEY)!)).toEqual([ja]);
			setRemotePacks([]);
			expect(JSON.parse(store.get(PACKS_KEY)!)).toEqual([]);
		} finally {
			delete (globalThis as any).localStorage;
		}
	});
});
