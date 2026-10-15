import { describe, expect, test } from "bun:test";
import { createCorsPolicy, redactUrl } from "../src/security.ts";

describe("redactUrl", () => {
	test("masks the token query value only", () => {
		expect(redactUrl("/events?token=abc123&types=a")).toBe("/events?token=[redacted]&types=a");
		expect(redactUrl("/ws?after=3&token=abc123")).toBe("/ws?after=3&token=[redacted]");
		expect(redactUrl("/sessions/x/events?TOKEN=abc#frag")).toBe("/sessions/x/events?TOKEN=[redacted]#frag");
		expect(redactUrl("/health")).toBe("/health");
		expect(redactUrl("/x?mytoken=keep")).toBe("/x?mytoken=keep");
	});
});

describe("createCorsPolicy", () => {
	const policy = createCorsPolicy(undefined);
	test("allows loopback, Tailscale, LAN, MagicDNS and Tauri", () => {
		for (const o of ["http://localhost:1420", "http://127.0.0.1:8787", "http://[::1]:1420", "http://100.64.0.1", "http://100.127.255.254:1420",
			"http://10.1.2.3", "http://172.16.0.1", "http://172.31.9.9", "http://192.168.1.10:3000", "https://box.tail1234.ts.net", "tauri://localhost", "https://tauri.localhost"]) {
			expect(policy.allows(o)).toBe(true);
		}
	});
	test("rejects public hosts, out-of-range IPs, missing and opaque origins", () => {
		for (const o of ["https://evil.example", "http://100.63.0.1", "http://100.128.0.1", "http://172.15.0.1", "http://172.32.0.1", "http://8.8.8.8",
			"http://localhost.evil.example", "null", "file://", "ftp://192.168.0.1", ""]) {
			expect(policy.allows(o)).toBe(false);
		}
		expect(policy.allows(undefined)).toBe(false);
	});
	test("PIPAYA_CORS_ORIGINS adds exact origins or '*'", () => {
		const extra = createCorsPolicy("https://app.example.com/, https://b.example.com");
		expect(extra.allows("https://app.example.com")).toBe(true);
		expect(extra.allows("https://b.example.com")).toBe(true);
		expect(extra.allows("https://c.example.com")).toBe(false);
		expect(createCorsPolicy("*").allows("https://anything.example")).toBe(true);
	});
});
