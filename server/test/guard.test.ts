import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { RETIRED_EXTENSIONS } from "../src/extensions/retired.ts";
import { DEFAULT_GUARD_SETTINGS, GuardSettings, guardRefusal, normalizeGuardSettings } from "../src/guard.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

describe("Guard rules", () => {
	test("blocks destructive wipe, disk, fork, and permissions commands", () => {
		for (const cmd of [
			"rm -rf /",
			"rm -rf /*",
			"rm -fr /",
			"rm -r -f /",
			"rm --recursive --force /",
			"rm -rf ~",
			"rm -rf ~/",
			"rm -rf ~/*",
			"rm -rf $HOME",
			"rm -rf $HOME/",
			"rm -rf $HOME/*",
			"sudo rm -rf /",
			"ls && rm -rf /",
			"rm --no-preserve-root -rf /tmp/x",
			"mkfs.ext4 /dev/sda1",
			"dd if=/dev/zero of=/dev/sda bs=1M",
			"dd if=img of=/dev/nvme0n1",
			"cat img > /dev/sda",
			":(){ :|:& };:",
			"chmod -R 777 /",
			"chmod 777 -R /",
			"chown -R nobody ~",
		]) {
			expect(guardRefusal(cmd)).not.toBeNull();
		}
	});

	test("allows ordinary commands", () => {
		for (const cmd of [
			"rm -rf ./dist",
			"rm -rf /tmp/build",
			"rm -rf ~/tmp",
			"rm -rf $HOME/tmp",
			"rm -r /",
			"rm -f /",
			"chmod 644 /etc/hosts",
			"chmod -R 755 ./src",
			"chown -R user:group /var/www/app",
			"dd if=/dev/zero of=./disk.img bs=1M count=10",
			"echo hello > /tmp/out",
			"ls -la",
		]) {
			expect(guardRefusal(cmd)).toBeNull();
		}
	});

	test("respects per-group toggles and normalizes partial settings", () => {
		expect(guardRefusal("rm -rf /", { wipe: false })).toBeNull();
		expect(guardRefusal("mkfs.ext4 /dev/sda1", { wipe: false })).not.toBeNull();
		expect(guardRefusal("mkfs.ext4 /dev/sda1", { disk: false })).toBeNull();
		expect(guardRefusal(":(){ :|:& };:", { fork: false })).toBeNull();
		expect(guardRefusal("chmod -R 777 /", { permissions: false })).toBeNull();

		expect(normalizeGuardSettings(undefined)).toEqual(DEFAULT_GUARD_SETTINGS());
		expect(normalizeGuardSettings({ wipe: "no", disk: 0, fork: false })).toEqual({
			wipe: true,
			disk: true,
			fork: false,
			permissions: true,
		});
	});

	test("stays linear on long inputs (ReDoS guard)", () => {
		const started = performance.now();
		for (const cmd of [
			`chmod ${"-v ".repeat(400)} /tmp/x`,
			`chown ${"--verbose ".repeat(400)} /tmp/x`,
			`rm ${"-f ".repeat(400)} /tmp/x`,
			`echo ${"a".repeat(20_000)}`,
		]) {
			expect(guardRefusal(cmd)).toBeNull();
		}
		expect(performance.now() - started).toBeLessThan(100);
	});
});

describe("GuardSettings & routes", () => {
	let app: App;
	let dir: string;
	let ws: string;
	let upstream: ReturnType<typeof startEchoUpstream>;

	const api = async (method: any, url: string, payload?: unknown) => {
		const res = await app.server.inject({
			method,
			url,
			headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
			...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
		});
		return { status: res.statusCode, json: res.body ? res.json() : undefined };
	};
	const idle = async (id: string) => {
		for (let i = 0; i < 300; i++) {
			if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
			await Bun.sleep(20);
		}
		throw new Error("never idle");
	};
	const runBash = async (command: string) => {
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: `!bash ${JSON.stringify({ command })}` });
		await idle(id);
		const result = (await api("GET", `/sessions/${id}/messages`)).json.messages
			.map((m: any) => m.message)
			.find((m: any) => m.role === "toolResult" && m.toolName === "bash");
		const text = JSON.stringify(result?.content ?? "");
		return { blocked: text.includes("refused by guard"), text };
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-guard-"));
		ws = join(dir, "ws");
		mkdirSync(ws);
		// Simulate an old guard extension's saved settings to verify one-time seed migration, and ensure retired copy is skipped.
		const oldDir = join(dir, "extensions", "guard");
		mkdirSync(oldDir, { recursive: true });
		writeFileSync(join(oldDir, "settings.json"), JSON.stringify({ fork: false }));
		writeFileSync(join(oldDir, "index.ts"), "export default () => {};");
		upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
		app = await buildApp(cfg, { strictResponses: true, home: dir });
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	});

	afterAll(async () => {
		await app.close();
		upstream.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("retires the old guard extension without loading it", async () => {
		expect(RETIRED_EXTENSIONS.has("guard")).toBe(true);
		const exts = (await api("GET", "/server-extensions")).json.extensions;
		expect(exts.some((e: any) => e.name === "guard")).toBe(false);
	});

	test("seeds once from legacy settings file and enforces live toggles on bash tool calls", async () => {
		const initial = await api("GET", "/guard");
		expect(initial.status).toBe(200);
		expect(initial.json.settings).toEqual({ wipe: true, disk: true, fork: false, permissions: true });
		expect(initial.json.defaults).toEqual(DEFAULT_GUARD_SETTINGS());

		expect((await runBash("echo ok-1")).blocked).toBe(false);
		expect((await runBash("rm -rf /")).blocked).toBe(true);
		expect((await runBash("chmod 777 -R /")).blocked).toBe(true);
		expect((await runBash("chmod 644 /etc/hostname")).blocked).toBe(false);

		const updated = await api("PUT", "/guard", { wipe: false, disk: true, fork: true, permissions: true });
		expect(updated.status).toBe(200);
		expect(updated.json.settings).toEqual({ wipe: false, disk: true, fork: true, permissions: true });

		// Live toggle takes effect immediately without restart: fork bomb is now blocked, wipe check is off.
		expect((await runBash(":(){ :|:& };:")).blocked).toBe(true);
		expect((await runBash("rm -rf /")).blocked).toBe(false);

		const reread = await api("GET", "/guard");
		expect(reread.json.settings).toEqual({ wipe: false, disk: true, fork: true, permissions: true });
	});

	test("GuardSettings.check returns refusal prefix and fails closed", () => {
		const db = openDb(":memory:");
		const g = new GuardSettings(db);
		expect(g.check("rm -rf /")).toBe("refused by guard: deletes the whole disk or home directory");
		expect(g.check("ls -la")).toBeNull();
		g.set({ wipe: false, disk: true, fork: true, permissions: true });
		expect(g.check("rm -rf /")).toBeNull();
		db.close();
	});
});
