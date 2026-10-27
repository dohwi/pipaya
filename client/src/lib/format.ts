
export const compact = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n);

export const duration = (ms: number): string =>
  ms < 1000
    ? `${Math.round(ms)}ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

export const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

export const firstLine = (s: string): string => s.split("\n", 1)[0] ?? "";

/** `20261024-1530`: a local date and time that sorts as text, for file names. */
export function fileStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export const isTouch = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** `crypto.randomUUID` only exists in secure contexts; the dev server is plain http over Tailscale. */
export const uid = (): string =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** `/home/me/work/x` -> `~/work/x` (only when it really is under the home directory). */
export function tilde(path: string, home?: string | null): string {
  if (!home || isWinPath(path)) return path; // Windows paths stay as they are (`C:\Users\me`); only names are shortened
  const h = home.replace(/\/+$/, "");
  if (!h) return path;
  if (path === h) return "~";
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

const isWinPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

/** Segments for naming a folder, same shape on every OS: `C:\Users\me\work\x` with home `C:\Users\me` -> `["~", "work", "x"]`. */
export function nameSegs(path: string, home?: string | null): string[] {
  const split = (p: string) => p.split(/[\\/]/).filter(Boolean);
  if (!home || !isWinPath(path)) return split(tilde(path, home));
  const p = split(path);
  const h = split(home);
  const under = h.length > 0 && h.length <= p.length && h.every((s, i) => s.toLowerCase() === p[i]!.toLowerCase());
  return under ? ["~", ...p.slice(h.length)] : p;
}

/** `100.64.0.1:8787` from a full URL; falls back to the input. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}
