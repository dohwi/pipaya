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
