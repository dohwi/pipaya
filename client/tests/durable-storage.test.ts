import { describe, expect, test, beforeEach } from "bun:test";
import {
	getAllDurableSettings,
	rehydrateSettingsFromDurable,
	removeDurableSetting,
	setDurableSetting,
	snapshotSettingsToDurable,
} from "../src/lib/durable-storage";

describe("durable settings persistence", () => {
	// Mock in-memory indexedDB for testing in Node/Bun environment
	const mockStore = new Map<string, string>();
	const mockLs = new Map<string, string>();

	beforeEach(() => {
		mockStore.clear();
		mockLs.clear();

		// Polyfill indexedDB with in-memory mock if needed
		globalThis.indexedDB = {
			open: () => {
				const req: any = {
					result: {
						objectStoreNames: { contains: () => true },
						createObjectStore: () => {},
						transaction: () => {
							const tx: any = {
								objectStore: () => ({
									put: (val: string, key: string) => {
										mockStore.set(key, val);
									},
									delete: (key: string) => {
										mockStore.delete(key);
									},
									openCursor: () => {
										const entries = [...mockStore.entries()];
										let idx = 0;
										const cursorReq: any = {};
										queueMicrotask(() => {
											const step = () => {
												if (idx < entries.length) {
													const [key, value] = entries[idx]!;
													cursorReq.result = {
														key,
														value,
														continue: () => {
															idx++;
															step();
														},
													};
													cursorReq.onsuccess?.();
												} else {
													cursorReq.result = null;
													cursorReq.onsuccess?.();
												}
											};
											step();
										});
										return cursorReq;
									},
								}),
								oncomplete: null,
								onerror: null,
							};
							queueMicrotask(() => tx.oncomplete?.());
							return tx;
						},
					},
					onsuccess: null,
					onerror: null,
					onupgradeneeded: null,
				};
				setTimeout(() => {
					req.onsuccess?.();
				}, 0);
				return req;
			},
		} as any;

		// Mock localStorage
		globalThis.localStorage = {
			getItem: (k: string) => mockLs.get(k) ?? null,
			setItem: (k: string, v: string) => {
				mockLs.set(k, v);
			},
			removeItem: (k: string) => {
				mockLs.delete(k);
			},
			get length() {
				return mockLs.size;
			},
			key: (i: number) => [...mockLs.keys()][i] ?? null,
			clear: () => mockLs.clear(),
		} as any;
	});

	test("sets, gets, and removes durable settings", async () => {
		await setDurableSetting("pipaya.theme", '"dark"');
		await setDurableSetting("pipaya.sound", "true");

		const all = await getAllDurableSettings();
		expect(all["pipaya.theme"]).toBe('"dark"');
		expect(all["pipaya.sound"]).toBe("true");

		await removeDurableSetting("pipaya.sound");
		const after = await getAllDurableSettings();
		expect(after["pipaya.sound"]).toBeUndefined();
		expect(after["pipaya.theme"]).toBe('"dark"');
	});

	test("snapshots localStorage pipaya.* settings into durable storage", async () => {
		mockLs.set("pipaya.servers", JSON.stringify([{ id: "s1", name: "Main", baseUrl: "http://127.0.0.1:8787", token: "tok" }]));
		mockLs.set("pipaya.theme", "dark");
		mockLs.set("pipaya.keys", JSON.stringify({ resume: "Mod+O" }));
		mockLs.set("unrelated_key", "ignore_me");

		await snapshotSettingsToDurable();

		const durable = await getAllDurableSettings();
		expect(durable["pipaya.servers"]).toContain("Main");
		expect(durable["pipaya.theme"]).toBe("dark");
		expect(durable["pipaya.keys"]).toContain("Mod+O");
		expect(durable["unrelated_key"]).toBeUndefined();
	});

	test("rehydrates localStorage when servers are lost after update/wipe", async () => {
		// Populate durable backup first
		mockStore.set("pipaya.servers", JSON.stringify([{ id: "s1", name: "Main", baseUrl: "http://127.0.0.1:8787", token: "tok" }]));
		mockStore.set("pipaya.theme", "dark");
		mockStore.set("pipaya.sound", "true");
		mockStore.set("pipaya.volume2", "120");

		// Simulate empty localStorage after an update/identifier change
		mockLs.clear();

		const restored = await rehydrateSettingsFromDurable();
		expect(restored).toBe(true);

		// Verified restored keys in localStorage
		expect(mockLs.get("pipaya.servers")).toContain("Main");
		expect(mockLs.get("pipaya.theme")).toBe("dark");
		expect(mockLs.get("pipaya.sound")).toBe("true");
		expect(mockLs.get("pipaya.volume2")).toBe("120");
	});

	test("does not overwrite healthy localStorage", async () => {
		mockStore.set("pipaya.servers", JSON.stringify([{ id: "old", name: "Old", baseUrl: "http://old", token: "" }]));
		mockLs.set("pipaya.servers", JSON.stringify([{ id: "new", name: "New", baseUrl: "http://new", token: "" }]));

		const restored = await rehydrateSettingsFromDurable();
		expect(restored).toBe(false);
		expect(mockLs.get("pipaya.servers")).toContain("New");
	});
});
