/**
 * An extension's own text in the language in use. The app's strings go through `t()` and its dictionaries; an extension
 * ships its own table instead, because its text is not in the app's dictionaries:
 *
 *   "translations": { "en": { "디스크·홈 삭제 차단": "Block wiping disks and home" } }
 *
 * The keys are the extension's text exactly as written. Lookup: the language in use, then its base language (`pt-br` ->
 * `pt`), then English for a language other than Korean or English, then the text as written.
 * See docs/i18n.md.
 */
import { getLang, t } from "../i18n";
import type { SettingField } from "./schema";

/** Language tag -> { source text -> translation }. */
export type TranslationTable = Record<string, Record<string, string>>;
/** A value kept in several languages at once (`{ "ko": "...", "en": "..." }`): a status line an extension writes. */
export type LocalizedValue = Record<string, string>;

/**
 * The order to try languages in for `lang`: itself, its base language, then English, the way the app's own `translate()`
 * does it. Korean and English never borrow another language: Korean is what pipaya's text is written in, so a Korean
 * reader of an extension without a `ko` entry sees the text as written, never an English translation of it.
 */
const order = (lang: string): string[] => {
	const base = lang.split("-")[0]!;
	return [...new Set(base === "ko" || base === "en" ? [lang, base] : [lang, base, "en"])];
};

/** `text` in the language in use (reactive in templates), or `text` itself when the table has nothing for it. */
export function localize(text: string, table: TranslationTable | undefined, lang = getLang()): string {
	if (!table || !text) return text;
	for (const tag of order(lang)) {
		const entries = Object.hasOwn(table, tag) ? table[tag] : undefined;
		const hit = entries && Object.hasOwn(entries, text) ? entries[text] : undefined;
		if (typeof hit === "string" && hit) return hit;
	}
	return text;
}

/** The version of a value for the language in use, by the same order; "" when none matches. */
export function matchLang(value: LocalizedValue, lang = getLang()): string {
	for (const tag of order(lang)) if (Object.hasOwn(value, tag) && typeof value[tag] === "string" && value[tag]) return value[tag]!;
	return "";
}

/** One of several versions of a value (`{ ko, en }`): the one for the language in use, else the first. */
export function pickLang(value: LocalizedValue, lang = getLang()): string {
	return matchLang(value, lang) || (Object.values(value).find((v) => typeof v === "string" && v) ?? "");
}

/** A value an extension wrote for display: a plain string, or the same text in several languages. */
export function displayValue(value: unknown, lang = getLang()): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return value ? t("켜짐") : t("꺼짐");
	if (value && typeof value === "object" && !Array.isArray(value)) return pickLang(value as LocalizedValue, lang);
	return "";
}

/** The fields with every label, hint, placeholder and option label in the language in use. Values and keys are untouched. */
export function localizeFields(fields: readonly SettingField[], table: TranslationTable | undefined, lang = getLang()): SettingField[] {
	if (!table) return [...fields];
	const l = (s: string) => localize(s, table, lang);
	return fields.map((f) => ({
		...f,
		label: l(f.label),
		...(f.description !== undefined ? { description: l(f.description) } : {}),
		...(f.placeholder !== undefined ? { placeholder: l(f.placeholder) } : {}),
		...(f.options ? { options: f.options.map((o) => ({ ...o, label: l(o.label) })) } : {}),
	}));
}

const LANG_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/;

/** A table from untrusted JSON, bounded the way the server bounds it: bad tags and non-string entries are dropped. */
export function cleanTable(raw: unknown): TranslationTable | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: TranslationTable = {};
	for (const [tag, entries] of Object.entries(raw).slice(0, 10)) {
		if (!LANG_TAG.test(tag) || !entries || typeof entries !== "object" || Array.isArray(entries)) continue;
		const d: Record<string, string> = {};
		for (const [k, v] of Object.entries(entries).slice(0, 300)) if (typeof v === "string" && v.trim() && k.trim() && k.length <= 2000 && v.length <= 2000) Object.defineProperty(d, k, { value: v, enumerable: true, writable: true, configurable: true });
		if (Object.keys(d).length) out[tag] = d;
	}
	return Object.keys(out).length ? out : undefined;
}

type ManifestText = { name: string; description?: string; descriptions?: Record<string, string>; translations?: TranslationTable };
/** A client extension's name in the language in use (`manifest.translations`). */
export const manifestName = (m: ManifestText, lang = getLang()): string => localize(m.name, m.translations, lang);
/** Its description: `manifest.descriptions` for the language in use, else `description`. */
export const manifestDescription = (m: ManifestText, lang = getLang()): string =>
	(m.descriptions ? matchLang(m.descriptions, lang) : "") || m.description || "";
