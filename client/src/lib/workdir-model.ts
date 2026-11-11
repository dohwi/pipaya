/** The working-directory rules of the store, as plain functions of the workspace root: no reactive state. */
import { expandHome, isAbs, isWinAbs, relativeToRoot, sepOf, trimSep } from "./workdir-path";

/** Why a typed folder was refused; the store turns it into a message. */
export type WorkdirError = "home" | "chars" | "relative";

/** `/home/x/workspace/proj/a` -> `proj/a`; the root itself is ".". */
export const relPath = relativeToRoot;

/** Absolute path a `workdir` value stands for (best effort until the server confirms). */
export function workdirAbs(workdir: string, root: string | null | undefined): string {
  const r = root ?? "";
  return workdir === "." ? r : isAbs(workdir) ? workdir : `${r}${sepOf(r)}${workdir}`;
}

/** A `workdir` value as shown: the root for ".", an absolute path as is, else the sub-folder under the root. */
export function workdirText(workdir: string, root: string | null | undefined): string | null {
  if (workdir === ".") return root ?? null;
  if (isAbs(workdir)) return workdir;
  return `${root ?? ""}${sepOf(root ?? "")}${workdir}`.replace(/^\//, "/");
}

/**
 * What a typed folder (`/cd`, the picker) is stored as: "." for the root, a path relative to the root when it lies inside
 * it, else an absolute path. `home` expands a leading `~`.
 */
export function normalizeWorkdir(
  raw: string,
  ctx: { root?: string | null; home?: string | null },
): { ok: true; path: string } | { ok: false; error: WorkdirError } {
  let rel = trimSep(expandHome(raw.trim(), ctx.home)) || ".";
  if (rel === "~" || rel.startsWith("~/")) return { ok: false, error: "home" };
  // a backslash is a separator in a Windows path (`C:\work`), and nothing else
  if (/\0/.test(rel) || (!isWinAbs(rel) && rel.includes("\\")) || (isWinAbs(rel) && /[<>"|?*\0]/.test(rel.slice(2))))
    return { ok: false, error: "chars" };
  // An absolute path inside the default directory is stored relative to it, so the sidebar groups it with the rest.
  if (isAbs(rel)) rel = relPath(rel, ctx.root);
  else rel = rel.replace(/^(\.\/)+/, "") || ".";
  if (!isAbs(rel) && rel.split("/").some((seg) => seg === ".." || seg === "")) return { ok: false, error: "relative" };
  return { ok: true, path: rel };
}
