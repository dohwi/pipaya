import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Api } from "../src/lib/api";

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
});
