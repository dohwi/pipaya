import { LocalizedError, t } from "../i18n";
import { MAX_PACKAGE_BYTES, parsePackage, type ExtensionPackage } from "./schema";

/** The default public catalog. Another catalog can be typed in by the user. */
export const DEFAULT_MARKETPLACE_URL = "https://raw.githubusercontent.com/dohwi/pipaya-marketplace/main/index.json";
export const MAX_CATALOG_BYTES = 512 * 1024;

export type MarketSource = { type: "path"; path: string } | { type: "url"; url: string; sha256?: string };
export type MarketEntry = {
  id: string;
  kind: "server" | "client";
  name: string;
  description: string;
  version: string;
  author?: string;
  license?: string;
  homepage?: string;
  source: MarketSource;
};
export type MarketCatalog = { name: string; description?: string; extensions: MarketEntry[] };

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** Accept only https (plus http for loopback while developing). */
export function safeUrl(value: string): URL | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return url;
  return undefined;
}

/** Read a catalog defensively: an entry that does not fit is left out, never trusted. */
export function parseCatalog(input: unknown): MarketCatalog {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LocalizedError(t("마켓플레이스 형식이 올바르지 않습니다."));
  const raw = input as Record<string, unknown>;
  const name = str(raw.name, 80);
  if (!name || !Array.isArray(raw.extensions)) throw new LocalizedError(t("마켓플레이스 형식이 올바르지 않습니다."));
  const seen = new Set<string>();
  const extensions: MarketEntry[] = [];
  for (const item of raw.extensions.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const id = str(e.id, 80), ename = str(e.name, 80), version = str(e.version, 80);
    if (!id || !ID.test(id) || seen.has(id) || !ename || !version) continue;
    if (e.kind !== "server" && e.kind !== "client") continue;
    const s = e.source as Record<string, unknown> | undefined;
    let source: MarketSource | undefined;
    if (s?.type === "path" && str(s.path, 200)) source = { type: "path", path: s.path as string };
    else if (s?.type === "url" && typeof s.url === "string" && safeUrl(s.url)) {
      const sha = typeof s.sha256 === "string" && /^[0-9a-f]{64}$/i.test(s.sha256) ? s.sha256.toLowerCase() : undefined;
      source = { type: "url", url: s.url, ...(sha ? { sha256: sha } : {}) };
    }
    if (!source) continue;
    seen.add(id);
    extensions.push({
      id, kind: e.kind, name: ename, version, source,
      description: typeof e.description === "string" ? e.description.slice(0, 500) : "",
      ...(str(e.author, 80) ? { author: str(e.author, 80) } : {}),
      ...(str(e.license, 40) ? { license: str(e.license, 40) } : {}),
      ...(typeof e.homepage === "string" && safeUrl(e.homepage) ? { homepage: e.homepage } : {}),
    });
  }
  return { name, ...(str(raw.description, 300) ? { description: str(raw.description, 300) } : {}), extensions };
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function readLimited(res: Response, limit: number): Promise<ArrayBuffer> {
  if (!res.ok) throw new LocalizedError(t("다운로드하지 못했습니다 ({status})", { status: res.status }));
  const buf = await res.arrayBuffer();
  if (buf.byteLength > limit) throw new LocalizedError(t("파일이 너무 큽니다."));
  return buf;
}

export async function fetchCatalog(url: string, signal?: AbortSignal): Promise<MarketCatalog> {
  if (!safeUrl(url)) throw new LocalizedError(t("https 주소만 사용할 수 있습니다."));
  const res = await fetch(url, { signal, cache: "no-cache", credentials: "omit", referrerPolicy: "no-referrer" });
  const buf = await readLimited(res, MAX_CATALOG_BYTES);
  return parseCatalog(JSON.parse(new TextDecoder().decode(buf)));
}

/** Download a client extension, check its hash when the catalog gives one, and validate it as a package. */
export async function fetchPackage(entry: MarketEntry, signal?: AbortSignal): Promise<ExtensionPackage> {
  if (entry.kind !== "client" || entry.source.type !== "url") throw new LocalizedError(t("이 확장은 앱에서 설치할 수 없습니다."));
  const res = await fetch(entry.source.url, { signal, cache: "no-cache", credentials: "omit", referrerPolicy: "no-referrer" });
  const buf = await readLimited(res, MAX_PACKAGE_BYTES);
  if (entry.source.sha256 && (await sha256Hex(buf)) !== entry.source.sha256) throw new LocalizedError(t("패키지가 카탈로그의 해시와 다릅니다. 설치하지 않았습니다."));
  const pkg = parsePackage(JSON.parse(new TextDecoder().decode(buf)));
  if (pkg.manifest.id !== entry.id) throw new LocalizedError(t("패키지 ID가 카탈로그와 다릅니다. 설치하지 않았습니다."));
  return pkg;
}

/** `server` entries cannot be installed from the app: show the command that does it. */
export function cliCommand(entry: MarketEntry): string {
  return `bun scripts/market.ts install ${entry.id}`;
}

/** 1 when `a` is newer than `b`, -1 when older, 0 when equal (SemVer core, prerelease ignored). */
export function compareVersions(a: string, b: string): number {
  const n = (v: string) => v.split("-")[0]!.split(".").map(x => Number.parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  return 0;
}
