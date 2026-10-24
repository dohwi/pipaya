import type { Api } from "./api";
import { getLang } from "./i18n";
import { parseSettingFields, type SettingField } from "./extensions/schema";

/** What the server says about an extension running inside it (`GET /server-extensions`). */
export type ServerExt = Awaited<ReturnType<Api["serverExtensions"]>>["extensions"][number];

/** The key a server extension goes by in the settings sidebar and in the open-page selection. */
export const srvKey = (name: string): string => `srv:${name}`;

/** The declared form of a server extension, or why it cannot be shown. */
export function serverFields(ext: Pick<ServerExt, "settings">): { fields?: SettingField[]; problem?: string } {
	if (!ext.settings) return {};
	try {
		return { fields: parseSettingFields(ext.settings) };
	} catch (cause) {
		return { problem: cause instanceof Error ? cause.message : String(cause) };
	}
}

/** Its description in the language in use, else the plain one. */
export const serverText = (ext: Pick<ServerExt, "description" | "descriptions">): string => ext.descriptions?.[getLang()] ?? ext.description ?? "";

/** The commands (`/name`) and tools it adds, in one list. */
export const serverProvides = (ext: Pick<ServerExt, "tools" | "commands">): string[] => [...ext.commands.map((c) => `/${c.name}`), ...ext.tools];

/** The environment variable that carries one of its flags. */
export const flagVariable = (name: string): string => `PIPAYA_FLAG_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
