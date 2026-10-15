import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVENT_TYPES } from "../src/lib/api";

// EventSource only delivers the event names it was told about. A name the server sends but this list lacks
// is dropped without any error: that is how "notification" once never reached the app.
//
// The server's definitions are read as text rather than imported: CI installs dependencies for the client only,
// and importing server code would need the server's packages as well.
const serverEventNames = (): string[] => {
	const src = readFileSync(resolve(__dirname, "../../server/src/schemas.ts"), "utf-8");
	const body = src.slice(src.indexOf("export const EVENTS"));
	return [...body.matchAll(/^\t\t?(?:\{ )?type: "([a-z_]+)"/gm)].map((m) => m[1]!);
};

/** Events the app has no use for yet. Listing one here is a decision, not an oversight. */
const NOT_USED = ["extension_settings_updated"];

test("the server's event list can be read (guards the check below from passing on nothing)", () => {
	const names = serverEventNames();
	expect(names.length).toBeGreaterThan(10);
	expect(names).toContain("notification");
	expect(names).toContain("client_settings_updated");
});

test("the client listens for every event the server can send", () => {
	const missing = serverEventNames().filter((t) => !EVENT_TYPES.includes(t) && !NOT_USED.includes(t));
	expect(missing).toEqual([]);
});
