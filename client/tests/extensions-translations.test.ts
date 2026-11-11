import { describe, expect, test } from "bun:test";
import { cleanTable, displayValue, localize, localizeFields, manifestDescription, manifestName, pickLang } from "../src/lib/extensions/translations";
import { parsePackage, type SettingField } from "../src/lib/extensions/schema";
import { serverFields, serverTitle } from "../src/lib/server-extension";

const table = { en: { "포크 폭탄 차단": "Block fork bombs", 켬: "On" }, ja: { "포크 폭탄 차단": "フォーク爆弾を防ぐ" } };

describe("an extension's own translations", () => {
	test("the language in use, its base language, then English, then the text as written", () => {
		expect(localize("포크 폭탄 차단", table, "en")).toBe("Block fork bombs");
		expect(localize("포크 폭탄 차단", table, "en-gb")).toBe("Block fork bombs");
		expect(localize("포크 폭탄 차단", table, "ja")).toBe("フォーク爆弾を防ぐ");
		// a language the table lacks reads English rather than the source
		expect(localize("포크 폭탄 차단", table, "de")).toBe("Block fork bombs");
		expect(localize("포크 폭탄 차단", table, "ko")).toBe("포크 폭탄 차단");
		expect(localize("없는 문장", table, "en")).toBe("없는 문장");
		expect(localize("x", undefined, "en")).toBe("x");
		// an inherited name is not an entry
		expect(localize("constructor", table, "en")).toBe("constructor");
	});
	test("a value kept in several languages shows the one in use", () => {
		expect(pickLang({ ko: "연결됨", en: "Connected" }, "en")).toBe("Connected");
		expect(pickLang({ ko: "연결됨", en: "Connected" }, "ko")).toBe("연결됨");
		expect(pickLang({ ko: "연결됨" }, "en")).toBe("연결됨");
		expect(displayValue("plain", "en")).toBe("plain");
		expect(displayValue({ ko: "가", en: "a" }, "en")).toBe("a");
		// a number is a value too (0 included); only a missing or unusable value is empty
		expect(displayValue(42, "en")).toBe("42");
		expect(displayValue(0, "en")).toBe("0");
		for (const empty of [undefined, null, NaN, Infinity, [], {}, { ko: "" }, ""]) expect(displayValue(empty, "en")).toBe("");
	});
	test("a form keeps its keys and values and translates what a person reads", () => {
		const fields: SettingField[] = [
			{ key: "fork", type: "boolean", label: "포크 폭탄 차단", description: "포크 폭탄 차단", default: true },
			{ key: "mode", type: "select", label: "모드", options: [{ value: "on", label: "켬" }, { value: "off", label: "끔" }], default: "on" },
		];
		const out = localizeFields(fields, table, "en");
		expect(out[0]).toMatchObject({ key: "fork", label: "Block fork bombs", description: "Block fork bombs", default: true });
		expect(out[1]!.options).toEqual([{ value: "on", label: "On" }, { value: "off", label: "끔" }]);
		expect(fields[0]!.label).toBe("포크 폭탄 차단");
	});
	test("an untrusted table drops what does not fit", () => {
		expect(cleanTable({ en: { a: "A", b: 1, "": "x" }, "Bad Tag": { a: "x" }, ja: "nope" })).toEqual({ en: { a: "A" } });
		expect(cleanTable([])).toBeUndefined();
		expect(cleanTable({ __proto__: { a: "x" } } as unknown)).toBeUndefined();
	});
});

describe("server extensions", () => {
	test("title, description and form follow the language", () => {
		const ext = {
			name: "guard", title: "가드", description: "Blocks", descriptions: { ko: "막습니다", en: "Blocks" },
			translations: { en: { 가드: "Guard", "포크 폭탄 차단": "Block fork bombs" } },
			settings: [{ key: "fork", type: "boolean", label: "포크 폭탄 차단", default: true }],
		};
		expect(serverTitle(ext)).toBe("가드");
		expect(serverFields(ext).fields![0]!.label).toBe("포크 폭탄 차단");
	});
});

describe("client extension manifests", () => {
	const base = { manifest: { id: "ex.t", name: "가드", version: "1.0.0", sdkVersion: 1, permissions: [] as string[] }, code: "export default {};" };
	test("descriptions and translations validate and round-trip", () => {
		const pkg = parsePackage({ ...base, manifest: { ...base.manifest, description: "막습니다", descriptions: { en: "Blocks" }, translations: { en: { 가드: "Guard" } } } });
		expect(pkg.manifest.descriptions).toEqual({ en: "Blocks" });
		expect(manifestName(pkg.manifest, "en")).toBe("Guard");
		expect(manifestName(pkg.manifest, "ko")).toBe("가드");
		expect(manifestDescription(pkg.manifest, "en")).toBe("Blocks");
		expect(manifestDescription(pkg.manifest, "ko")).toBe("막습니다");
	});
	test("a bad tag, a non-string entry or too many languages is refused", () => {
		const bad = (m: Record<string, unknown>) => () => parsePackage({ ...base, manifest: { ...base.manifest, ...m } });
		expect(bad({ translations: { EN: { a: "b" } } })).toThrow();
		expect(bad({ translations: { en: { a: 1 } } })).toThrow();
		expect(bad({ translations: { en: { "": "b" } } })).toThrow();
		expect(bad({ descriptions: { "en us": "x" } })).toThrow();
		expect(bad({ translations: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`l${String.fromCharCode(97 + i)}`, { a: "b" }])) })).toThrow();
	});
});
