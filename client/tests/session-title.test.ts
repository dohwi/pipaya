import { expect, test } from "bun:test";
import { sessionTitle } from "../src/lib/session-title";

test("untitled marker shows as the localized default; real titles pass through", () => {
	expect(sessionTitle("New session")).toBe(sessionTitle(undefined));
	expect(sessionTitle("")).toBe(sessionTitle(null));
	expect(sessionTitle("fix login")).toBe("fix login");
});
