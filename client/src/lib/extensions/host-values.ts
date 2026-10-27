/**
 * Small pure helpers of the extension host: checking what an extension hands over, copying it as plain data, and running a
 * request under a hard deadline. No reactive state, so they can be read (and tested) on their own.
 */
import { LocalizedError, msg, t } from "../i18n";

export function string(value: unknown, max: number, label = msg("문자열")): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new LocalizedError(t("잘못된 {label}", { label: t(label) }));
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalizedError(t("객체가 필요합니다"));
  return value as Record<string, unknown>;
}
/** Run a request with a hard deadline, even if the fetch implementation ignores the abort signal. */
export async function within<T>(ms: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new LocalizedError(t("시간 초과"))); }, ms); });
  try { return await Promise.race([task(controller.signal), deadline]); } finally { clearTimeout(timer); }
}
export function plain(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/**
 * A plain-JSON copy. Deliberately JSON rather than structuredClone: extension settings come from extension code and must
 * stay JSON (undefined and functions dropped, the same shape the server stores), and a Svelte $state proxy cannot be
 * structured-cloned at all.
 */
export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
/** Best-effort id/name of a stored entry that failed to parse. */
export function identify(raw: unknown): { id?: string; name?: string } {
  const entry = plain(raw);
  const manifest = plain(plain(entry?.package)?.manifest) ?? plain(entry?.manifest);
  const out: { id?: string; name?: string } = {};
  if (typeof manifest?.id === "string" && manifest.id) out.id = manifest.id.slice(0, 80);
  if (typeof manifest?.name === "string" && manifest.name) out.name = manifest.name.slice(0, 80);
  return out;
}
export function localId(value: unknown): string {
  const id = string(value, 40, "ID");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new LocalizedError(t("ID는 소문자·숫자·하이픈만 사용할 수 있습니다"));
  return id;
}

/** Shortcuts are the user's own: they go into a settings file, but an extension asking for the settings never gets them. */
export function withoutKeybindings<T extends { keybindings?: unknown }>(doc: T, strip: boolean): Omit<T, "keybindings"> & Partial<Pick<T, "keybindings">> {
  if (!strip) return doc;
  const { keybindings: _omit, ...rest } = doc;
  return rest;
}
