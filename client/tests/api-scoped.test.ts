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

describe("Api.send progress, cancellation, and clientRequestId", () => {
	const realXhr = globalThis.XMLHttpRequest;
	const installMockXhr = () => {
		const instances: {
			method: string;
			url: string;
			headers: Record<string, string>;
			body: string;
			status: number;
			statusText: string;
			responseText: string;
			aborted: boolean;
			upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void; onload?: () => void };
			onload?: () => void;
			onerror?: () => void;
			onabort?: () => void;
		}[] = [];
		globalThis.XMLHttpRequest = class {
			method = "";
			url = "";
			headers: Record<string, string> = {};
			body = "";
			status = 0;
			statusText = "";
			responseText = "";
			aborted = false;
			upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void; onload?: () => void } = {};
			onload?: () => void;
			onerror?: () => void;
			onabort?: () => void;
			constructor() { instances.push(this); }
			open(method: string, url: string) { this.method = method; this.url = url; }
			setRequestHeader(k: string, v: string) { this.headers[k] = v; }
			send(body: string) { this.body = body; }
			abort() { this.aborted = true; this.onabort?.(); }
		} as unknown as typeof XMLHttpRequest;
		return instances;
	};

	test("uses XHR when onProgress is passed, reports byte progress, sends clientRequestId, and resolves 202 JSON", async () => {
		const xhrs = installMockXhr();
		try {
			const api = new Api({ baseUrl: "http://srv", token: "tok" });
			const steps: [number, number][] = [];
			const pending = api.send("s1", "hi", "prompt", undefined, [{ name: "a.bin", data: "QUJD" }], {
				clientRequestId: "req-123",
				onProgress: (loaded, total) => steps.push([loaded, total]),
			});
			expect(xhrs).toHaveLength(1);
			const x = xhrs[0]!;
			expect(x.method).toBe("POST");
			expect(x.url).toBe("http://srv/sessions/s1/messages");
			expect(x.headers.Authorization).toBe("Bearer tok");
			expect(JSON.parse(x.body)).toMatchObject({ text: "hi", mode: "prompt", clientRequestId: "req-123" });

			x.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
			x.upload.onload?.();
			x.status = 202;
			x.responseText = JSON.stringify({ accepted: "prompt" });
			x.onload?.();

			expect(await pending).toEqual({ accepted: "prompt" });
			expect(steps).toEqual([[50, 100], [100, 100]]);
		} finally {
			globalThis.XMLHttpRequest = realXhr;
		}
	});

	test("aborts XHR upload on caller signal with AbortError and turns network errors into ApiError(0)", async () => {
		const xhrs = installMockXhr();
		try {
			const api = new Api({ baseUrl: "http://srv", token: "tok" });
			const ctl = new AbortController();
			const p1 = api.send("s1", "hi", "prompt", undefined, [{ name: "a.bin", data: "QUJD" }], {
				signal: ctl.signal,
				onProgress: () => {},
			});
			ctl.abort();
			expect(xhrs[0]!.aborted).toBe(true);
			await expect(p1).rejects.toHaveProperty("name", "AbortError");

			const p2 = api.send("s1", "hi", "prompt", undefined, [{ name: "a.bin", data: "QUJD" }], {
				onProgress: () => {},
			});
			xhrs[1]!.onerror?.();
			await expect(p2).rejects.toMatchObject({ status: 0, code: "network" });
		} finally {
			globalThis.XMLHttpRequest = realXhr;
		}
	});
});
