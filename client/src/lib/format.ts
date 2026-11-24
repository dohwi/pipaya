import { localeTag, t } from "./i18n";

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

/**
 * One Intl.DateTimeFormat per locale and option set, kept: `toLocaleTimeString` builds a new formatter on every call
 * (about 50 µs), which a transcript of a thousand message times paid on every render.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function fmt(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(locale, opts)));
  return f;
}
const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const FULL: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" };

/** The time of day a message was sent ("9:04 AM", "오전 9:04"); the day it belongs to is the divider above it (dayLabel). */
export const timeOfDay = (ts: number, locale?: string): string => fmt(locale, TIME).format(ts);

/**
 * Date and time formats, in the app's language (`localeTag()`), never the browser's: with the app set to English on a
 * Korean system a bare `toLocaleString()` printed "2026. 11. 19. 오후 3:04:05" in an English screen. `locale` is for tests.
 */
/** The whole date and time, for a tooltip or a "last run" line: "11/19/2026, 3:04:05 PM", "2026. 11. 19. 오후 3:04:05". */
export const fullTime = (ts: number, locale: string = localeTag()): string => fmt(locale, FULL).format(ts);

/** A day without the year: "Nov 19", "11월 19일". */
export const shortDate = (ts: number, locale: string = localeTag()): string => fmt(locale, { month: "short", day: "numeric" }).format(ts);

/** A day and a time without the year or seconds, for a tooltip: "Nov 19, 03:04 PM", "11월 19일 오후 03:04". */
export const shortDateTime = (ts: number, locale: string = localeTag()): string =>
  fmt(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(ts);

/** Local midnight of the day `ts` falls on: two times are on the same day when these match. */
export const dayStart = (ts: number): number => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * The heading of a day in a transcript: "오늘" / "어제", else the date with its weekday, and the year once it is not
 * this year's. Korean keeps the weekday in brackets with or without the year: Intl writes "10월 13일 (화)" but
 * "2025년 10월 18일 토", and the two stood one above the other in a long transcript.
 */
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtf(locale?: string): Intl.RelativeTimeFormat {
  const key = locale ?? "";
  let cached = rtfCache.get(key);
  if (!cached) {
    cached = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    rtfCache.set(key, cached);
  }
  return cached;
}

export function dayLabel(ts: number, locale?: string, now: number = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(ts)) / 86_400_000); // round: a DST day is 23 or 25 hours
  if (days === 0 || days === 1) return rtf(locale).format(-days, "day");
  const year = new Date(ts).getFullYear() !== new Date(now).getFullYear();
  if (year && (locale ?? localeTag()).startsWith("ko"))
    return `${fmt(locale, { year: "numeric", month: "long", day: "numeric" }).format(ts)} (${fmt(locale, { weekday: "short" }).format(ts)})`;
  return fmt(locale, { year: year ? "numeric" : undefined, month: "long", day: "numeric", weekday: "short" }).format(ts);
}

const MIN = 60_000;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/**
 * Whole clock minutes from `a` to `b` (12:00:30 → 12:01:05 is 1): relative labels count clock minutes, not elapsed
 * seconds, so they agree with the clock times shown beside them and all turn over together on the minute (minuteClock).
 */
export const clockMinutes = (a: number, b: number): number => Math.floor(b / MIN) - Math.floor(a / MIN);

const minuteOf = (ts: number) => Math.floor(ts / MIN);
const SIX_HOURS = 6 * 60; // in minutes: where a relative label gives way to a clock time

/**
 * The clock minute (minutes since the epoch) at which pastLabel / messageTime of `ts` next reads differently, or null
 * when only the day can change it (pastLabel's "오후 2:05" → "어제") or nothing can (a message's "오후 2:05").
 */
export function pastChange(ts: number, now: number): number | null {
  const m = clockMinutes(ts, now);
  if (m < 60) return minuteOf(ts) + Math.max(1, m + 1); // "방금" → "1분 전" → "2분 전" ...
  if (m < SIX_HOURS) return minuteOf(ts) + Math.min(SIX_HOURS, (Math.floor(m / 60) + 1) * 60); // the next hour
  return null;
}

/** The clock minute at which nextRunLabel of `ts` next reads differently, or null ("곧": it stays until the run). */
export function nextChange(ts: number, now: number): number | null {
  const m = clockMinutes(now, ts);
  if (m < 1) return null;
  if (m < SIX_HOURS) return minuteOf(now) + 1; // "2시간 30분 후" counts every minute
  return minuteOf(ts) - (SIX_HOURS - 1); // a clock time until it comes within 6 hours (midnight: `today`)
}

/**
 * When something happened, read at a glance: the one rule for past times across the app (a message, a chat's last
 * activity, a backup, a task's last run). The mirror of nextRunLabel (lib/schedules.ts) for future times.
 *  - the same clock minute: "방금"
 *  - under 1 hour: "N분 전" (clock minutes, see clockMinutes)
 *  - under 6 hours: "N시간 전"
 *  - earlier today: the time, "오후 2:05"
 *  - yesterday: "어제 오후 9:30"
 *  - within a week: the weekday and time, "수 오후 2:05"
 *  - this year: the date, "11월 15일"; before that with the year, "2025년 11월 15일"
 * `time: false` is for a list column that only needs the day: "어제", then "N일 전" for the week (a bare "수" read as a
 * riddle in a card corner), the date, and "2025년 11월" for another year.
 * The exact time stays in the tooltip (fullTime). `now` and `locale` are for tests and for a caller's clock (clock.now).
 */
export function pastLabel(ts: number, now: number = Date.now(), opts: { locale?: string; time?: boolean } = {}): string {
  const locale = opts.locale ?? localeTag();
  const withTime = opts.time ?? true;
  const mins = clockMinutes(ts, now);
  if (mins < 1) return t("방금"); // also a time slightly ahead of this device's clock
  if (mins < 60) return t("{n}분 전", { n: mins });
  if (mins < 6 * 60) return t("{n}시간 전", { n: Math.floor(mins / 60) });
  const at = new Date(ts);
  const today = new Date(now);
  const time = fmt(locale, TIME).format(ts);
  if (sameDay(at, today)) return time;
  const days = Math.round((dayStart(now) - dayStart(ts)) / 86_400_000); // round: a DST day is 23 or 25 hours
  if (days === 1) return withTime ? t("어제 {time}", { time }) : t("어제");
  if (days < 7) return withTime ? `${fmt(locale, { weekday: "short" }).format(ts)} ${time}` : t("{n}일 전", { n: days });
  if (at.getFullYear() === today.getFullYear()) return fmt(locale, { month: "short", day: "numeric" }).format(ts);
  return fmt(locale, withTime ? { year: "numeric", month: "short", day: "numeric" } : { year: "numeric", month: "short" }).format(ts);
}

/**
 * A message's time in a transcript: "방금" / "N분 전" / "N시간 전" while it is recent (pastLabel), then the time of day,
 * as the day headings above ("어제", "11월 15일 (일)") already say which day it was.
 */
export function messageTime(ts: number, now: number = Date.now(), locale: string = localeTag()): string {
  return clockMinutes(ts, now) < 6 * 60 ? pastLabel(ts, now, { locale }) : timeOfDay(ts, locale);
}

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
