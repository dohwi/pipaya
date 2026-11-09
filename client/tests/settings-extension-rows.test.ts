import { describe, expect, test } from "bun:test";
import { extensionRows, type UpdateLookup } from "../src/lib/settings-extension-rows";

const none: UpdateLookup = {
	clientIds: () => new Set(),
	serverNames: new Set(),
	missingServerFor: () => undefined,
	clientName: () => undefined,
};
const client = (id: string) => ({ id, name: `Client ${id}`, live: true });

describe("extensionRows", () => {
	test("the list ends at its last row", () => {
		const rows = extensionRows([client("a"), client("b")], null, none);
		expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
		expect(rows.map((r) => r.end)).toEqual([false, true]);
	});

	test("an empty list has no rows", () => {
		expect(extensionRows([], null, none)).toEqual([]);
		expect(extensionRows([], [], none)).toEqual([]);
	});

	test("the server's own extensions are listed, named by title when it has one", () => {
		const rows = extensionRows([], [{ name: "git", title: "Git tools" }, { name: "plain" }], none);
		expect(rows.map((r) => [r.id, r.name])).toEqual([["srv:git", "Git tools"], ["srv:plain", "plain"]]);
	});

	test("a server extension whose client half is missing says so and offers its install", () => {
		const [row] = extensionRows([], [{ name: "git", companion: "git-ui" }], { ...none, clientName: (id) => (id === "git-ui" ? "Git panel" : undefined) });
		expect(row?.half).toBe(true);
		expect(row?.paired).toBe(true);
		expect(row?.partner).toBe("Git panel");
		expect(row?.link).toEqual({ tab: "srvext", id: null, install: "git-ui" });
	});

	test("a pair stays flat: the client half follows its server extension", () => {
		const rows = extensionRows([client("git-ui")], [{ name: "git", companion: "git-ui" }, { name: "other" }], none);
		expect(rows.map((r) => r.id)).toEqual(["srv:git", "git-ui", "srv:other"]);
		expect(rows[0]?.half).toBe(false);
		expect(rows[1]).toMatchObject({ paired: true, partner: "git", link: { tab: "srvext", id: "srv:git" } });
	});

	test("both halves of a pair are listed, each pointing at the other", () => {
		const rows = extensionRows([client("git-ui")], [{ name: "git", title: "Git tools", companion: "git-ui" }], none);
		expect(rows.map((r) => r.id)).toEqual(["srv:git", "git-ui"]);
		expect(rows[1]).toMatchObject({ paired: true, partner: "Git tools", link: { tab: "srvext", id: "srv:git" } });
		expect(rows[0]).toMatchObject({ paired: true, partner: "Client git-ui" });
	});

	test("a client extension that needs a server half it does not have is half-working", () => {
		const updates: UpdateLookup = { ...none, missingServerFor: (id) => (id === "a" ? { id: "git", name: "Git tools" } : undefined) };
		const [row] = extensionRows([client("a")], null, updates);
		expect(row).toMatchObject({ half: true, paired: true, partner: "Git tools", link: { tab: "srvext", id: null } });
	});

	test("updates are marked from the lookup", () => {
		const updates: UpdateLookup = { ...none, clientIds: () => new Set(["a"]), serverNames: new Set(["git"]) };
		expect(extensionRows([client("a"), client("b")], null, updates).map((r) => r.update)).toEqual([true, false]);
		expect(extensionRows([], [{ name: "git" }, { name: "x" }], updates).map((r) => r.update)).toEqual([true, false]);
	});
});
