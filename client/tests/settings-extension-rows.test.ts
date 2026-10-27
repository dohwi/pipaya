import { describe, expect, test } from "bun:test";
import { extensionRows, type UpdateLookup } from "../src/lib/settings-extension-rows";

const none: UpdateLookup = {
	clientIds: () => new Set(),
	serverNames: new Set(),
	missingServerFor: () => undefined,
	clientName: () => undefined,
};
const client = (id: string, scope: "device" | "server" = "device") => ({ id, name: `Client ${id}`, scope, live: true });

describe("extensionRows", () => {
	test("a device tab lists this device's extensions only, the last one ends the trunk", () => {
		const rows = extensionRows("device", [client("a"), client("b"), client("c", "server")], null, none);
		expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
		expect(rows.map((r) => r.end)).toEqual([false, true]);
	});

	test("an empty list has no rows", () => {
		expect(extensionRows("device", [], null, none)).toEqual([]);
		expect(extensionRows("server", [], [], none)).toEqual([]);
	});

	test("the server tab lists the open server's extensions, named by title when it has one", () => {
		const rows = extensionRows("server", [], [{ name: "git", title: "Git tools" }, { name: "plain" }], none);
		expect(rows.map((r) => [r.id, r.name])).toEqual([["srv:git", "Git tools"], ["srv:plain", "plain"]]);
	});

	test("a server extension whose client half is missing says so and offers its install", () => {
		const [row] = extensionRows("server", [], [{ name: "git", companion: "git-ui" }], { ...none, clientName: (id) => (id === "git-ui" ? "Git panel" : undefined) });
		expect(row?.half).toBe(true);
		expect(row?.paired).toBe(true);
		expect(row?.partner).toBe("Git panel");
		expect(row?.link).toEqual({ tab: "extensions", id: null, install: "git-ui" });
	});

	test("a pair stays flat: the client half follows its server extension", () => {
		const rows = extensionRows("server", [client("git-ui", "server")], [{ name: "git", companion: "git-ui" }, { name: "other" }], none);
		expect(rows.map((r) => r.id)).toEqual(["srv:git", "git-ui", "srv:other"]);
		expect(rows[0]?.half).toBe(false);
		expect(rows[1]).toMatchObject({ paired: true, partner: "git", link: { tab: "srvext", id: "srv:git" } });
	});

	test("a client extension on this device is marked as paired with its server half, wherever that is listed", () => {
		const rows = extensionRows("device", [client("git-ui")], [{ name: "git", title: "Git tools", companion: "git-ui" }], none);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ paired: true, partner: "Git tools", link: { tab: "srvext", id: "srv:git" } });
	});

	test("a client extension that needs a server half it does not have is half-working", () => {
		const updates: UpdateLookup = { ...none, missingServerFor: (id) => (id === "a" ? { id: "git", name: "Git tools" } : undefined) };
		const [row] = extensionRows("device", [client("a")], null, updates);
		expect(row).toMatchObject({ half: true, paired: true, partner: "Git tools", link: { tab: "srvext", id: null } });
	});

	test("updates are marked from the lookup, per scope", () => {
		const updates: UpdateLookup = { ...none, clientIds: (scope) => new Set(scope === "device" ? ["a"] : []), serverNames: new Set(["git"]) };
		expect(extensionRows("device", [client("a"), client("b")], null, updates).map((r) => r.update)).toEqual([true, false]);
		expect(extensionRows("server", [], [{ name: "git" }, { name: "x" }], updates).map((r) => r.update)).toEqual([true, false]);
	});
});
