import { describe, expect, test } from "bun:test";
import type { MutableModels } from "@earendil-works/pi-ai";
import { openDb } from "../src/db.ts";
import { deviceId, ProviderLogins } from "../src/provider-login.ts";

type Interaction = { signal: AbortSignal; notify(e: unknown): void; prompt(p: { type: string; message: string }): Promise<string> };

/** A models registry whose login runs `script` with the interaction the server hands it. */
function fakeModels(script: (i: Interaction, providerId: string) => Promise<void>, known = ["p", "q"]) {
	const auth = { oauth: {}, apiKey: { login: () => {} } };
	return {
		getProvider: (id: string) => (known.includes(id) ? { auth } : undefined),
		login: async (id: string, _type: string, i: Interaction) => script(i, id),
	} as unknown as MutableModels;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ProviderLogins", () => {
	test("an unknown provider is a 404 and a provider without that login a 400", () => {
		const logins = new ProviderLogins(fakeModels(async () => {}), () => {});
		expect(() => logins.start("nope", "oauth")).toThrow(/not found/i);
		const bare = { getProvider: () => ({ auth: {} }), login: async () => {} } as unknown as MutableModels;
		expect(() => new ProviderLogins(bare, () => {}).start("p", "oauth")).toThrow(/no OAuth login/);
	});

	test("a flow asks, is answered once, and finishes; the change callback fires", async () => {
		const changed: string[] = [];
		let got = "";
		const logins = new ProviderLogins(fakeModels(async (i) => { i.notify({ type: "progress" }); got = await i.prompt({ type: "text", message: "code?" }); }), (id) => void changed.push(id));
		const started = logins.start("p", "oauth");
		await tick();
		const open = logins.get(started.id);
		expect(open.status).toBe("running");
		expect(open.prompt).toMatchObject({ type: "text", message: "code?" });
		expect(open.events).toHaveLength(1);

		logins.answer(started.id, open.prompt!.id, "1234");
		await tick();
		expect(got).toBe("1234");
		expect(logins.get(started.id)).toMatchObject({ status: "done", prompt: null });
		expect(changed).toEqual(["p"]);
	});

	test("a stale or repeated answer is refused", async () => {
		const logins = new ProviderLogins(fakeModels(async (i) => { await i.prompt({ type: "text", message: "?" }); }), () => {});
		const { id } = logins.start("p", "oauth");
		await tick();
		const promptId = logins.get(id).prompt!.id;
		expect(() => logins.answer(id, promptId + 1, "x")).toThrow(/no longer open/);
		logins.answer(id, promptId, "x");
		await tick();
		expect(() => logins.answer(id, promptId, "again")).toThrow(/no longer open/);
	});

	test("cancel aborts a waiting flow and reports it as cancelled, not as an error", async () => {
		const logins = new ProviderLogins(fakeModels(async (i) => { await i.prompt({ type: "text", message: "?" }); }), () => {});
		const { id } = logins.start("p", "oauth");
		await tick();
		expect(logins.cancel(id).status).toBe("cancelled");
		await tick();
		expect(logins.get(id)).toMatchObject({ status: "cancelled", prompt: null });
		expect(logins.get(id).error).toBeUndefined();
	});

	test("a failing flow reports a short message", async () => {
		const logins = new ProviderLogins(fakeModels(async () => { throw new Error("x".repeat(900)); }), () => {});
		const { id } = logins.start("p", "oauth");
		await tick();
		const state = logins.get(id);
		expect(state.status).toBe("error");
		expect(state.error!.length).toBe(500);
	});

	test("starting a second login for the same provider cancels the first; another provider is left alone", async () => {
		const logins = new ProviderLogins(fakeModels(async (i) => { await i.prompt({ type: "text", message: "?" }); }), () => {});
		const first = logins.start("p", "oauth");
		const other = logins.start("q", "oauth");
		const second = logins.start("p", "oauth");
		await tick();
		expect(logins.get(first.id).status).toBe("cancelled");
		expect(logins.get(second.id).status).toBe("running");
		expect(logins.get(other.id).status).toBe("running");
		for (const f of [second, other]) logins.cancel(f.id);
	});

	test("only the newest 50 progress events are kept", async () => {
		const logins = new ProviderLogins(fakeModels(async (i) => { for (let n = 0; n < 80; n++) i.notify({ n }); }), () => {});
		const { id } = logins.start("p", "oauth");
		await tick();
		const events = logins.get(id).events as unknown as { n: number }[];
		expect(events).toHaveLength(50);
		expect(events[0]!.n).toBe(30);
	});

	test("an unknown login id is a 404", () => {
		expect(() => new ProviderLogins(fakeModels(async () => {}), () => {}).get("missing")).toThrow(/not found/i);
	});
});

describe("deviceId", () => {
	test("is created once and stays the same", () => {
		const db = openDb(":memory:");
		const a = deviceId(db);
		expect(a).toMatch(/^[0-9a-f-]{36}$/);
		expect(deviceId(db)).toBe(a);
	});
});

describe("deviceId with a damaged row", () => {
	test("a value that is not valid JSON is replaced instead of crashing the login", () => {
		const db = openDb(":memory:");
		db.query("INSERT INTO settings (key, data) VALUES ('device_id', '{oops')").run();
		const id = deviceId(db);
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(deviceId(db)).toBe(id);
	});
});
