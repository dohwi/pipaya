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

export function memberRows(members: readonly { insert: string; desc: string; group: string }[]): MenuRow[] {
	return members.map((m) => ({ id: m.insert, text: m.insert, desc: m.desc, group: m.group }));
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
