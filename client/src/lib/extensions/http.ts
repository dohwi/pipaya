/**
 * Generic, credential-free JSON GET for extensions.
 *
 * The origin comes only from the user's own extension settings (`httpOrigin`); the extension
 * supplies just a path. Nothing here knows what the server is or what the JSON means.
 */
import { LocalizedError, t } from "../i18n";

export const HTTP_MAX_BYTES = 2 * 1024 * 1024;
export const HTTP_TIMEOUT_MS = 3500;
export const HTTP_MIN_INTERVAL_MS = 2000;
export const HTTP_MAX_DEPTH = 32;
export const HTTP_MAX_PATH = 2048;
export const HTTP_MAX_INFLIGHT = 4;

const missingOrigin = () => new LocalizedError(t("설정에 httpOrigin이 필요합니다"));

/** Validate a user-supplied origin: pure http(s) origin, optional trailing "/", nothing else. */
export function httpOrigin(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw missingOrigin();
  if (input.length > 2048 || !/^https?:\/\/[^/?#\s\\@]+\/?$/.test(input)) throw new LocalizedError(t("httpOrigin은 http(s) 서버 주소(origin)여야 합니다"));
  let url: URL;
  try { url = new URL(input); } catch { throw new LocalizedError(t("httpOrigin이 올바르지 않습니다")); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin === "null") {
    throw new LocalizedError(t("httpOrigin이 올바르지 않습니다"));
  }
  return url.origin;
}

/** Validate an extension-supplied request path ("/x/y?query"). */
export function httpPath(input: unknown): string {
  const bad = () => new LocalizedError(t("올바르지 않은 요청 경로입니다"));
  if (typeof input !== "string" || input.length < 1 || input.length > HTTP_MAX_PATH) throw bad();
  if (input[0] !== "/" || input.startsWith("//")) throw bad();
  // Printable ASCII only: no control characters, whitespace, backslashes, or fragments.
  if (!/^[\x21-\x7e]+$/.test(input) || input.includes("\\") || input.includes("#")) throw bad();
  const path = input.split("?", 1)[0]!;
  for (const segment of path.split("/")) {
    const plain = segment.replace(/%2e/gi, ".");
    if (plain === ".." || plain === ".") throw bad();
  }
  if (/%(?:2f|5c)/i.test(path)) throw bad();
  return input;
}

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > HTTP_MAX_BYTES)) throw new LocalizedError(t("응답이 너무 큽니다"));
  if (!response.body) throw new LocalizedError(t("응답을 읽을 수 없습니다"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new LocalizedError(t("요청이 취소되었습니다"));
      const { value, done } = await reader.read();
      if (signal.aborted) throw new LocalizedError(t("요청이 취소되었습니다"));
      if (done) break;
      size += value.byteLength;
      if (size > HTTP_MAX_BYTES) throw new LocalizedError(t("응답이 너무 큽니다"));
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/** Deep-copy parsed JSON into fresh plain data, rejecting excessive nesting. */
export function copyJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (depth >= HTTP_MAX_DEPTH) throw new LocalizedError(t("응답 JSON의 중첩이 너무 깊습니다"));
  if (Array.isArray(value)) return value.map(item => copyJson(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      // defineProperty keeps a JSON "__proto__" key as plain data instead of changing the prototype.
      Object.defineProperty(out, key, { value: copyJson((value as Record<string, unknown>)[key], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  throw new LocalizedError(t("응답 JSON이 올바르지 않습니다"));
}

interface Flight { controller: AbortController; promise: Promise<unknown> }

/**
 * Per-extension reader. Calls for the same path while one is in flight share that request;
 * a new call for the same path within HTTP_MIN_INTERVAL_MS of the previous start is rejected
 * with a "too frequent" error (no cache). Different paths are independent (bounded count).
 */
export class HttpReader {
  private flights = new Map<string, Map<string, Flight>>();
  private starts = new Map<string, Map<string, number>>();
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args), private now = () => Date.now()) {}

  getJson(owner: string, origin: unknown, path: unknown, current: () => boolean): Promise<unknown> {
    const base = httpOrigin(origin);
    const safePath = httpPath(path);
    const url = base + safePath;
    if (new URL(url).origin !== base) throw new LocalizedError(t("올바르지 않은 요청 경로입니다"));

    const flights = this.flights.get(owner) ?? new Map<string, Flight>();
    this.flights.set(owner, flights);
    const running = flights.get(safePath);
    if (running) return running.promise;
    const starts = this.starts.get(owner) ?? new Map<string, number>();
    this.starts.set(owner, starts);
    const now = this.now();
    for (const [key, at] of starts) if (now - at >= HTTP_MIN_INTERVAL_MS) starts.delete(key);
    if (starts.has(safePath)) throw new LocalizedError(t("같은 경로를 너무 자주 요청했습니다. 잠시 후 다시 시도하세요"));
    if (flights.size >= HTTP_MAX_INFLIGHT) throw new LocalizedError(t("동시 요청이 너무 많습니다"));

    const controller = new AbortController();
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new LocalizedError(t("요청이 취소되었거나 시간이 초과되었습니다")));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const work = (async () => {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "GET", headers: { Accept: "application/json" }, credentials: "omit", redirect: "error",
          cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
        });
      } catch { throw new LocalizedError(t("서버에 연결할 수 없습니다")); }
      if (!response.ok) throw new LocalizedError(t("서버가 오류를 반환했습니다 ({status})", { status: Number.isInteger(response.status) ? response.status : 0 }));
      const body = await boundedText(response, controller.signal);
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new LocalizedError(t("응답이 올바른 JSON이 아닙니다")); }
      const copied = copyJson(parsed);
      if (!current() || controller.signal.aborted) throw new LocalizedError(t("요청이 취소되었습니다"));
      return copied;
    })();
    work.catch(() => {});
    const promise = Promise.race([work, aborted]).then(value => {
      if (!current()) throw new LocalizedError(t("요청이 취소되었습니다"));
      return value;
    }, (error: unknown) => {
      // Only our own sanitized messages ever reach the extension.
      throw error instanceof LocalizedError ? error : new LocalizedError(t("요청을 처리하지 못했습니다"));
    }).finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      if (flights.get(safePath)?.controller === controller) flights.delete(safePath);
    });
    flights.set(safePath, { controller, promise });
    starts.set(safePath, now);
    return promise;
  }

  /** Abort everything for an owner (disable, reload, safe mode, uninstall). */
  cleanup(owner: string) {
    for (const flight of this.flights.get(owner)?.values() ?? []) flight.controller.abort();
    this.flights.delete(owner);
    this.starts.delete(owner);
  }
}
