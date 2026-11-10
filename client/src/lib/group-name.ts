import { t } from "./i18n";

/**
 * Name a new group after its sessions' working folders: `pipaya` when they all share one, `pipaya / pipaya-wiki` when they
 * differ (at most three, then `+N`), numbered when that name is taken. Falls back to "Group N" when no folder is known.
 */
export function groupNameFor(cwds: readonly (string | undefined)[], taken: ReadonlySet<string>): string {
	const dirs: string[] = [];
	for (const raw of cwds) {
		const cwd = raw?.replace(/\/+$/, "");
		const dir = cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? "") : "";
		if (dir && !dirs.includes(dir)) dirs.push(dir);
	}
	if (dirs.length) {
		const shown = dirs.length > 3 ? [...dirs.slice(0, 3), `+${dirs.length - 3}`] : dirs;
		const base = shown.join(" / ");
		if (!taken.has(base)) return base;
		for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
	}
	for (let n = 1; ; n++) if (!taken.has(t("그룹 {n}", { n }))) return t("그룹 {n}", { n });
}
