import { describe, expect, test } from "bun:test";
import { ServerSettingsSync, type StoredSetting, type SyncApi, type SyncKey } from "../src/lib/server-settings";

/** An in-memory server with the same last-write-wins rule as server/src/client-settings.ts */
function fakeServer() {
	const data = new Map<string, StoredSetting>();
	const writes: { key: string; value: unknown; at: number; origin: string }[] = [];
	const state = { down: false };
	const api: SyncApi = {
		async clientSettings() {
			if (state.down) throw new Error("down");
			return { settings: Object.fromEntries(data) };
		},
		async clientSetting(key) {
			if (state.down) throw new Error("down");
			const v = data.get(key);
			if (!v) throw new Error("404");
			return v;
		},
		async putClientSetting(key, value, at, origin) {
			if (state.down) throw new Error("down");
			writes.push({ key, value, at, origin });
			const cur = data.get(key);
			if (cur && cur.updatedAt > at) return { ...cur, applied: false };
			data.set(key, { value, updatedAt: at });
			return { value, updatedAt: at, applied: true };
		},
	};
	return { data, writes, state, api };
}

function device(server: ReturnType<typeof fakeServer>, origin: string, clock: { t: number }, initial: { favModels?: unknown; extensions?: unknown } = {}) {
	const local: Record<string, unknown> = { ...initial };
	const storage = new Map<string, string>();
	const sync = new ServerSettingsSync({
		api: server.api,
		origin,
		storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
		storageKey: "meta",
		now: () => clock.t,
		debounceMs: 10,
		adapters: {
			favModels: { read: () => local.favModels, apply: (v) => void (local.favModels = v) },
			extensions: { read: () => local.extensions, apply: (v) => void (local.extensions = v) },
		},
	});
	return { local, sync, storage, edit: (key: SyncKey, value: unknown) => { local[key] = value; sync.changed(key); } };
}
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe("server settings sync", () => {
	test("first contact: a device's existing settings become the server's value", async () => {
		const s = fakeServer();
		const a = device(s, "A", { t: 100 }, { favModels: ["x"] });
		await a.sync.pull();
		expect(s.data.get("favModels")?.value).toEqual(["x"]);
	});

	test("first contact with nothing local uploads nothing and adopts the server's value", async () => {
		const s = fakeServer();
		s.data.set("favModels", { value: ["srv"], updatedAt: 50 });
		const b = device(s, "B", { t: 100 });
		await b.sync.pull();
		expect(b.local.favModels).toEqual(["srv"]);
		expect(s.writes).toHaveLength(0);
	});

	test("an edit uploads after the debounce, once, and the other device receives it", async () => {
		const s = fakeServer();
		const clock = { t: 1000 };
		const a = device(s, "A", clock);
		const b = device(s, "B", clock);
		await a.sync.pull();
		await b.sync.pull();
		a.edit("favModels", ["m1"]);
		a.edit("favModels", ["m1", "m2"]); // quick second edit coalesces into one upload
		await tick();
		expect(s.writes.filter((w) => w.key === "favModels")).toHaveLength(1);
		await b.sync.onEvent({ key: "favModels", updatedAt: 1000, origin: "A" });
		expect(b.local.favModels).toEqual(["m1", "m2"]);
		// B applying it must not bounce back to the server
		await tick();
		expect(s.writes.filter((w) => w.key === "favModels")).toHaveLength(1);
	});

	test("a device ignores the echo of its own write", async () => {
		const s = fakeServer();
		const a = device(s, "A", { t: 1 });
		await a.sync.pull();
		a.edit("favModels", ["only"]);
		await tick();
		await a.sync.onEvent({ key: "favModels", updatedAt: 1, origin: "A" });
		expect(a.local.favModels).toEqual(["only"]);
	});

	test("last write wins: an older offline edit loses to a newer change from another device", async () => {
		const s = fakeServer();
		const clock = { t: 1000 };
		const a = device(s, "A", clock);
		const b = device(s, "B", clock);
		await a.sync.pull();
		await b.sync.pull();
		s.state.down = true; // B goes offline and edits at t=1100
		clock.t = 1100;
		b.edit("favModels", ["from-b"]);
		await tick();
		s.state.down = false;
		s.data.set("favModels", { value: ["from-a"], updatedAt: 1200 }); // A edited later
		await b.sync.pull();
		expect(b.local.favModels).toEqual(["from-a"]);
		expect(s.data.get("favModels")?.value).toEqual(["from-a"]);
	});

	test("an offline edit that is the newest is uploaded on reconnect, and survives a restart", async () => {
		const s = fakeServer();
		const clock = { t: 1000 };
		const a = device(s, "A", clock);
		await a.sync.pull();
		s.state.down = true;
		clock.t = 2000;
		a.edit("favModels", ["offline"]);
		await tick();
		expect(s.data.get("favModels")?.value).not.toEqual(["offline"]);
		// "restart": a new engine over the same storage still knows the edit is unconfirmed
		const again = new ServerSettingsSync({
			api: s.api, origin: "A", storage: { getItem: (k) => a.storage.get(k) ?? null, setItem: (k, v) => void a.storage.set(k, v) }, storageKey: "meta", now: () => clock.t, debounceMs: 10,
			adapters: { favModels: { read: () => a.local.favModels, apply: (v) => void (a.local.favModels = v) } },
		});
		s.state.down = false;
		await again.pull();
		expect(s.data.get("favModels")).toEqual({ value: ["offline"], updatedAt: 2000 });
	});

	test("a failed pull leaves the local copy alone and throws", async () => {
		const s = fakeServer();
		const a = device(s, "A", { t: 1 }, { favModels: ["keep"] });
		s.state.down = true;
		await expect(a.sync.pull()).rejects.toThrow();
		expect(a.local.favModels).toEqual(["keep"]);
	});

	test("an edit made while an upload is in flight is not lost", async () => {
		const s = fakeServer();
		const clock = { t: 10 };
		const a = device(s, "A", clock);
		await a.sync.pull();
		const put = s.api.putClientSetting;
		s.api.putClientSetting = async (...args) => { await tick(30); return put(...args); };
		a.edit("favModels", ["one"]);
		await tick(20); // upload of "one" is now in flight
		clock.t = 20;
		a.edit("favModels", ["one", "two"]);
		await tick(150);
		expect(s.data.get("favModels")?.value).toEqual(["one", "two"]);
	});

	test("a change that turns out to be nothing does not hide another device's real change", async () => {
		const s = fakeServer();
		const clock = { t: 1000 };
		const a = device(s, "A", clock);
		const b = device(s, "B", clock);
		await a.sync.pull();
		await b.sync.pull();
		a.edit("extensions", ["pkg"]);
		await tick();
		await b.sync.onEvent({ key: "extensions", updatedAt: 1000, origin: "A" });
		clock.t = 5000;
		b.sync.changed("extensions"); // e.g. only switched an extension on: the shared list is the same
		await tick();
		expect(s.writes.filter((w) => w.key === "extensions")).toHaveLength(1);
		clock.t = 2000; // A then edits (its clock is earlier than B's no-op)
		a.edit("extensions", ["pkg", "more"]);
		await tick();
		await b.sync.onEvent({ key: "extensions", updatedAt: 2000, origin: "A" });
		expect(b.local.extensions).toEqual(["pkg", "more"]);
	});

	test("keys without an adapter and unknown keys are ignored", async () => {
		const s = fakeServer();
		const a = device(s, "A", { t: 1 });
		await a.sync.onEvent({ key: "theme", updatedAt: 5, origin: "B" });
		await a.sync.onEvent({ key: 7 });
		expect(a.local).toEqual({});
	});
});
