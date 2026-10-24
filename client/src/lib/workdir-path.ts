/** Path helpers for `/cd`: `~` expansion and the folder suggestions shown above the input while typing its argument. */

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
	const i = value.lastIndexOf("/");
	return i < 0 ? { dir: "", part: value } : { dir: value.slice(0, i) || "/", part: value.slice(i + 1) };
}

/** `/a/b` as clickable steps from the root: `/`, `a`, `b`, each with its own path. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
	const parts = path.split("/").filter(Boolean);
	return [{ name: "/", path: "/" }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}

/** The absolute path of a workspace entry: already absolute, `.` = the root itself, else relative to the root. */
export const absoluteWorkdir = (path: string, root: string | undefined): string => (path.startsWith("/") ? path : path === "." ? (root ?? "") : `${root}/${path}`);

/**
 * What Tab types after `dir/`: the highlighted folder, else like a shell the only match or the longest common start of
 * them. `whole` means it is a finished folder (so the text ends with `/` and can be listed), not just a shared start.
 */
export function tabComplete(typedDir: string, names: readonly string[], picked: string | undefined): { text: string; whole: boolean } {
	const pre = picked ?? commonPrefix([...names]);
	const whole = picked !== undefined || names.length === 1;
	return { text: `${typedDir === "/" ? "" : typedDir}/${pre}${whole ? "/" : ""}`, whole };
}

/** Folders of a listing that start with what is being typed; the whole list while the listing is for another folder. */
export function typedMatches<T extends { name: string }>(entries: readonly T[], typed: string, listingPath: string | undefined): T[] {
	const { dir, part } = splitTyped(typed.trim());
	if (!part || dir !== listingPath) return [...entries];
	const q = part.toLowerCase();
	return entries.filter((d) => d.name.toLowerCase().startsWith(q));
}
