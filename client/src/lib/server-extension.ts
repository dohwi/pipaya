import type { Api } from "./api";
import { getLang } from "./i18n";
import { parseSettingField, SETTING_FIELD_KEYS, type SettingField } from "./extensions/schema";
import { cleanTable, localize, localizeFields, matchLang } from "./extensions/translations";

/** What the server says about an extension running inside it (`GET /server-extensions`). */
export type ServerExt = Awaited<ReturnType<Api["serverExtensions"]>>["extensions"][number];

/** The key a server extension goes by in the settings sidebar and in the open-page selection. */
export const srvKey = (name: string): string => `srv:${name}`;

/**
 * The declared form of a server extension, or why it cannot be shown.
 *
 * A server extension can be newer than the app reading it, so a field this client does not know is dropped rather
 * than failing the whole form: one unknown key used to hide every setting behind a single warning. A field that is
 * wrong in a way this client can see (a bad key, a missing label) still fails, so a broken manifest is not hidden.
 */
/** The form in the language in use: labels, hints and option labels from `pipaya.translations` (see docs/i18n.md). */
export function serverFields(ext: Pick<ServerExt, "settings"> & { translations?: unknown }): { fields?: SettingField[]; problem?: string } {
	if (!ext.settings) return {};
	const declared = Array.isArray(ext.settings) ? ext.settings : [];
	const fields: SettingField[] = [];
	let problem: string | undefined;
	// Shared across the fields, so `when` can name an earlier one.
	const earlier = new Map<string, SettingField>();
	declared.forEach((raw, index) => {
		// Drop a key this client does not know (`readonly` on an older app) and keep the field: the extension is
		// allowed to be newer than the app, and one unknown key must not hide every setting.
		const known = raw && typeof raw === "object" && !Array.isArray(raw)
			? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => SETTING_FIELD_KEYS.includes(k)))
			: raw;
		try {
			fields.push(parseSettingField(known, index, earlier));
		} catch (cause) {
			problem ??= cause instanceof Error && cause.message.startsWith("settings[") ? cause.message : `settings[${index}]: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	});
	if (problem) return { problem };
	return fields.length ? { fields: localizeFields(fields, cleanTable(ext.translations)) } : {};
}

/** Its description in the language in use, else the plain one. */
export const serverText = (ext: Pick<ServerExt, "description" | "descriptions">): string =>
	(ext.descriptions ? matchLang(ext.descriptions, getLang()) : "") || ext.description || "";

/** Its title in the language in use (`pipaya.translations`), else the name of its folder. */
export const serverTitle = (ext: Pick<ServerExt, "name" | "title"> & { translations?: unknown }): string =>
	ext.title ? localize(ext.title, cleanTable(ext.translations)) : ext.name;

/** The commands (`/name`) and tools it adds, in one list. */
export const serverProvides = (ext: Pick<ServerExt, "tools" | "commands">): string[] => [...ext.commands.map((c) => `/${c.name}`), ...ext.tools];

/** The environment variable that carries one of its flags. */
export const flagVariable = (name: string): string => `PIPAYA_FLAG_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
