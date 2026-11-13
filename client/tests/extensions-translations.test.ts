import { describe, expect, test } from "bun:test";
import { cleanTable, displayValue, localize, localizeFields, manifestDescription, manifestName, pickLang } from "../src/lib/extensions/translations";
import { parsePackage, type SettingField } from "../src/lib/extensions/schema";
import { serverFields, serverTitle } from "../src/lib/server-extension";

const table = { en: { "한 시간마다 알림": "Remind every hour", 켬: "On" }, ja: { "한 시간마다 알림": "1時間ごとに通知" } };

describe("an extension's own translations", () => {
	test("the language in use, its base language, then English, then the text as written", () => {
		expect(localize("한 시간마다 알림", table, "en")).toBe("Remind every hour");
		expect(localize("한 시간마다 알림", table, "en-gb")).toBe("Remind every hour");
		expect(localize("한 시간마다 알림", table, "ja")).toBe("1時間ごとに通知");
		// a language the table lacks reads English rather than the source
		expect(localize("한 시간마다 알림", table, "de")).toBe("Remind every hour");
		expect(localize("한 시간마다 알림", table, "ko")).toBe("한 시간마다 알림");
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
			{ key: "hourly", type: "boolean", label: "한 시간마다 알림", description: "한 시간마다 알림", default: true },
			{ key: "mode", type: "select", label: "모드", options: [{ value: "on", label: "켬" }, { value: "off", label: "끔" }], default: "on" },
		];
		const out = localizeFields(fields, table, "en");
		expect(out[0]).toMatchObject({ key: "hourly", label: "Remind every hour", description: "Remind every hour", default: true });
		expect(out[1]!.options).toEqual([{ value: "on", label: "On" }, { value: "off", label: "끔" }]);
		expect(fields[0]!.label).toBe("한 시간마다 알림");
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
			name: "reminder", title: "알림", description: "Reminds", descriptions: { ko: "알려 줍니다", en: "Reminds" },
			translations: { en: { 알림: "Reminder", "한 시간마다 알림": "Remind every hour" } },
			settings: [{ key: "hourly", type: "boolean", label: "한 시간마다 알림", default: true }],
		};
		expect(serverTitle(ext)).toBe("알림");
		expect(serverFields(ext).fields![0]!.label).toBe("한 시간마다 알림");
	});
});

describe("client extension manifests", () => {
	const base = { manifest: { id: "ex.t", name: "알림", version: "1.0.0", sdkVersion: 1, permissions: [] as string[] }, code: "export default {};" };
	test("descriptions and translations validate and round-trip", () => {
		const pkg = parsePackage({ ...base, manifest: { ...base.manifest, description: "알려 줍니다", descriptions: { en: "Reminds" }, translations: { en: { 알림: "Reminder" } } } });
		expect(pkg.manifest.descriptions).toEqual({ en: "Reminds" });
		expect(manifestName(pkg.manifest, "en")).toBe("Reminder");
		expect(manifestName(pkg.manifest, "ko")).toBe("알림");
		expect(manifestDescription(pkg.manifest, "en")).toBe("Reminds");
		expect(manifestDescription(pkg.manifest, "ko")).toBe("알려 줍니다");
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
