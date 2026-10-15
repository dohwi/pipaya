/**
 * UI language. Source strings are Korean and double as the lookup key: `t("설정")`.
 * Another language is a dictionary of `Korean -> translation` (see ./locales); a missing entry falls back to the Korean,
 * so an untranslated string is never blank.
 *
 * Plain TypeScript (no runes) so it loads in tests and non-UI modules. Reactivity is plugged in by `i18n.svelte.ts`
 * (`setTracker` / `onLangChange`): `t()` reads a Svelte signal, so every template that called it re-renders on a switch.
 *
 * Rules for call sites:
 *  - Translate where the text is shown or thrown: `t("...")` in the template / at the `toast()` call.
 *  - A Korean string kept in data (a table, a constant) is wrapped in `msg("...")` and translated at render: `{t(row.label)}`.
 *  - Interpolation goes through parameters, never template literals: `t("서버 {n}개", { n })`.
 */
import { en } from "./locales/en";

/** `ko` and `en` ship with the client; any other tag comes from a language pack (see `setRemotePacks` / `addLocalPack`). */
export type Lang = string;
export type LangPref = "system" | Lang;

/** Stored as a bare string because index.html reads it before the app boots. */
export const LANG_KEY = "pipaya.lang";
/** Last language packs received from the server, so a pack works offline and on the first paint. */
export const PACKS_KEY = "pipaya.locales";

/** Same shape the server accepts (`LOCALE_TAG_PATTERN`): `ja`, `pt-br`, `zh-hant-tw`. */
export const LANG_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/;
export const BUILT_IN_LANGS: readonly Lang[] = ["ko", "en"];

export interface LanguagePack {
	tag: Lang;
	/** The language's own name, e.g. `日本語`. */
	name: string;
	/** Korean source string -> translation. */
	messages: Record<string, string>;
	updatedAt: number;
}
export interface LanguageInfo {
	tag: Lang;
	name: string;
	builtIn: boolean;
}

const BUILT_IN: Record<string, { name: string; dictionary: Record<string, string>; tag: string }> = {
	ko: { name: "한국어", dictionary: {}, tag: "ko-KR" },
	en: { name: "English", dictionary: en, tag: "en-US" },
};
/** From the server (replaced as a whole on every sync). */
const remote = new Map<Lang, LanguagePack>();
/** From enabled extensions that carry a pack; wins over the server copy of the same tag. */
const local = new Map<string, LanguagePack>();
const localPack = (tag: Lang): LanguagePack | undefined => [...local.values()].reverse().find((p) => p.tag === tag);
const pack = (tag: Lang): LanguagePack | undefined => localPack(tag) ?? remote.get(tag);

export function isLangPref(v: unknown): v is LangPref {
	return v === "system" || (typeof v === "string" && LANG_TAG.test(v));
}

const hasLang = (tag: Lang): boolean => tag in BUILT_IN || pack(tag) !== undefined;

/**
 * The first language in the browser's preference order that the client can show: an exact tag (`pt-br`), then the base
 * language (`pt-BR` -> `pt`, or a `pt-br` pack for `pt-PT`). Falls back to English for a list of unsupported languages,
 * Korean (the source language) when nothing is known.
 */
export function systemLang(languages?: readonly string[] | null): Lang {
	const available = [...Object.keys(BUILT_IN), ...remote.keys(), ...[...local.values()].map((p) => p.tag)];
	for (const raw of languages ?? []) {
		const tag = raw.toLowerCase().replace(/_/g, "-");
		if (available.includes(tag)) return tag;
		const base = tag.split("-")[0]!;
		if (available.includes(base)) return base;
		const sibling = available.find((a) => a.split("-")[0] === base);
		if (sibling) return sibling;
	}
	return languages?.length ? "en" : "ko";
}

/** A picked language whose pack is gone (extension removed, pack deleted) reads as "system" until it comes back. */
export function resolveLang(pref: LangPref, languages?: readonly string[] | null): Lang {
	return pref !== "system" && hasLang(pref) ? pref : systemLang(languages);
}

function browserLanguages(): readonly string[] | undefined {
	if (typeof navigator === "undefined") return undefined;
	if (navigator.languages?.length) return navigator.languages;
	return navigator.language ? [navigator.language] : undefined;
}

function readLangPref(): LangPref {
	try {
		const v = localStorage.getItem(LANG_KEY);
		return isLangPref(v) ? v : "system";
	} catch {
		return "system";
	}
}

function readCachedPacks(): LanguagePack[] {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(PACKS_KEY) ?? "[]");
		return Array.isArray(raw) ? raw.map(cleanPack).filter((p): p is LanguagePack => p !== undefined) : [];
	} catch {
		return [];
	}
}

/** Accepts only a well-formed, non-built-in pack; anything else (corrupt cache, odd server reply) is dropped. */
export function cleanPack(input: unknown): LanguagePack | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { tag, name, messages, updatedAt } = input as Record<string, unknown>;
	if (typeof tag !== "string" || !LANG_TAG.test(tag) || tag in BUILT_IN) return undefined;
	if (typeof name !== "string" || !name.trim() || typeof messages !== "object" || messages === null || Array.isArray(messages)) return undefined;
	const clean: Record<string, string> = Object.create(null);
	for (const [k, v] of Object.entries(messages)) if (typeof v === "string" && v) clean[k] = v;
	return { tag, name: name.trim().slice(0, 60), messages: clean, updatedAt: Number.isInteger(updatedAt) ? (updatedAt as number) : 0 };
}

for (const p of readCachedPacks()) remote.set(p.tag, p);
let pref: LangPref = readLangPref();
let current: Lang = resolveLang(pref, browserLanguages());
let touch: () => void = () => {};
const listeners = new Set<() => void>();
syncDocument();

/** Called by `i18n.svelte.ts`: `fn` reads the signal that `switch` bumps. */
export function setTracker(fn: () => void): void {
	touch = fn;
}
export function onLangChange(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** The language in effect (reactive in templates). */
export function getLang(): Lang {
	touch();
	return current;
}
/** What the user picked: "system" or a language (reactive in templates). */
export function getLangPref(): LangPref {
	touch();
	return pref;
}
/** BCP 47 tag for `Intl` / `toLocale*String` (reactive in templates). */
export function localeTag(): string {
	touch();
	const builtIn = BUILT_IN[current];
	if (builtIn) return builtIn.tag;
	try {
		return Intl.getCanonicalLocales(current)[0] ?? "en-US";
	} catch {
		return "en-US";
	}
}

/** Every language the picker offers: the built-in ones, then the packs (reactive in templates). */
export function languages(): LanguageInfo[] {
	touch();
	const tags = new Set<Lang>([...remote.keys(), ...[...local.values()].map((p) => p.tag)]);
	return [
		...Object.entries(BUILT_IN).map(([tag, v]) => ({ tag, name: v.name, builtIn: true })),
		...[...tags].sort().map((tag) => ({ tag, name: pack(tag)!.name, builtIn: false })),
	];
}
/** A language's own name, or the tag when it is unknown. */
export const languageName = (tag: Lang): string => BUILT_IN[tag]?.name ?? pack(tag)?.name ?? tag;

function syncDocument() {
	if (typeof document !== "undefined") document.documentElement.lang = current;
}

/** `notify` also when only the preference changed ("system" -> "ko" on a Korean device): the picker must redraw. */
function apply(next: Lang, notify = false) {
	const changed = next !== current;
	current = next;
	syncDocument();
	if (changed || notify) for (const fn of listeners) fn();
}

/** Re-resolve after the set of packs changed: a picked language may have just appeared or disappeared. */
function refresh() {
	apply(resolveLang(pref, browserLanguages()), true);
}

/** Replace the packs received from the server (every sync, and on `locales_updated`) and remember them for offline use. */
export function setRemotePacks(packs: readonly unknown[]): void {
	remote.clear();
	for (const raw of packs) {
		const p = cleanPack(raw);
		if (p) remote.set(p.tag, p);
	}
	try {
		localStorage.setItem(PACKS_KEY, JSON.stringify([...remote.values()]));
	} catch {
		/* storage unavailable or full: the packs just are not cached */
	}
	refresh();
}
/** `tag -> updatedAt` of the packs held, to download only the ones that changed. */
export const remotePackVersions = (): Record<Lang, number> => Object.fromEntries([...remote].map(([tag, p]) => [tag, p.updatedAt]));
export const remotePack = (tag: Lang): LanguagePack | undefined => remote.get(tag);

/** A pack carried by an enabled extension, usable at once and without the server. Returns whether it was accepted. */
export function addLocalPack(owner: string, input: { tag: Lang; name: string; messages: Record<string, string> }): boolean {
	const p = cleanPack({ ...input, updatedAt: 0 });
	if (!p) return false;
	local.set(`${owner}\u0000${p.tag}`, p);
	refresh();
	return true;
}
export function removeLocalPacks(owner: string): void {
	let removed = false;
	for (const key of [...local.keys()]) if (key.startsWith(`${owner}\u0000`)) removed = local.delete(key) || removed;
	if (removed) refresh();
}

/** Persist the preference and switch. Returns the language now in effect. */
export function setLangPref(next: LangPref): Lang {
	pref = next;
	try {
		localStorage.setItem(LANG_KEY, next);
	} catch {
		/* storage unavailable */
	}
	apply(resolveLang(next, browserLanguages()), true);
	return current;
}

/** Switch without persisting (tests). */
export function setLang(lang: Lang): void {
	pref = lang;
	apply(lang, true);
}

export type Params = Record<string, string | number>;

/**
 * `{name}` is replaced by the parameter; `{n#item|items}` picks the singular when `n === 1`
 * (English needs it, Korean does not, so only translations use it).
 */
export function format(text: string, params?: Params): string {
	if (!params) return text;
	return text.replace(/\{(\w+)(?:#([^|}]*)\|([^}]*))?\}/g, (whole, name: string, one?: string, many?: string) => {
		if (!(name in params)) return whole;
		const v = params[name]!;
		return one === undefined ? String(v) : Number(v) === 1 ? one : many!;
	});
}

/** Separates a Korean key from its context in a dictionary key: `"선택\u0004optional"` (see `tc`). */
export const CONTEXT_SEP = "\u0004";

const dictionary = (lang: Lang): Record<string, string> | undefined => BUILT_IN[lang]?.dictionary ?? pack(lang)?.messages;

/**
 * Lookup order: the language's own entry (context-specific first), then, for a pack, English (a half-finished pack should
 * not fall back to Korean), then the Korean source text.
 */
export function translate(lang: Lang, key: string, params?: Params, context?: string): string {
	const find = (dict: Record<string, string> | undefined) => (context !== undefined ? dict?.[key + CONTEXT_SEP + context] : undefined) ?? dict?.[key];
	const text = find(dictionary(lang)) ?? (lang === "ko" || lang in BUILT_IN ? undefined : find(en)) ?? key;
	return format(text, params);
}

/** Translate a Korean source string into the current language. */
export function t(key: string, params?: Params): string {
	touch();
	return translate(current, key, params);
}

/**
 * Like `t`, for a word that means different things in different places (`선택` is "Select" on a menu and "optional" on a field).
 * The dictionary holds `"선택\u0004optional"` for the special meaning; any language without it falls back to the plain entry.
 */
export function tc(context: string, key: string, params?: Params): string {
	touch();
	return translate(current, key, params, context);
}

/**
 * Marks a Korean string that lives in data (a table, a constant) and is translated at render with `t(value)`.
 * Returns the string unchanged; it exists so the translation check can find it.
 * `msg("확인", "approval")` also declares the context the string is looked up with via `tc("approval", …)`.
 */
export const msg = (key: string, _context?: string): string => key;

/**
 * An error whose message was written for the user in the language in effect (as opposed to a technical one from a library).
 * Code that must pass only its own messages on (extension HTTP, form errors) checks `instanceof` instead of looking for Korean.
 */
export class LocalizedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Error";
	}
}
