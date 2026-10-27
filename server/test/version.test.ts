import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { SelfUpdater, type Run } from "../src/self-update.ts";
import { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION, SERVER_VERSION } from "../src/version.ts";

const TOKEN = "version-test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

describe("version handshake", () => {
	let app: App;
	let dir: string;
	let base: string;
	let installs = 0;
	let restarts = 0;
	let running = 0;
	const fetched = NEW;

	/** A fake git: HEAD is OLD (until reset), the remote tip is `fetched`. */
	let head = OLD;
	const run: Run = async (cmd) => {
		const [, ...a] = cmd;
		const key = a.join(" ");
		if (key.startsWith("symbolic-ref")) return { code: 0, out: "main" };
		if (key === "rev-parse HEAD") return { code: 0, out: head };
		if (key.startsWith("ls-remote")) return { code: 0, out: `${fetched}\trefs/tags/latest` };
		if (key.startsWith("fetch")) return { code: 0, out: "" };
		if (key.startsWith("diff")) return { code: 0, out: "server/bun.lock" };
		if (key.startsWith("reset")) {
			head = a[a.length - 1]!;
			return { code: 0, out: "" };
		}
		return { code: 1, out: "unexpected" };
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-version-"));
		const root = join(dir, "repo");
		mkdirSync(join(root, ".git"), { recursive: true });
		mkdirSync(join(root, "server", "src"), { recursive: true });
		writeFileSync(join(root, "server", "src", "index.ts"), "");
		const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: TOKEN, workspaceRoot: join(dir, "ws"), logLevel: "silent" };
		app = await buildApp(cfg, {
			selfUpdate: {
				root,
				serverDir: join(root, "server"),
				env: { PIPAYA_SELF_UPDATE: "1" },
				run,
				install: async () => (installs++, true),
				restart: () => void restarts++,
				running: () => running,
				cacheMs: 0,
			},
		});
		const addr = await app.server.listen({ host: "127.0.0.1", port: 0 });
		base = addr.replace("0.0.0.0", "127.0.0.1");
	});
	afterAll(async () => {
		await app.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const call = async (method: string, path: string, headers: Record<string, string> = auth, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};

	test("/health tells anyone the versions, with and without a token", async () => {
		for (const headers of [{}, auth]) {
			const { json } = await call("GET", "/health", headers);
			expect(json.version).toBe(SERVER_VERSION);
			expect(json.protocol).toBe(PROTOCOL_VERSION);
			expect(json.minClientProtocol).toBe(MIN_CLIENT_PROTOCOL);
		}
	});

	test("the protocol constants are consistent", () => {
		expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
		expect(MIN_CLIENT_PROTOCOL).toBeLessThanOrEqual(PROTOCOL_VERSION);
	});

	test("a client that declares nothing, or a current protocol, is served", async () => {
		expect((await call("GET", "/tools")).status).toBe(200);
		expect((await call("GET", "/tools", { ...auth, "x-pipaya-protocol": String(PROTOCOL_VERSION) })).status).toBe(200);
	});

	test("a client below the minimum gets 426 with a reason, even with a good token", async () => {
		const r = await call("GET", "/tools", { ...auth, "x-pipaya-protocol": String(MIN_CLIENT_PROTOCOL - 1) });
		expect(r.status).toBe(426);
		expect(r.json.error.code).toBe("client_too_old");
		const q = await call("GET", `/events/types?protocol=${MIN_CLIENT_PROTOCOL - 1}`);
		expect(q.status).toBe(426);
	});

	test("an unreadable protocol value is ignored rather than trusted", async () => {
		expect((await call("GET", "/tools", { ...auth, "x-pipaya-protocol": "abc" })).status).toBe(200);
	});

	test("/health stays reachable for an old client, so it can read the versions and explain itself", async () => {
		const r = await call("GET", "/health", { "x-pipaya-protocol": "0" });
		expect(r.status).toBe(200);
	});

	test("the WebSocket hello carries the versions", async () => {
		const ws = new WebSocket(`${base.replace("http", "ws")}/ws?token=${TOKEN}`);
		const hello = await new Promise<any>((resolve, reject) => {
			ws.onmessage = (m) => resolve(JSON.parse(String(m.data)));
			ws.onerror = reject;
		});
		ws.close();
		expect(hello).toMatchObject({ type: "hello", version: SERVER_VERSION, protocol: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL });
	});

	describe("server self-update", () => {
		test("reports a newer commit on the tracked branch", async () => {
			const r = await call("GET", "/server/update");
			expect(r.status).toBe(200);
			expect(r.json).toMatchObject({ managed: true, ref: "main", current: OLD, latest: NEW, available: true });
		});

		test("needs the token", async () => {
			expect((await call("GET", "/server/update", {})).status).toBe(401);
			expect((await call("POST", "/server/update", {}, {})).status).toBe(401);
		});

		test("a paired device may not update the server", async () => {
			const code = (await call("POST", "/pairing", auth, {})).json.code;
			const redeemed = await call("POST", "/pairing/redeem", {}, { code, name: "phone" });
			const device = redeemed.json.token as string;
			expect((await call("POST", "/server/update", { authorization: `Bearer ${device}` }, {})).status).toBe(403);
		});

		test("refuses while a session is running, unless forced", async () => {
			running = 1;
			const r = await call("POST", "/server/update", auth, {});
			expect(r.status).toBe(409);
			expect(r.json.error.code).toBe("sessions_running");
			expect(restarts).toBe(0);
			expect(head).toBe(OLD);
			running = 0;
		});

		test("moves to the new commit, reinstalls and restarts", async () => {
			const r = await call("POST", "/server/update", auth, {});
			expect(r.status).toBe(200);
			expect(r.json).toMatchObject({ ok: true, from: OLD, to: NEW, restarting: true, fromVersion: SERVER_VERSION }); // the new version is named too (null when the release's package.json cannot be read)
			expect(head).toBe(NEW);
			expect(installs).toBe(1);
			expect(restarts).toBe(1);
		});

		test("says so when there is nothing newer", async () => {
			const r = await call("POST", "/server/update", auth, {});
			expect(r.status).toBe(409);
			expect(r.json.error.code).toBe("up_to_date");
		});
	});
});

describe("SelfUpdater", () => {
	const make = (over: Partial<ConstructorParameters<typeof SelfUpdater>[0]> = {}) => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-su-"));
		mkdirSync(join(dir, ".git"));
		mkdirSync(join(dir, "server", "src"), { recursive: true });
		writeFileSync(join(dir, "server", "src", "index.ts"), "");
		return { dir, u: new SelfUpdater({ root: dir, serverDir: join(dir, "server"), cacheMs: 0, ...over }) };
	};
	const fine: Run = async (cmd) => {
		const k = cmd.slice(1).join(" ");
		if (k.startsWith("symbolic-ref")) return { code: 0, out: "main" };
		if (k === "rev-parse HEAD") return { code: 0, out: OLD };
		if (k.startsWith("ls-remote")) return { code: 0, out: `${NEW}\trefs/tags/latest` };
		if (k.startsWith("diff")) return { code: 0, out: "server/bun.lock" };
		return { code: 0, out: "" };
	};

	test("is off when nothing would bring the process back", async () => {
		const { dir, u } = make({ env: {}, run: fine });
		expect((await u.status()).reason).toBe("unmanaged");
		await expect(u.apply()).rejects.toMatchObject({ code: "update_unavailable" });
		rmSync(dir, { recursive: true, force: true });
	});

	test("recognises systemd and launchd by the environment they set", async () => {
		for (const env of [{ INVOCATION_ID: "x" }, { XPC_SERVICE_NAME: "app.pipaya.server" }]) {
			const { dir, u } = make({ env, run: fine });
			expect((await u.status()).managed).toBe(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("PIPAYA_SELF_UPDATE=0 wins over a supervisor", async () => {
		const { dir, u } = make({ env: { INVOCATION_ID: "x", PIPAYA_SELF_UPDATE: "0" }, run: fine });
		expect((await u.status()).reason).toBe("disabled");
		rmSync(dir, { recursive: true, force: true });
	});

	test("names the versions, not only the commits, and reads the new one without checking it out", async () => {
		const calls: string[] = [];
		const run: Run = async (cmd, cwd, t) => {
			const k = cmd.slice(1).join(" ");
			calls.push(k);
			if (k.startsWith("fetch")) return { code: 0, out: "" };
			if (k === `show ${NEW}:server/package.json`) return { code: 0, out: JSON.stringify({ name: "pipaya-server", version: "0.5.0" }) };
			return fine(cmd, cwd, t);
		};
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run, version: "0.4.9" });
		expect(await u.status()).toMatchObject({ managed: true, available: true, currentVersion: "0.4.9", latestVersion: "0.5.0", current: OLD, latest: NEW });
		expect(calls.some((c) => c.startsWith("reset") || c.startsWith("checkout"))).toBe(false); // the tree stays as it is
		await u.status();
		expect(calls.filter((c) => c.startsWith("fetch")).length).toBe(1); // each release commit is read once
		rmSync(dir, { recursive: true, force: true });
	});

	test("when the version cannot be read the update is still offered, by commit", async () => {
		const broken: ((k: string) => { code: number; out: string } | null)[] = [
			(k) => (k.startsWith("fetch") ? { code: 128, out: "unable to access" } : null),
			(k) => (k.startsWith("show") ? { code: 128, out: "bad object" } : null),
			(k) => (k.startsWith("show") ? { code: 0, out: "{not json" } : null),
			(k) => (k.startsWith("show") ? { code: 0, out: JSON.stringify({ version: "latest" }) } : null), // not x.y.z
			(k) => (k.startsWith("show") ? { code: 0, out: JSON.stringify({ version: "1.2.3; echo hi" }) } : null),
		];
		for (const b of broken) {
			const run: Run = async (cmd, cwd, t) => b(cmd.slice(1).join(" ")) ?? fine(cmd, cwd, t);
			const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run, version: "0.4.9" });
			expect(await u.status()).toMatchObject({ managed: true, available: true, currentVersion: "0.4.9", latestVersion: null });
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("nothing is downloaded to name a version when the server is already current", async () => {
		const calls: string[] = [];
		const run: Run = async (cmd, cwd, t) => {
			calls.push(cmd.slice(1).join(" "));
			return cmd[1] === "ls-remote" ? { code: 0, out: `${OLD}\trefs/tags/latest` } : fine(cmd, cwd, t);
		};
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run, version: "0.4.9" });
		expect(await u.status()).toMatchObject({ available: false, currentVersion: "0.4.9", latestVersion: "0.4.9" });
		expect(calls.some((c) => c.startsWith("fetch"))).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	test("an update reports the versions it moved between", async () => {
		const run: Run = async (cmd, cwd, t) => {
			const k = cmd.slice(1).join(" ");
			if (k === `show ${NEW}:server/package.json`) return { code: 0, out: JSON.stringify({ version: "0.5.0" }) };
			return fine(cmd, cwd, t);
		};
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run, version: "0.4.9", install: async () => true, restart: () => {} });
		expect(await u.apply()).toEqual({ from: OLD, to: NEW, fromVersion: "0.4.9", toVersion: "0.5.0" });
		rmSync(dir, { recursive: true, force: true });
	});

	test("a fork can follow its own release tag and launchd label", async () => {
		const asked: string[] = [];
		const recording: Run = async (cmd, cwd, t) => {
			if (cmd[1] === "ls-remote") {
				asked.push(cmd[cmd.length - 1]!);
				return { code: 0, out: `${NEW}\t${cmd[cmd.length - 1]}` }; // the remote answers for whichever tag was asked
			}
			return fine(cmd, cwd, t);
		};
		const forked = make({ env: { XPC_SERVICE_NAME: "org.fork.server", PIPAYA_LAUNCHD_LABEL: "org.fork.server", PIPAYA_RELEASE_TAG: "stable" }, run: recording });
		expect((await forked.u.status()).managed).toBe(true);
		expect(asked).toEqual(["refs/tags/stable"]);
		const stock = make({ env: { XPC_SERVICE_NAME: "org.fork.server" }, run: recording });
		expect((await stock.u.status()).reason).toBe("unmanaged"); // another label is not ours unless told so
		const odd = make({ env: { INVOCATION_ID: "x", PIPAYA_RELEASE_TAG: "a b;rm" }, run: recording });
		await odd.u.status();
		expect(asked.at(-1)).toBe("refs/tags/latest"); // a malformed tag is ignored, never passed to git
		for (const x of [forked, stock, odd]) rmSync(x.dir, { recursive: true, force: true });
	});

	test("a detached HEAD (a pinned tag or commit) is never moved", async () => {
		const detached: Run = async (cmd) => (cmd[1] === "symbolic-ref" ? { code: 1, out: "" } : fine(cmd, "", 0));
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run: detached });
		expect((await u.status()).reason).toBe("detached");
		rmSync(dir, { recursive: true, force: true });
	});

	test("a directory without .git is reported as such", async () => {
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run: fine });
		rmSync(join(dir, ".git"), { recursive: true });
		expect((await u.status()).reason).toBe("not_git");
		rmSync(dir, { recursive: true, force: true });
	});

	test("an unreachable remote is a soft failure, not an exception", async () => {
		const offline: Run = async (cmd) => (cmd[1] === "ls-remote" ? { code: 128, out: "unable to access" } : fine(cmd, "", 0));
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run: offline });
		expect(await u.status()).toMatchObject({ managed: false, reason: "fetch_failed", current: OLD });
		rmSync(dir, { recursive: true, force: true });
	});

	test("skips the dependency install when package.json and bun.lock did not change", async () => {
		let installs = 0;
		const same: Run = async (cmd, cwd, t) => (cmd[1] === "diff" ? { code: 0, out: "" } : fine(cmd, cwd, t));
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run: same, install: async () => (installs++, true), restart: () => {} });
		await u.apply();
		expect(installs).toBe(0);
		rmSync(dir, { recursive: true, force: true });
	});

	test("a failed install restores the previous commit and does not restart", async () => {
		const resets: string[] = [];
		const tracking: Run = async (cmd, cwd, t) => {
			if (cmd[1] === "reset") resets.push(cmd[cmd.length - 1]!);
			return fine(cmd, cwd, t);
		};
		let restarted = false;
		let installs = 0;
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run: tracking, install: async () => ++installs > 1, restart: () => (restarted = true) });
		await expect(u.apply()).rejects.toMatchObject({ status: 502, code: "update_failed" });
		expect(installs).toBe(2); // the new dependencies failed, the old ones were put back
		expect(resets).toEqual([NEW, OLD]);
		expect(restarted).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	test("a restore that fails is reported as such, not as a restored version", async () => {
		const broken: Run = async (cmd, cwd, t) => (cmd[1] === "reset" && cmd[cmd.length - 1] === OLD ? { code: 1, out: "boom" } : fine(cmd, cwd, t));
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run: broken, install: async () => false, restart: () => {} });
		await expect(u.apply()).rejects.toMatchObject({ status: 500, code: "update_restore_failed" });
		rmSync(dir, { recursive: true, force: true });
	});

	test("local changes in the checkout stop the update before anything is touched", async () => {
		const resets: string[] = [];
		const edited: Run = async (cmd, cwd, t) => {
			if (cmd[1] === "reset") resets.push(cmd[cmd.length - 1]!);
			return cmd[1] === "status" ? { code: 0, out: " M server/src/app.ts" } : fine(cmd, cwd, t);
		};
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run: edited, install: async () => true, restart: () => {} });
		await expect(u.apply()).rejects.toMatchObject({ status: 409, code: "dirty_checkout" });
		expect(resets).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("two updates at once: the second is turned away", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const slow: Run = async (cmd, cwd, t) => (cmd[1] === "reset" ? (await gate, fine(cmd, cwd, t)) : fine(cmd, cwd, t));
		const { dir, u } = make({ env: { PIPAYA_SELF_UPDATE: "1" }, run: slow, install: async () => true });
		const first = u.apply();
		await Bun.sleep(20);
		await expect(u.apply()).rejects.toMatchObject({ code: "update_in_progress" });
		release();
		await first;
		rmSync(dir, { recursive: true, force: true });
	});
});
