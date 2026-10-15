import { describe, expect, test } from "bun:test";
import { buildPairingLink, isLoopbackUrl, isPlainHttpOnOpenNetwork, parsePairingLink } from "../src/lib/pairing";

describe("connection link", () => {
	test("round-trips address, code and name", () => {
		const link = buildPairingLink("http://100.85.51.107:8787", "abcDEF123_-xyz", "집 서버");
		expect(link.startsWith("harness://connect?")).toBe(true);
		expect(parsePairingLink(link)).toEqual({ baseUrl: "http://100.85.51.107:8787", code: "abcDEF123_-xyz", name: "집 서버" });
	});
	test("the link never carries a token", () => {
		expect(buildPairingLink("https://h.example", "code-code-code")).not.toMatch(/token/i);
	});
	test("a bare address gets http:// and a trailing slash is dropped", () => {
		expect(parsePairingLink("harness://connect?u=100.1.2.3:8787/&c=abcdefgh12")?.baseUrl).toBe("http://100.1.2.3:8787");
	});
	test("anything else is not a connection link", () => {
		for (const bad of [
			"", "garbage", "https://connect?u=http://x&c=abcdefgh12", "harness://other?u=http://x&c=abcdefgh12",
			"harness://connect?c=abcdefgh12", "harness://connect?u=http://x", "harness://connect?u=http://x&c=short",
			"harness://connect?u=javascript:alert(1)&c=abcdefgh12", "harness://connect?u=ftp://x&c=abcdefgh12",
			"harness://connect?u=http://user:pw@x:1&c=abcdefgh12",
		]) expect(parsePairingLink(bad)).toBeNull();
	});
	test("an over-long name is cut", () => {
		expect(parsePairingLink(`harness://connect?u=http://x:1&c=abcdefgh12&n=${"a".repeat(200)}`)?.name).toHaveLength(40);
	});
	test("loopback addresses are recognised: a phone cannot reach them", () => {
		for (const u of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787", "http://0.0.0.0:1"]) expect(isLoopbackUrl(u)).toBe(true);
		for (const u of ["http://100.85.51.107:8787", "https://my.ts.net", "http://192.168.0.5:1"]) expect(isLoopbackUrl(u)).toBe(false);
	});
});

describe("plain http on an open network", () => {
	test("this machine, the LAN and Tailscale are not flagged", () => {
		for (const u of [
			"http://localhost:8787", "http://127.0.0.1:8787", "http://192.168.0.5:8787", "http://10.1.2.3:8787", "http://172.16.0.9:8787",
			"http://172.31.255.1:8787", "http://100.85.51.107:8787", "http://100.64.0.1:8787", "http://100.127.255.255:8787",
			"http://my-mac.local:8787", "http://box.tail1234.ts.net:8787", "http://nas:8787", "http://[::1]:8787", "http://[fd7a:115c::1]:8787",
		]) expect(isPlainHttpOnOpenNetwork(u), u).toBe(false);
	});
	test("a public address over http is flagged, over https it is not", () => {
		for (const u of ["http://203.0.113.9:8787", "http://example.com:8787", "http://172.32.0.1:8787", "http://100.128.0.1:8787", "http://11.0.0.1"]) {
			expect(isPlainHttpOnOpenNetwork(u), u).toBe(true);
		}
		expect(isPlainHttpOnOpenNetwork("https://example.com")).toBe(false);
		expect(isPlainHttpOnOpenNetwork("not a url")).toBe(false);
	});
});
