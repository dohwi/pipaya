import { LocalizedError, t } from "../i18n";
import { MAX_PACKAGE_BYTES, parsePackage, type ExtensionPackage } from "./schema";

/** The default public catalog. Another catalog can be typed in by the user. */
export const DEFAULT_MARKETPLACE_URL = "https://raw.githubusercontent.com/dohwi/pipaya-marketplace/main/index.json";
export const MAX_CATALOG_BYTES = 512 * 1024;

export type MarketSource =
  | { type: "path"; path: string }
  | { type: "url"; url: string; sha256?: string }
  /** A server extension: a GitHub repository, or the folder `dir` of one, pinned to the commit its tag pointed at. */
  | { type: "git"; repo: string; dir?: string; ref: string; commit: string };
export type MarketEntry = {
  id: string;
  kind: "server" | "client";
  name: string;
  description: string;
  /** Optional translations keyed by language tag (`ko`, `en`, `zh-CN`, ...). */
  descriptions?: Record<string, string>;
  version: string;
  author?: string;
  license?: string;
  homepage?: string;
  /** Server entries only: id of the client entry (same catalog) that must be installed on the device for this to work. */
  companion?: string;
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
    else if (s?.type === "git" && typeof s.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(s.repo) && typeof s.ref === "string" && /^\w[\w./-]*$/.test(s.ref) && typeof s.commit === "string" && /^[0-9a-f]{40}$/i.test(s.commit) && (s.dir === undefined || (typeof s.dir === "string" && /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*$/.test(s.dir)))) {
      source = { type: "git", repo: s.repo, ...(typeof s.dir === "string" ? { dir: s.dir } : {}), ref: s.ref, commit: s.commit.toLowerCase() };
    } else if (s?.type === "url" && typeof s.url === "string" && safeUrl(s.url)) {
      const sha = typeof s.sha256 === "string" && /^[0-9a-f]{64}$/i.test(s.sha256) ? s.sha256.toLowerCase() : undefined;
      source = { type: "url", url: s.url, ...(sha ? { sha256: sha } : {}) };
    }
    if (!source) continue;
    seen.add(id);
    const dr = e.descriptions && typeof e.descriptions === "object" && !Array.isArray(e.descriptions) ? Object.entries(e.descriptions as Record<string, unknown>) : [];
    const descriptions = Object.fromEntries(dr.filter(([k, v]) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(k) && typeof v === "string" && v.length > 0).slice(0, 20).map(([k, v]) => [k, (v as string).slice(0, 500)]));
    extensions.push({
      id, kind: e.kind, name: ename, version, source,
      description: typeof e.description === "string" ? e.description.slice(0, 500) : "",
      ...(Object.keys(descriptions).length ? { descriptions } : {}),
      ...(str(e.author, 80) ? { author: str(e.author, 80) } : {}),
      ...(str(e.license, 40) ? { license: str(e.license, 40) } : {}),
      ...(typeof e.homepage === "string" && safeUrl(e.homepage) ? { homepage: e.homepage } : {}),
      ...(e.kind === "server" && typeof e.companion === "string" && e.companion.length <= 80 && ID.test(e.companion) ? { companion: e.companion } : {}),
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

/** Owners whose extensions get the "official" badge: the owner of the default catalog. */
export const OFFICIAL_OWNERS = [new URL(DEFAULT_MARKETPLACE_URL).pathname.split("/")[1]!.toLowerCase()];

export type RepoLoc = { repo: string; ref: string; dir?: string };

/** Where an entry lives on GitHub: from its git source, else from a `github.com/<repo>/tree/<ref>/<dir>` homepage. */
export function repoLoc(entry: MarketEntry): RepoLoc | undefined {
  if (entry.source.type === "git") return { repo: entry.source.repo, ref: entry.source.commit, ...(entry.source.dir ? { dir: entry.source.dir } : {}) };
  const m = entry.homepage?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/);
  if (!m) return undefined;
  return { repo: m[1]!, ref: m[2] ?? "HEAD", ...(m[3] ? { dir: m[3] } : {}) };
}

export const isOfficial = (entry: MarketEntry): boolean => {
  const owner = repoLoc(entry)?.repo.split("/")[0]?.toLowerCase();
  return !!owner && OFFICIAL_OWNERS.includes(owner);
};

/** The description in the user's language: exact tag, then base language, then the default `description`. */
export function localizedDescription(entry: MarketEntry, lang: string): string {
  const d = entry.descriptions;
  const l = lang.toLowerCase();
  if (d) for (const k of [l, l.split("-")[0]!]) { const hit = Object.entries(d).find(([tag]) => tag.toLowerCase() === k); if (hit) return hit[1]; }
  return entry.description;
}

const STAR_KEY = "pipaya.marketplace.stars";
const STAR_TTL = 60 * 60 * 1000;
const starCache = new Map<string, Promise<number | undefined>>();
/** GitHub star count of a repository, cached for an hour (the unauthenticated API allows 60 calls an hour). */
export function fetchStars(repo: string): Promise<number | undefined> {
  let hit = starCache.get(repo);
  if (!hit) {
    hit = (async () => {
      let store: Record<string, { n: number; at: number }> = {};
      try { store = JSON.parse(localStorage.getItem(STAR_KEY) || "{}"); } catch { /* ignore */ }
      const cached = store[repo];
      if (cached && Date.now() - cached.at < STAR_TTL) return cached.n;
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer" });
        if (!res.ok) return cached?.n;
        const n = ((await res.json()) as { stargazers_count?: unknown }).stargazers_count;
        if (typeof n !== "number") return cached?.n;
        store[repo] = { n, at: Date.now() };
        try { localStorage.setItem(STAR_KEY, JSON.stringify(store)); } catch { /* ignore */ }
        return n;
      } catch { return cached?.n; }
    })();
    starCache.set(repo, hit);
  }
  return hit;
}

export const formatStars = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n);

/** Finds the client extension `id` in the marketplace catalog and downloads it, so a server extension can offer "install the client half". */
export async function fetchCompanion(id: string, signal?: AbortSignal): Promise<ExtensionPackage> {
  const entry = (await fetchCatalog(DEFAULT_MARKETPLACE_URL, signal)).extensions.find((e) => e.id === id && e.kind === "client");
  if (!entry) throw new LocalizedError(t("마켓플레이스에서 클라이언트 확장 ‘{id}’을 찾을 수 없습니다.", { id }));
  return fetchPackage(entry, signal);
}
