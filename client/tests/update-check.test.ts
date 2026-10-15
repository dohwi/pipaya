import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { APK_NAME, DOWNLOAD_PREFIX, fetchLatestRelease, isNewer, parseRelease, parseVersion } from "../src/lib/update-check";

const body = "Rolling client build from `main`.\n\nCommit: abc\nVersion: 0.1.12\nBuild: [GitHub Actions](https://example.test)";
const release = (over: Record<string, unknown> = {}) => ({
	body,
	assets: [{ name: APK_NAME, browser_download_url: `${DOWNLOAD_PREFIX}${APK_NAME}` }],
	...over,
});

describe("version comparison", () => {
	test("parses plain and v-prefixed versions only", () => {
		expect(parseVersion("0.1.12")).toEqual([0, 1, 12]);
		expect(parseVersion(" v1.2.3 ")).toEqual([1, 2, 3]);
		for (const bad of ["", "1.2", "1.2.3-beta", "a.b.c", "1.2.3.4"]) expect(parseVersion(bad)).toBeNull();
	});
	test("compares numerically, not as text", () => {
		expect(isNewer("0.1.10", "0.1.9")).toBe(true);
		expect(isNewer("0.2.0", "0.1.99")).toBe(true);
		expect(isNewer("1.0.0", "0.9.9")).toBe(true);
		expect(isNewer("0.1.9", "0.1.10")).toBe(false);
		expect(isNewer("0.1.6", "0.1.6")).toBe(false);
	});
	test("an unreadable version never counts as an update", () => {
		expect(isNewer("garbage", "0.1.0")).toBe(false);
		expect(isNewer("0.1.1", "")).toBe(false);
	});
});

describe("release parsing", () => {
	test("reads the version and the APK link", () => {
		expect(parseRelease(release())).toEqual({ version: "0.1.12", apkUrl: `${DOWNLOAD_PREFIX}${APK_NAME}` });
	});
	test("ignores an APK link that does not point at this repository's latest release", () => {
		const evil = release({ assets: [{ name: APK_NAME, browser_download_url: "https://evil.example/harness.apk" }] });
		expect(parseRelease(evil)).toEqual({ version: "0.1.12", apkUrl: null });
		const other = release({ assets: [{ name: APK_NAME, browser_download_url: "https://github.com/someone/else/releases/download/latest/x.apk" }] });
		expect(parseRelease(other)?.apkUrl).toBeNull();
	});
	test("rejects responses that are not our release", () => {
		for (const bad of [null, "x", {}, { body: 5 }, { body: "no version here" }, { body: "Version: latest" }]) expect(parseRelease(bad)).toBeNull();
	});
	test("a missing asset list still yields the version", () => {
		expect(parseRelease({ body })).toEqual({ version: "0.1.12", apkUrl: null });
	});
});

describe("fetching", () => {
	const reply = (status: number, payload: unknown) => (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
	test("returns the parsed release", async () => {
		expect((await fetchLatestRelease(reply(200, release()))).version).toBe("0.1.12");
	});
	test("fails on HTTP errors and unexpected bodies", async () => {
		await expect(fetchLatestRelease(reply(403, {}))).rejects.toThrow("403");
		await expect(fetchLatestRelease(reply(200, { body: "x" }))).rejects.toThrow("Unexpected");
	});
});

describe("updater configuration", () => {
	const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
	test("verifies updates with a public key and downloads over HTTPS from this repository", () => {
		const u = conf.plugins.updater;
		expect(u.pubkey).toMatch(/^[A-Za-z0-9+/=]{100,}$/);
		expect(u.endpoints).toEqual([`https://github.com/dohwi/pipaya/releases/download/latest/latest.json`]);
	});
	test("update artifacts are produced only by the release workflow, so local builds need no private key", () => {
		expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
		const workflow = readFileSync(new URL("../../.github/workflows/client-release.yml", import.meta.url), "utf8");
		expect(workflow).toContain('"createUpdaterArtifacts": True');
	});
	test("the updater is a desktop-only dependency and capability, so Android and iOS builds are unaffected", () => {
		const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
		expect(cargo).toMatch(/\[target\.'cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)'\.dependencies\][^[]*tauri-plugin-updater/);
		const desktop = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/desktop.json", import.meta.url), "utf8"));
		expect(desktop.platforms).toEqual(["linux", "macOS", "windows"]);
		expect(desktop.permissions).toEqual(["core:window:allow-set-fullscreen", "core:window:allow-is-fullscreen", "updater:default", "process:allow-restart"]);
		const base = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
		expect(JSON.stringify(base)).not.toContain("updater");
	});
});

describe("in-app Android update wiring", () => {
	const plugin = "src-tauri/plugins/push";
	const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
	const commands = ["download_apk", "update_progress", "install_apk"];

	test("each command is built, exposed to the app, and allowed by the default permission set", () => {
		const build = read(`${plugin}/build.rs`), lib = read(`${plugin}/src/lib.rs`), perms = read(`${plugin}/permissions/default.toml`);
		for (const c of commands) {
			expect(build).toContain(`"${c}"`);
			expect(lib).toContain(`fn ${c}<`);
			expect(lib).toMatch(new RegExp(`generate_handler!\\[[^\\]]*\\b${c}\\b`));
			expect(perms).toContain(`allow-${c.replace(/_/g, "-")}`);
		}
	});

	test("the plugin may ask to install packages", () => {
		expect(read(`${plugin}/android/src/main/AndroidManifest.xml`)).toContain("android.permission.REQUEST_INSTALL_PACKAGES");
	});

	test("the native side takes only this repository's latest-release link, the same one the app checks", () => {
		const kt = read(`${plugin}/android/src/main/java/PushPlugin.kt`);
		expect(kt).toContain(`url.startsWith("${DOWNLOAD_PREFIX}")`);
	});

	test("the APK is shared through the FileProvider the app already declares, with read access only", () => {
		const kt = read(`${plugin}/android/src/main/java/PushPlugin.kt`);
		expect(kt).toContain('packageName + ".fileprovider"');
		expect(kt).toContain("FLAG_GRANT_READ_URI_PERMISSION");
		// src-tauri/gen is generated by `tauri android init` and not committed, so it only exists after that step.
		const paths = new URL("../src-tauri/gen/android/app/src/main/res/xml/file_paths.xml", import.meta.url);
		if (existsSync(paths)) expect(readFileSync(paths, "utf8")).toContain("cache-path");
	});
});
