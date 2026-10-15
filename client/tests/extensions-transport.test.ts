import { afterEach, expect, test } from "bun:test";
import { JsonTransport } from "../src/lib/extensions/transport";
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
test("destination and Bearer token come only from extension settings; arbitrary headers denied", async () => {
  const t = new JsonTransport();
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://example.test/resource");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer own-token");
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
    return Response.json({ error: "conflict" }, { status: 409 });
  }) as typeof fetch;
  const settings = { httpOrigin: "https://example.test", httpToken: "own-token" };
  expect(await t.request("example.ext", settings, { path: "/resource", method: "PUT", body: { data: 1 }, headers: { "If-Match": '"0"' } }, () => true)).toEqual({ status: 409, body: { error: "conflict" } });
  await expect(t.request("example.ext", settings, { path: "//evil.test" }, () => true)).rejects.toThrow();
  await expect(t.request("example.ext", settings, { path: "/resource", headers: { Authorization: "steal" } }, () => true)).rejects.toThrow();
  await expect(t.request("example.ext", settings, { path: "/resource", origin: "https://evil.test" }, () => true)).rejects.toThrow();
});
test("cleanup cancels requests and rejects stale responses", async () => {
  const t = new JsonTransport(); let signal: AbortSignal | null = null;
  globalThis.fetch = ((_url, init) => { signal = init?.signal as AbortSignal; return new Promise(() => {}); }) as typeof fetch;
  const pending = t.request("example.ext", { httpOrigin: "https://example.test" }, { path: "/data" }, () => true);
  t.cleanup("example.ext"); await expect(pending).rejects.toThrow("취소"); expect(signal!.aborted).toBe(true);
});
