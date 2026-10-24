import { tilde } from "./format";
import type { DirBlock } from "./nav";

export type ServerState = "online" | "offline" | "unauthorized" | "incompatible" | "checking";

/** How the app's own connection state reads as a server's state in the sidebar. */
export function connectionState(net: string): ServerState {
	if (net === "online") return "online";
	if (net === "unauthorized" || net === "incompatible") return net;
	return net === "connecting" ? "checking" : "offline";
}

/** The states in which the server cannot be read, so its list is whatever was last seen. */
export const unreachable = (state: ServerState) => state === "offline" || state === "unauthorized" || state === "incompatible";

/** `~/workspace/x` as segments; each server has its own home. */
const segs = (path: string, home?: string) => tilde(path, home).split("/").filter(Boolean);

/** A folder's label: its own name, with as many parent names as it takes to tell it from the other folders. */
export function shortName(path: string, dirs: readonly Pick<DirBlock, "path">[], home?: string): string {
	const mine = segs(path, home);
	const others = dirs.filter((d) => d.path !== path).map((d) => segs(d.path, home));
	for (let k = 1; k < mine.length; k++) {
		const tail = mine.slice(-k).join("/");
		if (!others.some((o) => o.slice(-k).join("/") === tail)) return tail;
	}
	return mine.join("/") || tilde(path, home);
}

/**
 * Where over a row a drag lands. The top and bottom of a row put the carried tab before / after it; the middle puts the
 * two together (`whole`: a carried group never goes into another group, so its middle counts as an edge too).
 */
export function edgeOf(y: number, rect: { top: number; bottom: number; height: number }, whole: boolean): "before" | "after" | null {
	const f = whole ? 0.5 : 0.28;
	if (y < rect.top + rect.height * f) return "before";
	if (y > rect.bottom - rect.height * f) return "after";
	return null;
}

/** The workdir value `openIn` expects: "." for the server default, else the absolute path. */
export const asWorkdir = (path: string, root: string | undefined) => (path === root ? "." : path);

/** Separator that cannot occur in a path or id, for keys that combine two of them. */
const SEP = "\u0000";
export const dirKey = (serverId: string, path: string) => `${serverId}${SEP}${path}`;
export const groupKey = (id: string) => `group${SEP}${id}`;
export const newKey = (key: string) => `new${SEP}${key}`;
