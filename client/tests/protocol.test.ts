import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compareVersions, compat, isClientTooOld, PROTOCOL_VERSION, serverReleaseState } from "../src/lib/protocol";

const serverSrc = readFileSync(new URL("../../server/src/version.ts", import.meta.url), "utf8");
const serverConst = (name: string) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(serverSrc)?.[1]);

describe("protocol constants", () => {
	test("the client and the server agree on the protocol number", () => {
		expect(serverConst("PROTOCOL_VERSION")).toBe(PROTOCOL_VERSION);
	});
	test("this client is not below what the server in the same tree demands", () => {
		expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(serverConst("MIN_CLIENT_PROTOCOL"));
	});
	test("the header and query names match the server's", () => {
		expect(serverSrc).toContain('PROTOCOL_HEADER = "x-pipaya-protocol"');
		expect(serverSrc).toContain('PROTOCOL_QUERY = "protocol"');
	});
});

describe("compat", () => {
	test("same protocol is fine", () => {
		expect(compat({ version: "0.1.5", protocol: 1, minClientProtocol: 1 }, 1)).toBe("ok");
	});
	test("a server that wants a newer client means the app must be updated", () => {
		expect(compat({ protocol: 3, minClientProtocol: 2 }, 1)).toBe("update-app");
	});
	test("a server that is merely newer, but still serves this client, is fine", () => {
		expect(compat({ protocol: 2, minClientProtocol: 1 }, 1)).toBe("ok");
	});
	test("an older server, or one from before the handshake, means the server should be updated", () => {
		expect(compat({ protocol: 1, minClientProtocol: 1 }, 2)).toBe("update-server");
		expect(compat({}, 1)).toBe("update-server");
		expect(compat({ version: "0.1.0" }, 1)).toBe("update-server");
	});
	test("nothing is claimed before the server has been probed", () => {
		expect(compat(null)).toBe("ok");
		expect(compat(undefined)).toBe("ok");
	});
	test("the app being too old wins over the server being old", () => {
		expect(compat({ protocol: 1, minClientProtocol: 5 }, 2)).toBe("update-app");
	});
});

describe("426", () => {
	test("only the server's own refusal counts", () => {
		expect(isClientTooOld(426, "client_too_old")).toBe(true);
		expect(isClientTooOld(426, "other")).toBe(false);
		expect(isClientTooOld(401, "client_too_old")).toBe(false);
	});
});

describe("server release state", () => {
	test("compares major.minor.patch numerically", () => {
		expect(compareVersions("0.1.0", "0.2.1")).toBe(-1);
		expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
		expect(compareVersions("v0.2.1", "0.2.1-beta")).toBe(0);
		expect(compareVersions("dev", "0.2.1")).toBeNull();
	});
	test("a server behind the app is older, same or newer is current", () => {
		expect(serverReleaseState("0.1.0", "0.2.1")).toBe("older");
		expect(serverReleaseState("0.2.1", "0.2.1")).toBe("current");
		expect(serverReleaseState("0.3.0", "0.2.1")).toBe("current");
	});
	test("missing versions are unknown", () => {
		expect(serverReleaseState("", "0.2.1")).toBe("unknown");
		expect(serverReleaseState("0.2.1", "")).toBe("unknown");
	});
});
