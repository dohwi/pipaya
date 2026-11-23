import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Api, sendTimeoutMs } from "../src/lib/api";

/** A server that accepts requests and never answers: a tailnet peer that went silent. */
let server: ReturnType<typeof Bun.serve>;
let open = 0;
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			open++;
			return new Promise<Response>((resolve) => req.signal.addEventListener("abort", () => (open--, resolve(new Response(null)))));
		},
	});
});
afterAll(() => server.stop(true));

const until = async (ok: () => boolean) => {
	for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(10);
	return ok();
};

describe("Api.scoped", () => {
	test("cancelling the scope ends every request still waiting on a silent server", async () => {
		const ctl = new AbortController();
		const api = new Api({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" }).scoped(ctl.signal);
		const pending = [api.listSessions(10), api.health(), api.groups()].map((p) => p.then(() => "done", (e: Error) => e.name));
		expect(await until(() => open === 3)).toBe(true);
		ctl.abort();
		expect(await Promise.all(pending)).toEqual(["AbortError", "AbortError", "AbortError"]);
		expect(await until(() => open === 0)).toBe(true);
	});
	test("a request's own deadline still applies inside a scope", async () => {
		const api = new Api({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" }).scoped(new AbortController().signal);
		const err = await api.health(AbortSignal.timeout(50)).catch((e: Error) => e.name);
		expect(err).toBe("TimeoutError");
	});
	test("a scope already cancelled sends nothing", async () => {
		const ctl = new AbortController();
		ctl.abort();
		const before = open;
		const err = await new Api({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" }).scoped(ctl.signal).groups().catch((e: Error) => e.name);
		expect(err).toBe("AbortError");
		expect(open).toBe(before);
	});
	test("default request timeout turns a hung mutation into a network ApiError instead of hanging forever", async () => {
		const api = new Api({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" }, undefined, { timeoutMs: 60 });
		const err = await api.patchSession("s1", { closed: true }).catch((e) => e);
		expect(err).toMatchObject({ status: 0, code: "network" });
		expect(await until(() => open === 0)).toBe(true);
	});
	test("fetchFile respects its timeoutMs deadline instead of hanging forever", async () => {
		const api = new Api({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" });
		const err = await api.fetchFile("s1", "a.bin", undefined, { timeoutMs: 60 }).catch((e) => e);
		expect(err).toMatchObject({ status: 0, code: "network" });
		expect(await until(() => open === 0)).toBe(true);
	});
});

describe("sendTimeoutMs", () => {
	test("keeps 30 s for plain text and scales for large base64 attachments up to 10 min", () => {
		expect(sendTimeoutMs()).toBe(30_000);
		expect(sendTimeoutMs([], [])).toBe(30_000);
		expect(sendTimeoutMs([{ data: "" }], [{ data: "" }])).toBe(30_000);
		// ~15 MB base64 (~11 MB raw) -> 30s + ~103s
		const medium = sendTimeoutMs(undefined, [{ data: "a".repeat(15 * 1024 * 1024) }]);
		expect(medium).toBeGreaterThan(120_000);
		expect(medium).toBeLessThan(150_000);
		// Huge payload caps cleanly at 10 minutes
		expect(sendTimeoutMs(undefined, [{ data: "a".repeat(140 * 1024 * 1024) }])).toBe(10 * 60_000);
	});
});
