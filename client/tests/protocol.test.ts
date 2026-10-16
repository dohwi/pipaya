import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compat, isClientTooOld, PROTOCOL_VERSION } from "../src/lib/protocol";

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
