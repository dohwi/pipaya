/**
 * `network`: an extension's own fetch to any http(s) URL. The user granted it knowing the extension can talk to any
 * server; what stays fixed is that the app's cookies and credentials never ride along (`credentials: "omit"`), that every
 * request ends with its extension (disable, safe mode), and that sizes and time are bounded. CORS is still the browser's:
 * a server that does not allow the app's origin cannot be read (use a server extension to reach it).
 *
 * Addresses in the user's own networks (loopback, LAN, tailnet: see local-address.ts) need `network-local` too, and a
 * redirect is followed by hand so that it cannot lead from a public address into one of those.
 */
import { LocalizedError, msg, t } from "../i18n";
import { isLocalUrl } from "./local-address";

export const NET_METHODS = Object.freeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const);
export const NET_LIMITS = Object.freeze({
  /** Request body, after base64 decoding. */
  requestBytes: 4 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  url: 8192,
  headers: 50,
  headerValue: 8192,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  /** In flight at once, per extension. */
  concurrent: 6,
});

export type NetBodyType = "auto" | "json" | "text" | "base64";
export interface NetRequest {
  url: string;
  method?: (typeof NET_METHODS)[number];
  headers?: Record<string, string>;
  /** A string is sent as is; any other value as JSON (with `content-type: application/json` unless given). */
  body?: unknown;
  /** `base64`: `body` is base64 and is sent as bytes (files, images). */
  bodyEncoding?: "text" | "base64";
  /** How to read the answer. `auto` (default): JSON when the server says so, else text. */
  responseType?: NetBodyType;
  /** Milliseconds, at most 60,000 (default 30,000). */
  timeout?: number;
}
export interface NetResponse {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Hops followed before giving up, like a browser's own limit but lower. */
const MAX_REDIRECTS = 5;
const LOCAL_REFUSED = msg("내부망(이 컴퓨터·LAN·Tailscale) 주소에 요청하려면 network-local 권한이 필요합니다");

const KEYS = new Set(["url", "method", "headers", "body", "bodyEncoding", "responseType", "timeout"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

function bad(message: string): never { throw new LocalizedError(message); }

/** Checks and normalises what an extension asked for. Exported for tests. */
export function parseNetRequest(input: unknown): Required<Pick<NetRequest, "url" | "method" | "responseType" | "timeout">> & { headers: Record<string, string>; body?: BodyInit } {
  if (!input || typeof input !== "object" || Array.isArray(input)) bad(t("요청 객체가 필요합니다"));
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) bad(t("알 수 없는 요청 필드"));
  if (typeof raw.url !== "string" || raw.url.length > NET_LIMITS.url) bad(t("올바르지 않은 URL입니다"));
  let url: URL;
  try { url = new URL(raw.url); } catch { bad(t("올바르지 않은 URL입니다")); }
  if (url.protocol !== "http:" && url.protocol !== "https:") bad(t("http(s) 주소만 요청할 수 있습니다"));
  if (url.username || url.password) bad(t("URL에 사용자 정보를 넣을 수 없습니다. Authorization 헤더를 쓰세요"));
  const method = raw.method === undefined ? "GET" : raw.method;
  if (typeof method !== "string" || !(NET_METHODS as readonly string[]).includes(method)) bad(t("지원하지 않는 HTTP 메서드"));
  const headers: Record<string, string> = {};
  if (raw.headers !== undefined) {
    if (!raw.headers || typeof raw.headers !== "object" || Array.isArray(raw.headers)) bad(t("잘못된 헤더"));
    const entries = Object.entries(raw.headers as Record<string, unknown>);
    if (entries.length > NET_LIMITS.headers) bad(t("헤더가 너무 많습니다"));
    for (const [name, value] of entries) {
      if (!HEADER_NAME.test(name) || typeof value !== "string" || value.length > NET_LIMITS.headerValue || /[\r\n\0]/.test(value)) bad(t("잘못된 헤더"));
      headers[name] = value;
    }
  }
  const responseType = raw.responseType === undefined ? "auto" : raw.responseType;
  if (!["auto", "json", "text", "base64"].includes(responseType as string)) bad(t("responseType은 auto, json, text, base64 중 하나입니다"));
  const timeout = raw.timeout === undefined ? NET_LIMITS.defaultTimeoutMs : raw.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > NET_LIMITS.maxTimeoutMs) bad(t("timeout은 1~60000ms입니다"));
  let body: BodyInit | undefined;
  if (raw.body !== undefined && raw.body !== null) {
    if (method === "GET" || method === "HEAD") bad(t("GET·HEAD 요청에는 본문을 보낼 수 없습니다"));
    const encoding = raw.bodyEncoding ?? "text";
    if (encoding !== "text" && encoding !== "base64") bad(t("bodyEncoding은 text 또는 base64입니다"));
    if (encoding === "base64") {
      if (typeof raw.body !== "string") bad(t("base64 본문은 문자열이어야 합니다"));
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(raw.body as string), c => c.charCodeAt(0)); } catch { bad(t("base64 본문이 올바르지 않습니다")); }
      if (bytes.byteLength > NET_LIMITS.requestBytes) bad(t("요청 크기 초과"));
      body = bytes as BodyInit;
    } else if (typeof raw.body === "string") {
      if (new TextEncoder().encode(raw.body).byteLength > NET_LIMITS.requestBytes) bad(t("요청 크기 초과"));
      body = raw.body;
    } else {
      let json: string;
      try { json = JSON.stringify(raw.body); } catch { bad(t("본문을 JSON으로 바꿀 수 없습니다")); }
      if (new TextEncoder().encode(json).byteLength > NET_LIMITS.requestBytes) bad(t("요청 크기 초과"));
      if (!Object.keys(headers).some(h => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
      body = json;
    }
  }
  return { url: url.href, method: method as NetRequest["method"] & string, headers, responseType: responseType as NetBodyType, timeout, ...(body === undefined ? {} : { body }) } as ReturnType<typeof parseNetRequest>;
}

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export class NetClient {
  private flights = new Map<string, Set<AbortController>>();
  constructor(private fetcher: typeof fetch = (...a) => fetch(...a)) {}

  /** `local`: the extension also holds `network-local` and may reach the user's own networks. */
  async request(owner: string, input: unknown, current: () => boolean, local = false): Promise<NetResponse> {
    const req = parseNetRequest(input);
    const allowed = (url: URL) => local || !isLocalUrl(url);
    if (!allowed(new URL(req.url))) throw new LocalizedError(t(LOCAL_REFUSED));
    const mine = this.flights.get(owner) ?? new Set<AbortController>();
    if (mine.size >= NET_LIMITS.concurrent) throw new LocalizedError(t("동시 요청은 확장당 최대 {n}개입니다", { n: NET_LIMITS.concurrent }));
    const controller = new AbortController();
    mine.add(controller); this.flights.set(owner, mine);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, req.timeout);
    // Settle on abort even when the fetch implementation ignores the signal (a stuck WebView fetch, a test double).
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new LocalizedError(timedOut ? t("요청 시간이 초과되었습니다") : t("요청이 취소되었습니다")));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      let response!: Response;
      let url = req.url, method: string = req.method, body = req.body;
      for (let hop = 0; ; hop++) {
        try {
          response = await Promise.race([this.fetcher(url, { method, headers: req.headers, body, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "manual" }), aborted]);
        } catch {
          throw new LocalizedError(timedOut ? t("요청 시간이 초과되었습니다") : controller.signal.aborted ? t("요청이 취소되었습니다") : t("요청 실패 (네트워크 또는 CORS)"));
        }
        // A browser hides a cross-origin redirect (`opaqueredirect`, status 0): it cannot be checked, so it is not followed.
        if (response.type === "opaqueredirect") throw new LocalizedError(t("다른 주소로 넘기는 응답은 따라갈 수 없습니다"));
        const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (!location) break;
        if (hop >= MAX_REDIRECTS) throw new LocalizedError(t("리디렉션이 너무 많습니다"));
        let next: URL;
        try { next = new URL(location, url); } catch { throw new LocalizedError(t("올바르지 않은 URL입니다")); }
        if (next.protocol !== "http:" && next.protocol !== "https:") throw new LocalizedError(t("http(s) 주소만 요청할 수 있습니다"));
        if (!allowed(next)) throw new LocalizedError(t(LOCAL_REFUSED));
        await response.body?.cancel().catch(() => {});
        // 303, and 301/302 after a POST, continue as GET without a body (what browsers do).
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
        url = next.href;
      }
      const bytes = await Promise.race([this.read(response, controller.signal), aborted]);
      if (!current()) throw new LocalizedError(t("요청이 취소되었습니다"));
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => { headers[name] = value; });
      const type = req.responseType === "auto" ? (/\bjson\b/i.test(headers["content-type"] ?? "") ? "json" : "text") : req.responseType;
      let answer: unknown = null;
      if (method !== "HEAD" && bytes.byteLength) {
        if (type === "base64") answer = base64(bytes);
        else {
          const text = new TextDecoder().decode(bytes);
          if (type === "json") { try { answer = JSON.parse(text); } catch { if (req.responseType === "json") throw new LocalizedError(t("응답이 JSON이 아닙니다")); answer = text; } }
          else answer = text;
        }
      }
      return { status: response.status, statusText: response.statusText, ok: response.ok, url: response.url || url, headers, body: answer };
    } catch (e) {
      if (timedOut) throw new LocalizedError(t("요청 시간이 초과되었습니다"));
      throw e instanceof LocalizedError ? e : new LocalizedError(t("요청 실패 (네트워크 또는 CORS)"));
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      mine.delete(controller);
      if (!mine.size && this.flights.get(owner) === mine) this.flights.delete(owner);
    }
  }

  private async read(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > NET_LIMITS.responseBytes) throw new LocalizedError(t("응답이 너무 큽니다"));
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw new LocalizedError(t("요청이 취소되었습니다"));
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > NET_LIMITS.responseBytes) throw new LocalizedError(t("응답이 너무 큽니다"));
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  }

  /** Ends every request of an extension (disable, safe mode, delete). */
  cleanup(owner: string) {
    for (const c of this.flights.get(owner) ?? []) c.abort();
    this.flights.delete(owner);
  }
}
