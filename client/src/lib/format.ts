import type { Session } from "./types";
import { localeTag, msg } from "./i18n";

export const compact = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n);

export const money = (usd: number): string =>
  usd === 0 ? "$0" : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(usd < 1 ? 3 : 2)}`;

export const duration = (ms: number): string =>
  ms < 1000
    ? `${Math.round(ms)}ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

export const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

export const firstLine = (s: string): string => s.split("\n", 1)[0] ?? "";

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(localeTag(), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface SessionGroup {
  label: string;
  sessions: Session[];
}

/** Group sessions (already sorted newest-first) the way chat apps do. */
export function groupSessions(
  sessions: Session[],
  now = Date.now(),
): SessionGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const t0 = startOfToday.getTime();
  const buckets: [string, number][] = [
    [msg("오늘"), t0],
    [msg("어제"), t0 - day],
    [msg("지난 7일"), t0 - 7 * day],
    [msg("지난 30일"), t0 - 30 * day],
  ];
  const groups: SessionGroup[] = [];
  for (const s of sessions) {
    const label =
      buckets.find(([, from]) => s.updatedAt >= from)?.[0] ?? msg("이전", "older");
    let g = groups[groups.length - 1];
    if (!g || g.label !== label) {
      g = { label, sessions: [] };
      groups.push(g);
    }
    g.sessions.push(s);
  }
  return groups;
}

export const isTouch = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** `crypto.randomUUID` only exists in secure contexts; the dev server is plain http over Tailscale. */
export const uid = (): string =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** `/home/me/work/x` -> `~/work/x` (only when it really is under the home directory). */
export function tilde(path: string, home?: string | null): string {
  if (!home) return path;
  const h = home.replace(/\/+$/, "");
  if (!h) return path;
  if (path === h) return "~";
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

/** `100.64.0.1:8787` from a full URL; falls back to the input. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}
