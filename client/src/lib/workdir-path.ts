/** Path helpers for `/cd`: `~` expansion and the folder suggestions shown above the input while typing its argument. */

/** A Windows absolute path: `C:\x`, `C:/x`, `C:` or a UNC share `\\\\host\\share` */
export const isWinAbs = (p: string): boolean => /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");

/** Absolute on the server, whichever OS it runs on */
export const isAbs = (p: string): boolean => p.startsWith("/") || isWinAbs(p);

/** The separator the server's paths use: `\` for Windows paths, else `/` */
export const sepOf = (p: string): string => (isWinAbs(p) ? "\\" : "/");

/** Drop trailing separators, keeping a root (`/`, `C:\`) intact */
export function trimSep(p: string): string {
	const t = p.replace(/[\\/]+$/, "");
	if (!t) return p.startsWith("/") ? "/" : t;
	return /^[A-Za-z]:$/.test(t) ? `${t}\\` : t;
}

/** `~` and `~/x` become `<home>/…`. Anything else (including `~user`) is returned as is. */
export function expandHome(raw: string, home?: string | null): string {
	if (raw !== "~" && !raw.startsWith("~/")) return raw;
	if (!home) return raw;
	const base = home.replace(/\/+$/, "");
	return raw === "~" ? base || "/" : `${base}/${raw.slice(2)}`;
}

/** The argument of `/cd <arg>` while it is being typed, or null when the text is not that. */
export function cdArgOf(text: string): string | null {
	const m = /^\/cd[ \t]+([^\r\n]*)$/i.exec(text);
	return m ? m[1]!.replace(/^[ \t]+/, "") : null;
}

export interface CdHint {
	/** Absolute folder to list */
	dir: string;
	/** Typed text to keep in front of each suggestion, as the user wrote it (`~/work/`) */
	prefix: string;
	/** What follows the last slash: the name being typed */
	filter: string;
}

/**
 * Which folder to list for a `/cd` argument. `~` and absolute paths are listed as they are; relative ones live under the
 * workspace root (that is what `/cd` means by them). Null when there is nothing sensible to list.
 */
export function cdHint(arg: string, ctx: { root?: string | null; home?: string | null }): CdHint | null {
	if (/[\0\\]/.test(arg)) return null;
	const cut = arg.lastIndexOf("/") + 1;
	let prefix = arg.slice(0, cut);
	const filter = arg.slice(cut);
	if (arg === "~") {
		if (!ctx.home) return null;
		prefix = "~/";
		return { dir: ctx.home, prefix, filter: "" };
	}
	let dir: string;
	if (prefix.startsWith("~/")) {
		if (!ctx.home) return null;
		dir = expandHome(prefix, ctx.home);
	} else if (prefix.startsWith("/")) {
		dir = prefix;
	} else {
		if (!ctx.root) return null;
		const segs = prefix.split("/").filter((s) => s && s !== ".");
		if (segs.includes("..")) return null;
		dir = [ctx.root.replace(/\/+$/, ""), ...segs].join("/") || "/";
	}
	return { dir: dir.length > 1 ? dir.replace(/\/+$/, "") : dir, prefix, filter };
}

/** Folders whose name starts with the filter first, then those that only contain it. Dot-folders only when asked for. */
export function filterDirs<T extends { name: string }>(entries: T[], filter: string): T[] {
	const q = filter.toLowerCase();
	if (!q) return entries.filter((e) => !e.name.startsWith("."));
	const starts = entries.filter((e) => e.name.toLowerCase().startsWith(q));
	if (q.startsWith(".")) return starts;
	const has = entries.filter((e) => !e.name.startsWith(".") && !e.name.toLowerCase().startsWith(q) && e.name.toLowerCase().includes(q));
	return [...starts, ...has];
}

/** Longest common leading text of the names (case-sensitive), for shell-like Tab completion. */
export function commonPrefix(names: string[]): string {
	if (!names.length) return "";
	let pre = names[0]!;
	for (const n of names) while (!n.startsWith(pre)) pre = pre.slice(0, -1);
	return pre;
}

/** `/a/b/par` -> list `/a/b`, filter by `par`. `/a/b/` lists `/a/b` with no filter; no slash means nothing to list yet. */
export function splitTyped(value: string): { dir: string; part: string } {
	const i = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
	if (i < 0) return { dir: "", part: value };
	const dir = value.slice(0, i);
	// the root keeps its separator: `C:\` rather than `C:`
	return { dir: /^[A-Za-z]:$/.test(dir) ? `${dir}${value[i]}` : dir || "/", part: value.slice(i + 1) };
}

/** `/a/b` as clickable steps from the root: `/`, `a`, `b`, each with its own path. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
	const parts = path.split("/").filter(Boolean);
	return [{ name: "/", path: "/" }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}

/** The absolute path of a workspace entry: already absolute, `.` = the root itself, else relative to the root. */
export const absoluteWorkdir = (path: string, root: string | undefined): string => (isAbs(path) ? path : path === "." ? (root ?? "") : `${root}${sepOf(root ?? "")}${path}`);

/**
 * What Tab types after `dir/`: the highlighted folder, else like a shell the only match or the longest common start of
 * them. `whole` means it is a finished folder (so the text ends with `/` and can be listed), not just a shared start.
 */
export function tabComplete(typedDir: string, names: readonly string[], picked: string | undefined): { text: string; whole: boolean } {
	const pre = picked ?? commonPrefix([...names]);
	const whole = picked !== undefined || names.length === 1;
	const sep = sepOf(typedDir);
	return { text: `${/[\\/]$/.test(typedDir) ? typedDir : typedDir + sep}${pre}${whole ? sep : ""}`, whole };
}

/** Folders of a listing that start with what is being typed; the whole list while the listing is for another folder. */
export function typedMatches<T extends { name: string }>(entries: readonly T[], typed: string, listingPath: string | undefined): T[] {
	const { dir, part } = splitTyped(typed.trim());
	if (!part || dir !== listingPath) return [...entries];
	const q = part.toLowerCase();
	return entries.filter((d) => d.name.toLowerCase().startsWith(q));
}

/** The most folders the `/cd` menu lists */
export const CD_ROWS_MAX = 100;

/**
 * The rows of the `/cd` menu: the listing's folders that match what is typed. The listing of another folder is stale
 * while the new one loads, so until `listedFor` is the folder being asked about nothing shows rather than wrong rows.
 */
export function cdRowsOf<T extends { name: string }>(target: CdHint | null, listed: readonly T[], listedFor: string | null): T[] {
	return target && listedFor === target.dir ? filterDirs([...listed], target.filter).slice(0, CD_ROWS_MAX) : [];
}

/** What `/cd ` is completed to for a folder name: the typed prefix (`~/work/`), the name, and a slash to go deeper. */
export const cdCompletion = (target: Pick<CdHint, "prefix"> | null, name: string): string => `${target?.prefix ?? ""}${name}/`;

/**
 * Tab in the `/cd` menu: the highlighted folder when the arrows chose one (or the only match), else like a shell the
 * longest common start of the matches. `row` = complete that row's folder; `text` = type this argument; `none` = nothing to add.
 */
export function cdTab(target: CdHint | null, names: readonly string[], arrowed: boolean): { do: "row" } | { do: "text"; text: string } | { do: "none" } {
	if (!target) return { do: "none" };
	if (arrowed || names.length === 1) return { do: "row" };
	const pre = commonPrefix([...names]);
	return pre.length > target.filter.length ? { do: "text", text: `${target.prefix}${pre}` } : { do: "row" };
}
