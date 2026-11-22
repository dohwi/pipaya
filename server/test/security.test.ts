import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
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
		expect(createCorsPolicy("*").allowsAll).toBe(true);
		expect(extra.allowsAll).toBe(false);
		expect(policy.allowsAll).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("filesystem permissions", () => {
	test("loadConfig and openDb tighten permissive existing data directories and SQLite WAL/SHM files", () => {
		const root = mkdtempSync(join(tmpdir(), "pipaya-perms-"));
		try {
			const dataDir = join(root, "data");
			mkdirSync(dataDir, { mode: 0o755 });
			chmodSync(dataDir, 0o755);
			const cfg = loadConfig({ PIPAYA_DATA_DIR: dataDir });
			expect(statSync(dataDir).mode & 0o777).toBe(0o700);
			expect(statSync(join(dataDir, "token")).mode & 0o777).toBe(0o600);

			const db1 = openDb(cfg.dbPath);
			db1.close();
			chmodSync(cfg.dbPath, 0o644);
			const db2 = openDb(cfg.dbPath);
			for (const f of [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`]) {
				if (existsSync(f)) expect(statSync(f).mode & 0o777).toBe(0o600);
			}
			db2.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
