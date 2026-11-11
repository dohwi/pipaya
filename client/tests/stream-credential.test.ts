import { afterEach, describe, expect, test } from "bun:test";
import { Api } from "../src/lib/api";

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;
afterEach(() => {
	globalThis.fetch = realFetch;
	globalThis.EventSource = realEventSource;
});

/** Answers `POST /stream-tickets` with what `reply` returns and records every request. */
function serve(reply: () => Response | Promise<Response>) {
	const seen: { url: string; auth: string | null }[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
		return reply();
	}) as unknown as typeof fetch;
	return seen;
}
/** Records the URL each EventSource is opened with. */
function sources() {
	const opened: { url: string; closed: boolean; onerror?: () => void }[] = [];
	globalThis.EventSource = class {
		closed = false;
		onerror?: () => void;
		constructor(public url: string) { opened.push(this); }
		addEventListener() {}
		close() { this.closed = true; }
	} as unknown as typeof EventSource;
	return opened;
}
const tick = () => Bun.sleep(0);

describe("the credential a header-less connection carries", () => {
	test("is a one-time ticket, asked for with the token in a header", async () => {
		const seen = serve(() => Response.json({ ticket: "a b+c", expiresAt: 1 }));
		const api = new Api({ baseUrl: "http://srv", token: "secret" });
		expect(await api.streamCredential()).toBe("ticket=a%20b%2Bc");
		expect(seen).toEqual([{ url: "http://srv/stream-tickets", auth: "Bearer secret" }]);
	});
	test("a new ticket is asked for every time: one opens one connection", async () => {
		let n = 0;
		const seen = serve(() => Response.json({ ticket: `t${++n}`, expiresAt: 1 }));
		const api = new Api({ baseUrl: "http://srv", token: "secret" });
		expect(await api.streamCredential()).toBe("ticket=t1");
		expect(await api.streamCredential()).toBe("ticket=t2");
		expect(seen.length).toBe(2);
	});
	test("a server from before tickets gets the token, and is not asked again", async () => {
		const seen = serve(() => Response.json({ error: { code: "not_found", message: "route not found" } }, { status: 404 }));
		const api = new Api({ baseUrl: "http://srv", token: "se cret" });
		expect(await api.streamCredential()).toBe("token=se%20cret");
		expect(await api.streamCredential()).toBe("token=se%20cret");
		expect(seen.length).toBe(1);
	});
	test("any other failure is not papered over with the token", async () => {
		serve(() => Response.json({ error: { code: "unauthorized", message: "missing or invalid token" } }, { status: 401 }));
		const api = new Api({ baseUrl: "http://srv", token: "secret" });
		await expect(api.streamCredential()).rejects.toMatchObject({ status: 401 });
		globalThis.fetch = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
		await expect(api.streamCredential()).rejects.toMatchObject({ code: "network" });
	});
});

describe("the event stream", () => {
	test("opens with the ticket and never puts the token in its URL", async () => {
		serve(() => Response.json({ ticket: "tk", expiresAt: 1 }));
		const opened = sources();
		const stop = new Api({ baseUrl: "http://srv", token: "secret" }).subscribe({ onEvent() {} }, 7);
		expect(opened.length).toBe(0); // not before the ticket is here
		await tick();
		expect(opened.length).toBe(1);
		expect(opened[0]!.url).toContain("/events?after=7&");
		expect(opened[0]!.url).toContain("ticket=tk");
		expect(opened[0]!.url).not.toContain("secret");
		stop();
		expect(opened[0]!.closed).toBe(true);
	});
	test("reports an error when no ticket can be had, so the caller retries", async () => {
		serve(() => Response.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 }));
		const opened = sources();
		let errors = 0;
		new Api({ baseUrl: "http://srv", token: "secret" }).subscribe({ onEvent() {}, onError: () => errors++ }, 0);
		await tick();
		expect(opened.length).toBe(0);
		expect(errors).toBe(1);
	});
	test("unsubscribing before the ticket arrives opens nothing", async () => {
		serve(() => Response.json({ ticket: "tk", expiresAt: 1 }));
		const opened = sources();
		let errors = 0;
		new Api({ baseUrl: "http://srv", token: "secret" }).subscribe({ onEvent() {}, onError: () => errors++ }, 0)();
		await tick();
		expect(opened.length).toBe(0);
		expect(errors).toBe(0);
	});
	test("a dropped stream is reported once", async () => {
		serve(() => Response.json({ ticket: "tk", expiresAt: 1 }));
		const opened = sources();
		let errors = 0;
		new Api({ baseUrl: "http://srv", token: "secret" }).subscribe({ onEvent() {}, onError: () => errors++ }, 0);
		await tick();
		opened[0]!.onerror?.();
		opened[0]!.onerror?.();
		expect(errors).toBe(1);
		expect(opened[0]!.closed).toBe(true);
	});
});
