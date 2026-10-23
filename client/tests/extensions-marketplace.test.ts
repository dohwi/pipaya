import { afterEach, describe, expect, test } from "bun:test";
import { cliCommand, compareVersions, fetchPackage, parseCatalog, safeUrl, sha256Hex, type MarketEntry } from "../src/lib/extensions/marketplace";

const pkg = { manifest: { id: "demo", name: "Demo", version: "1.0.0", sdkVersion: 1, permissions: [] }, code: "// demo" };
const body = JSON.stringify(pkg);
const entry = (over: Partial<MarketEntry> = {}): MarketEntry => ({
  id: "demo", kind: "client", name: "Demo", description: "", version: "1.0.0", source: { type: "url", url: "https://example.com/demo.json" }, ...over,
});
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const serve = (text: string, status = 200) => { globalThis.fetch = (async () => new Response(text, { status })) as typeof fetch; };

describe("parseCatalog", () => {
  test("keeps valid entries and drops the rest", () => {
    const c = parseCatalog({
      name: "m",
      extensions: [
        { id: "a", kind: "client", name: "A", version: "1.0.0", source: { type: "url", url: "https://x.dev/a.json" } },
        { id: "a", kind: "client", name: "dup", version: "1.0.0", source: { type: "url", url: "https://x.dev/a.json" } },
        { id: "Bad_Id", kind: "client", name: "B", version: "1.0.0", source: { type: "url", url: "https://x.dev/b.json" } },
        { id: "c", kind: "client", name: "C", version: "1.0.0", source: { type: "url", url: "http://evil.example/c.json" } },
        { id: "d", kind: "other", name: "D", version: "1.0.0", source: { type: "path", path: "x" } },
        { id: "e", kind: "server", name: "E", version: "0.1.0", source: { type: "path", path: "extensions/e" } },
      ],
    });
    expect(c.extensions.map(e => e.id)).toEqual(["a", "e"]);
  });
  test("rejects a non-catalog", () => {
    expect(() => parseCatalog(null)).toThrow();
    expect(() => parseCatalog({ name: "x" })).toThrow();
  });
  test("sha256 must be 64 hex characters", () => {
    const c = parseCatalog({ name: "m", extensions: [{ id: "a", kind: "client", name: "A", version: "1.0.0", source: { type: "url", url: "https://x.dev/a.json", sha256: "zz" } }] });
    expect((c.extensions[0]!.source as { sha256?: string }).sha256).toBeUndefined();
  });
});

test("safeUrl allows https and loopback http only", () => {
  expect(safeUrl("https://a.dev/x")).toBeDefined();
  expect(safeUrl("http://localhost:8080/x")).toBeDefined();
  expect(safeUrl("http://a.dev/x")).toBeUndefined();
  expect(safeUrl("javascript:alert(1)")).toBeUndefined();
  expect(safeUrl("nope")).toBeUndefined();
});

describe("fetchPackage", () => {
  test("installs a package whose hash matches", async () => {
    serve(body);
    const sha256 = await sha256Hex(new TextEncoder().encode(body).buffer as ArrayBuffer);
    const p = await fetchPackage(entry({ source: { type: "url", url: "https://example.com/demo.json", sha256 } }));
    expect(p.manifest.id).toBe("demo");
  });
  test("refuses a package whose hash differs", async () => {
    serve(body);
    await expect(fetchPackage(entry({ source: { type: "url", url: "https://example.com/demo.json", sha256: "0".repeat(64) } }))).rejects.toThrow();
  });
  test("refuses a package whose id differs from the catalog", async () => {
    serve(body);
    await expect(fetchPackage(entry({ id: "other" }))).rejects.toThrow();
  });
  test("refuses a failed download and server entries", async () => {
    serve("", 404);
    await expect(fetchPackage(entry())).rejects.toThrow();
    await expect(fetchPackage(entry({ kind: "server", source: { type: "path", path: "extensions/demo" } }))).rejects.toThrow();
  });
});

test("compareVersions and cliCommand", () => {
  expect(compareVersions("0.4.2", "0.4.1")).toBe(1);
  expect(compareVersions("0.4.1", "0.10.0")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(cliCommand(entry({ id: "guard" }))).toBe("bun scripts/market.ts install guard");
});
