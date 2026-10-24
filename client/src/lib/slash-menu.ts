import { msg } from "./i18n";

/** One row of the recommendation menu above the composer. `group` draws a heading wherever it changes. */
export interface MenuRow {
	id: string;
	text: string;
	args?: string;
	desc: string;
	current?: boolean;
	tag?: string;
	group?: string;
}

/** A built-in command, a skill (`/skill:name`) or a command found by a server extension (`/prefix:name`). */
export type SlashEntry =
	| { command: { name: string; args?: string; desc: string } }
	| { skill: { name: string; description: string } }
	| { family: { prefix: string; label: string; name: string; description: string; args?: string } };

export const SKILL_PREFIX = "skill:";

const slash = (name: string) => `/${name}`;

/** `value` turns a folder name into the text it inserts (the typed prefix plus `name/`). */
export function folderRows(dirs: readonly { name: string; path: string }[], value: (name: string) => string): MenuRow[] {
	return dirs.map((d) => ({ id: d.path, text: value(d.name), desc: "", group: msg("폴더") }));
}

export function fileRows(images: readonly { n: number; name: string }[], files: readonly { path: string; dir: boolean }[]): MenuRow[] {
	return [
		...images.map((a) => ({ id: `image${a.n}`, text: `#image${a.n}`, desc: a.name, group: msg("이미지") })),
		...files.map((f) => ({ id: f.path, text: `#${f.path}`, desc: f.dir ? msg("폴더") : "", group: msg("파일") })),
	];
}

export function mentionRows(items: readonly { insert: string; desc: string; group: string }[]): MenuRow[] {
	return items.map((m) => ({ id: m.insert, text: m.insert, desc: m.desc, group: m.group }));
}

export function optionRows(options: readonly { value: string; desc: string; current?: boolean }[]): MenuRow[] {
	return options.map((o) => ({ id: o.value, text: o.value, desc: o.desc, current: o.current }));
}

export function slashRows(entries: readonly SlashEntry[]): MenuRow[] {
	return entries.map((it): MenuRow => {
		if ("skill" in it) return { id: `skill:${it.skill.name}`, text: slash(`${SKILL_PREFIX}${it.skill.name}`), desc: it.skill.description, tag: msg("스킬"), group: msg("스킬") };
		if ("family" in it) {
			const f = it.family;
			return { id: `${f.prefix}:${f.name}`, text: slash(`${f.prefix}:${f.name}`), args: f.args, desc: f.description, tag: f.label, group: f.label };
		}
		return { id: it.command.name, text: slash(it.command.name), args: it.command.args, desc: it.command.desc, group: msg("명령") };
	});
}

/** What the input is asking the menu for: nothing, a /command (or its argument), a folder for /cd, a #file or an @mention. */
export type MenuKind = "none" | "slash" | "cd" | "file" | "mention";

/**
 * The menu above the input is one slot that four kinds of typing share. They are tried in this order, and the first one
 * that applies wins: `/cd path` (folders), a `#token` (files), an `@token` (mentions), then a `/command` or its argument.
 */
export function menuKindOf(s: { slashQuery: string | null; hasArgSuggestions: boolean; cdArg: string | null; fileMention: boolean; atMention: boolean }): MenuKind {
	if (s.cdArg !== null) return "cd";
	if (s.fileMention) return "file";
	if (s.atMention) return "mention";
	if (s.slashQuery !== null || s.hasArgSuggestions) return "slash";
	return "none";
}

/**
 * Whether the menu is showing. Esc dismisses it for the text it was pressed on. A `/command` menu stays out of the way
 * once images are attached, because Enter then sends. A `#` menu waits for its first answer so it does not flash empty.
 */
export function menuOpen(kind: MenuKind, s: { dismissed: boolean; cdRows: number; fileLoaded: boolean; files: number; images: number; mentions: number; attachments: number }): boolean {
	switch (kind) {
		case "cd": return s.cdRows > 0 && !s.dismissed;
		case "file": return !s.dismissed && (s.fileLoaded || s.files > 0 || s.images > 0);
		case "mention": return !s.dismissed && s.mentions > 0;
		case "slash": return !s.dismissed && s.attachments === 0;
		case "none": return false;
	}
}

/** What a key does while the menu is open. `null` = the menu does not use it and the input handles it as usual. */
export type MenuKey =
	| { do: "move"; to: number }
	| { do: "dismiss" }
	| { do: "complete" }
	| { do: "enter-folder" }
	| { do: "pick" };

/**
 * The keys of an open menu. Arrows wrap around the rows; Esc hides it; Tab completes the row (or for `/cd` the folder,
 * shell-style); Enter picks the row on a desktop keyboard (a phone's Enter is a newline). For `/cd` Enter goes to the
 * folder only if the arrows chose one, else the typed path is used as written (`enter-folder` first, then falls through).
 * Shift+Enter is never taken, and composing (IME) text is never touched.
 */
export function menuKey(key: string, s: { index: number; count: number; kind: MenuKind; shift: boolean; touch: boolean }): MenuKey | null {
	if (key === "ArrowDown" || key === "ArrowUp") return s.count ? { do: "move", to: (s.index + (key === "ArrowDown" ? 1 : -1) + s.count) % s.count } : null;
	if (key === "Escape") return { do: "dismiss" };
	if (key === "Tab" && s.count) return { do: "complete" };
	if (key === "Enter" && !s.shift && !s.touch) {
		if (s.kind === "cd") return { do: "enter-folder" };
		if (s.count) return { do: "pick" };
	}
	return null;
}
