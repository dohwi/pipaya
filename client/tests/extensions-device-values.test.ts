import { describe, expect, test } from "bun:test";
import { deviceValuesElsewhere } from "../src/lib/extensions/device-values";
import type { SettingField } from "../src/lib/extensions/schema";

const fields: SettingField[] = [
	{ key: "httpOrigin", type: "string", label: "주소" },
	{ key: "httpToken", type: "string", label: "관리 키", secret: true },
	{ key: "language", type: "string", label: "언어" },
];
const servers = [{ id: "a", name: "우분투" }, { id: "b", name: "로컬" }, { id: "c", name: "빈 서버" }];
const store = (lists: Record<string, unknown>) => ({ getItem: (k: string) => (k in lists ? JSON.stringify(lists[k]) : null) });
const entry = (settings: Record<string, unknown>) => [{ package: { manifest: { id: "quota-monitor" } }, settings }];

describe("device-only values kept for another server on this device", () => {
	const storage = store({
		"pipaya.extensions.v1.a": entry({ httpOrigin: "http://x", httpToken: "tok-a", language: "ko" }),
		"pipaya.extensions.v1.c": entry({ httpOrigin: "http://x" }),
	});

	test("offers the secret another server holds, and only the device-only fields", () => {
		const found = deviceValuesElsewhere("quota-monitor", fields, { httpOrigin: "http://x" }, "b", servers, storage);
		expect(found).toEqual([{ serverId: "a", serverName: "우분투", values: { httpToken: "tok-a" }, labels: ["관리 키"] }]);
	});
	test("nothing when this server already has a value: a key typed in here is never replaced", () => {
		expect(deviceValuesElsewhere("quota-monitor", fields, { httpToken: "mine" }, "b", servers, storage)).toEqual([]);
	});
	test("never this server itself, and nothing for another extension", () => {
		expect(deviceValuesElsewhere("quota-monitor", fields, {}, "a", servers, storage)).toEqual([]);
		expect(deviceValuesElsewhere("other", fields, {}, "b", servers, storage)).toEqual([]);
	});
	test("a broken stored list is skipped", () => {
		const bad = { getItem: (k: string) => (k === "pipaya.extensions.v1.a" ? "{not json" : null) };
		expect(deviceValuesElsewhere("quota-monitor", fields, {}, "b", servers, bad)).toEqual([]);
	});
});
