import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NOTIFICATION_KINDS, NOTIFICATION_TRIGGERS, parseNotificationRule } from "../src/lib/notification-contract";

const server = readFileSync(new URL("../../server/src/notifications.ts", import.meta.url), "utf8");

describe("notification contract matches the server", () => {
	test("the kinds a notice can have", () => {
		const list = /export const NOTIFICATION_KINDS = \[([^\]]+)\] as const;/.exec(server)?.[1] ?? "";
		expect([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...NOTIFICATION_KINDS]);
	});

	test("the events a rule may wait for are the rows of the server's table", () => {
		const body = /export const NOTIFYING_EVENTS = \{([\s\S]*?)\n\} as const;/.exec(server)?.[1] ?? "";
		const keys = [...body.matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]);
		expect(keys.length).toBeGreaterThan(0);
		expect(keys).toEqual([...NOTIFICATION_TRIGGERS]);
	});

	test("a rule for any listed event is accepted, an unknown one is not", () => {
		for (const event of NOTIFICATION_TRIGGERS) expect(parseNotificationRule({ event, title: "t" })).toEqual({ event, title: "t" });
		expect(() => parseNotificationRule({ event: "message_end", title: "t" })).toThrow();
	});
});
