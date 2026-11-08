import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync as read, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidManifest, configureAndroid, installLauncherIcons, mainActivity } from "../scripts/prepare-android";

// Relevant sections of the Tauri 2.12 Android template. Fail closed on template drift.
const template = `android {
    compileSdk = 37
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        getByName("release") {
            optimization { enable = true }
        }
    }
}`;

describe("Android release configuration", () => {
	test("configures persistent signing without embedding credentials", () => {
		const output = configureAndroid(template);
		for (const name of ["ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
			expect(output).toContain(`System.getenv("${name}")`);
		}
		expect(output).toContain('signingConfig = signingConfigs.getByName("release")');
		expect(output).not.toContain('manifestPlaceholders["usesCleartextTraffic"] = "false"');
	});
	test("is idempotent", () => {
		const output = configureAndroid(template);
		expect(configureAndroid(output)).toBe(output);
	});
	test("rejects missing or ambiguous template anchors", () => {
		for (const anchor of ["android {", 'manifestPlaceholders["usesCleartextTraffic"] = "false"', 'getByName("release") {']) {
			expect(() => configureAndroid(template.replace(anchor, ""))).toThrow("Android template changed");
			expect(() => configureAndroid(`${template}\n${anchor}`)).toThrow("Android template changed");
		}
	});
	test("Windows packaging has a valid filename and native icons", () => {
		const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
		expect(config.productName).not.toMatch(/[\\/:*?"<>|]/);
		expect(config.identifier).toBe("work.pipaya.app");
		expect(config.bundle.icon).toContain("icons/icon.ico");
	});
});

describe("Android launcher icons", () => {
	const icons = join(import.meta.dir, "../src-tauri/icons");
	const generated = () => {
		// what `tauri android init` leaves behind: Tauri's own logo
		const res = mkdtempSync(join(tmpdir(), "res-"));
		for (const d of ["drawable", "drawable-v24", "mipmap-xxxhdpi", "values"]) mkdirSync(join(res, d));
		writeFileSync(join(res, "drawable/ic_launcher_background.xml"), "<tauri-logo/>");
		writeFileSync(join(res, "drawable-v24/ic_launcher_foreground.xml"), "<tauri-logo/>");
		writeFileSync(join(res, "mipmap-xxxhdpi/ic_launcher.png"), "tauri-logo");
		writeFileSync(join(res, "values/colors.xml"), "<resources/>");
		return res;
	};
	test("replaces the template's Tauri logo with the project icons", () => {
		const res = generated();
		installLauncherIcons(icons, res);
		expect(existsSync(join(res, "drawable/ic_launcher_background.xml"))).toBe(false);
		expect(existsSync(join(res, "drawable-v24/ic_launcher_foreground.xml"))).toBe(false);
		expect(read(join(res, "mipmap-xxxhdpi/ic_launcher.png")).equals(read(join(icons, "android/mipmap-xxxhdpi/ic_launcher.png")))).toBe(true);
		expect(read(join(res, "mipmap-anydpi-v26/ic_launcher.xml"), "utf8")).toContain("<adaptive-icon");
		expect(read(join(res, "values/ic_launcher_background.xml"), "utf8")).toContain("ic_launcher_background");
		expect(existsSync(join(res, "values/colors.xml"))).toBe(true); // unrelated template files are kept
	});
	test("fails instead of shipping the default logo when the icons are missing", () => {
		expect(() => installLauncherIcons(mkdtempSync(join(tmpdir(), "none-")), generated())).toThrow("Launcher icons missing");
	});
	test("the status-bar notification icon is shipped at every density, as a white glyph on transparent", () => {
		for (const d of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
			expect(existsSync(join(import.meta.dir, `../src-tauri/icons/android/drawable-${d}/ic_stat_pipaya.png`))).toBe(true);
		}
	});
	test("the app and the server both name the same status-bar icon", () => {
		const push = readFileSync(join(import.meta.dir, "../../server/src/push.ts"), "utf8");
		const app = readFileSync(join(import.meta.dir, "../src/lib/notifications.ts"), "utf8");
		const manifest = readFileSync(join(import.meta.dir, "../src-tauri/plugins/push/android/src/main/AndroidManifest.xml"), "utf8");
		expect(push).toContain('"ic_stat_pipaya"');
		expect(app).toContain('icon: "ic_stat_pipaya"');
		expect(manifest).toContain("@drawable/ic_stat_pipaya");
		const plugin = readFileSync(join(import.meta.dir, "../src-tauri/plugins/push/android/src/main/java/PushPlugin.kt"), "utf8");
		const service = readFileSync(join(import.meta.dir, "../src-tauri/plugins/push/android/src/main/java/PushService.kt"), "utf8");
		// The id the server sends, the one the manifest defaults to, and the one the plugin creates must all be the same string
		expect(push).toContain('"pipaya_alerts"');
		expect(manifest).toContain('default_notification_channel_id" android:value="pipaya_alerts"');
		expect(plugin).toContain('CHANNEL_ID = "pipaya_alerts"');
		expect(plugin).toContain("IMPORTANCE_HIGH");
		expect(service).toContain("PushPlugin.createChannel(this)");
	});
	test("the activity keeps the web page out from under the status and navigation bars", () => {
		const kt = mainActivity("work.pipaya.app");
		expect(kt).toContain("package work.pipaya.app");
		expect(kt).toContain("class MainActivity : TauriActivity()");
		expect(kt).toContain("setOnApplyWindowInsetsListener");
		expect(kt).toContain("WindowInsetsCompat.CONSUMED"); // consumed here, so the page's own safe-area padding is not added a second time
		expect(kt.split("{").length).toBe(kt.split("}").length); // balanced braces: a typo here only shows up in CI otherwise
	});
	test("a system dialog does not take the keyboard away (WebView 155-157 hides it on window focus loss)", () => {
		const kt = mainActivity("work.pipaya.app");
		// the shell keeps the focus loss from reaching the WebView while the activity is in front
		expect(kt).toContain("keepKeyboardThroughDialogs(root)");
		expect(kt).toContain("override fun dispatchWindowFocusChanged(hasFocus: Boolean)");
		expect(kt).toContain("super.dispatchWindowFocusChanged(hasFocus || inFront)");
		expect(kt).toContain("isAtLeast(Lifecycle.State.RESUMED)");
		// and if it was hidden anyway, the page's field is focused again and the keyboard asked for, more than once
		expect(kt).toContain("evaluateJavascript(REFOCUS_FIELD, null)");
		expect(kt).toContain("showSoftInput(target, InputMethodManager.SHOW_IMPLICIT)");
		expect(kt).toContain("isVisible(WindowInsetsCompat.Type.ime())");
		// leaving the app must not bring the keyboard back on return
		expect(kt).toMatch(/override fun onStop\(\) \{\s+\/\/[^\n]*\n\s+restoreOnFocus = false/);
	});
});


describe("Android microphone permission", () => {
	const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="pipaya">
        <activity android:name=".MainActivity" />
    </application>
</manifest>`;

	test("declares RECORD_AUDIO and MODIFY_AUDIO_SETTINGS, keeps what was there, and is idempotent", () => {
		const once = androidManifest(manifest);
		expect(once).toContain('<uses-permission android:name="android.permission.RECORD_AUDIO" />');
		expect(once).toContain('<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />');
		expect(once).toContain("android.permission.INTERNET");
		expect(once.indexOf("RECORD_AUDIO")).toBeLessThan(once.indexOf("<application"));
		expect(androidManifest(once)).toBe(once);
	});
	test("fails closed on a template without exactly one application element", () => {
		expect(() => androidManifest("<manifest></manifest>")).toThrow(/template changed/);
		expect(() => androidManifest("<manifest><application/><application/></manifest>")).toThrow(/template changed/);
	});
	test("the activity answers a microphone request: audio only, this app's page only, after Android's permission", () => {
		const kotlin = mainActivity("work.pipaya.app");
		expect(kotlin).toContain("import android.Manifest");
		expect(kotlin).toContain("import android.webkit.PermissionRequest");
		expect(kotlin).toContain("override fun onPermissionRequest(request: PermissionRequest)");
		expect(kotlin).toContain("PermissionRequest.RESOURCE_AUDIO_CAPTURE");
		expect(kotlin).toContain("request.deny()");
		expect(kotlin).toContain("ActivityCompat.requestPermissions");
		expect(kotlin).toContain("Manifest.permission.RECORD_AUDIO");
		expect(kotlin).toContain("override fun onRequestPermissionsResult");
		// only the app's own page, and nothing but audio
		expect(kotlin).toMatch(/request\.origin\?\.host == "tauri\.localhost"/);
		expect(kotlin).toContain("val wantsOther = request.resources.any { it != PermissionRequest.RESOURCE_AUDIO_CAPTURE }");
		// the keyboard fix stays: one hierarchy listener that does both jobs
		expect(kotlin.match(/setOnHierarchyChangeListener/g)).toHaveLength(1);
		expect(kotlin).toContain("private fun onWebView(web: WebView)");
		expect(kotlin).toContain("wrapInFocusKeepingShell(web)");
		expect(kotlin).toContain("attachMicrophonePermission(web)");
	});
});
