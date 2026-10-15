import { copyJson, httpOrigin, httpPath } from "./http";
import { LocalizedError, t } from "../i18n";
export interface JsonRequest { path: string; method?: "GET" | "PUT" | "POST" | "DELETE"; body?: unknown; headers?: { "If-Match"?: string } }
export interface JsonResponse { status: number; body: unknown }
const MAX = 4 * 1024 * 1024;
/** Generic JSON transport. Destination and optional Bearer token are user-owned extension settings. */
export class JsonTransport {
  private flights = new Map<string, AbortController>();
  async request(owner: string, settings: Record<string, unknown>, input: unknown, current: () => boolean): Promise<JsonResponse> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new LocalizedError(t("요청 객체가 필요합니다"));
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some(k => !["path", "method", "body", "headers"].includes(k))) throw new LocalizedError(t("알 수 없는 요청 필드"));
    const base = httpOrigin(settings.httpOrigin), path = httpPath(raw.path), method = raw.method ?? "GET";
    if (!["GET", "PUT", "POST", "DELETE"].includes(String(method))) throw new LocalizedError(t("지원하지 않는 HTTP 메서드"));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (settings.httpToken !== undefined && settings.httpToken !== "") {
      if (typeof settings.httpToken !== "string" || settings.httpToken.length > 2000 || /\s/.test(settings.httpToken)) throw new LocalizedError(t("잘못된 HTTP 인증 토큰"));
      headers.Authorization = `Bearer ${settings.httpToken}`;
    }
    if (raw.headers !== undefined) {
      if (!raw.headers || typeof raw.headers !== "object" || Array.isArray(raw.headers)) throw new LocalizedError(t("잘못된 헤더"));
      const h = raw.headers as Record<string, unknown>;
      if (Object.keys(h).some(k => k !== "If-Match") || (h["If-Match"] !== undefined && (typeof h["If-Match"] !== "string" || !/^"[a-zA-Z0-9._-]{1,80}"$/.test(h["If-Match"])))) throw new LocalizedError(t("If-Match만 허용합니다"));
      if (typeof h["If-Match"] === "string") headers["If-Match"] = h["If-Match"];
    }
    const body = raw.body === undefined ? undefined : JSON.stringify(copyJson(raw.body));
    if (method === "GET" && body !== undefined) throw new LocalizedError(t("GET 본문은 지원하지 않습니다"));
    if (body && new TextEncoder().encode(body).length > MAX) throw new LocalizedError(t("요청 크기 초과"));
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.flights.has(owner)) throw new LocalizedError(t("HTTP 요청이 진행 중입니다"));
    const controller = new AbortController(); this.flights.set(owner, controller);
    let reject!: (e: Error) => void;
    const abort = new Promise<never>((_, r) => { reject = r; });
    const cancelled = () => reject(new LocalizedError(t("요청 취소 또는 시간 초과")));
    controller.signal.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(() => controller.abort(), 3500);
    const work = (async () => {
      const response = await fetch(base + path, { method: String(method), headers, body, signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
      if (!response.body) return { status: response.status, body: null };
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { if (controller.signal.aborted) throw new LocalizedError(t("요청 취소")); const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX) throw new LocalizedError(t("응답 크기 초과")); chunks.push(value); }
        const bytes = new Uint8Array(size); let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
        return { status: response.status, body: size ? copyJson(JSON.parse(new TextDecoder().decode(bytes))) : null };
      } finally { controller.signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    })();
    try { const response = await Promise.race([work, abort]); if (!current() || controller.signal.aborted) throw new LocalizedError(t("요청 취소")); return response; }
    catch (e) { throw e instanceof LocalizedError ? e : new LocalizedError(t("HTTP 요청 실패")); }
    finally { clearTimeout(timer); controller.signal.removeEventListener("abort", cancelled); controller.abort(); if (this.flights.get(owner) === controller) this.flights.delete(owner); }
  }
  cleanup(owner: string) { this.flights.get(owner)?.abort(); this.flights.delete(owner); }
}
