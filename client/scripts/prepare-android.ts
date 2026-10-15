import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const marker = "// pipaya release configuration";

/** Fail closed if a Tauri template changes instead of producing an unsigned APK. */
export function configureAndroid(source: string): string {
	if (source.includes(marker)) return source;
	const replaceOnce = (input: string, before: string, after: string): string => {
		if (input.split(before).length !== 2) {
			throw new Error(`Android template changed: expected exactly one ${JSON.stringify(before)}`);
		}
		return input.replace(before, after);
	};
	let output = replaceOnce(source, "android {", `android {
    ${marker}
    // Read secrets directly in Gradle; Tauri intentionally does not forward passwords.
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH")
                ?: error("ANDROID_KEYSTORE_PATH is required"))
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                ?: error("ANDROID_KEYSTORE_PASSWORD is required")
            keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                ?: error("ANDROID_KEY_ALIAS is required")
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
                ?: error("ANDROID_KEY_PASSWORD is required")
        }
    }`);
	output = replaceOnce(output,
		'manifestPlaceholders["usesCleartextTraffic"] = "false"',
		'// User-configured HTTP servers (including Tailscale); prefer HTTPS on untrusted networks.\n        manifestPlaceholders["usesCleartextTraffic"] = "true"');
	return replaceOnce(output, 'getByName("release") {',
		'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")');
}

/**
 * The app is drawn edge to edge, but the WebView's `env(safe-area-inset-*)` is not reliable on every Android
 * version, so the page's top bar ended up under the status bar. The system bar heights are applied as padding
 * to the activity's root view instead, and the page then needs no inset of its own on Android.
 */
export function mainActivity(packageName: string): string {
	return `package ${packageName}

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val root = findViewById<android.view.View>(android.R.id.content)
    // Until the page reports its theme (plugin setSystemBars), start from the system's light/dark setting.
    val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES
    window.decorView.setBackgroundColor(if (night) 0xFF161616.toInt() else 0xFFFFFFFF.toInt())
    WindowInsetsControllerCompat(window, root).isAppearanceLightStatusBars = !night
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      // Keyboard: the page resizes itself (interactive-widget=resizes-content), so only the bars are padded here.
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }
}
`;
}

/** Firebase resource generation avoids a global Google Services Gradle plugin; credentials stay external. */
export function firebaseResources(source: string): string {
	const config = JSON.parse(source);
	const client = config.client?.find((c: any) => c.client_info?.android_client_info?.package_name === "work.pipaya.app");
	const values: Record<string, unknown> = {
		google_app_id: client?.client_info?.mobilesdk_app_id,
		google_api_key: client?.api_key?.[0]?.current_key,
		gcm_defaultSenderId: config.project_info?.project_number,
		project_id: config.project_info?.project_id,
	};
	const escapeXml = (value: unknown) => {
		if (typeof value !== "string" || !value || /[\r\n\x00]/.test(value)) throw new Error("Invalid Firebase Android configuration");
		return value.replace(/[&<>\"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
	};
	return `<resources>\n${Object.entries(values).map(([key, value]) => `    <string name="${key}" translatable="false">${escapeXml(value)}</string>`).join("\n")}\n</resources>\n`;
}

/**
 * `tauri android init` ignores src-tauri/icons/android and generates the default Tauri logo instead, so the
 * project's own launcher icons (see scripts/make-icons.py) are copied over it. The template's vector logo is
 * removed so nothing can fall back to it.
 */
export function installLauncherIcons(iconsDir: string, resDir: string): void {
	const source = resolve(iconsDir, "android");
	if (!existsSync(resolve(source, "mipmap-anydpi-v26/ic_launcher.xml"))) throw new Error(`Launcher icons missing in ${source}`);
	for (const stale of ["drawable/ic_launcher_background.xml", "drawable-v24/ic_launcher_foreground.xml"]) rmSync(resolve(resDir, stale), { force: true });
	cpSync(source, resDir, { recursive: true, force: true });
}

if (import.meta.main) {
	installLauncherIcons(resolve(import.meta.dir, "../src-tauri/icons"), resolve(import.meta.dir, "../src-tauri/gen/android/app/src/main/res"));
	const activity = resolve(import.meta.dir, "../src-tauri/gen/android/app/src/main/java/work/pipaya/app/MainActivity.kt");
	writeFileSync(activity, mainActivity("work.pipaya.app"));
	const path = resolve(import.meta.dir, "../src-tauri/gen/android/app/build.gradle.kts");
	writeFileSync(path, configureAndroid(readFileSync(path, "utf8")));
	const defaultFirebaseConfig = process.env.HOME ? resolve(process.env.HOME, ".secrets/pipaya/google-services.json") : undefined;
	const firebaseConfigPath = process.env.PIPAYA_FIREBASE_ANDROID_CONFIG ?? (defaultFirebaseConfig && existsSync(defaultFirebaseConfig) ? defaultFirebaseConfig : undefined);
	if (firebaseConfigPath) {
		const output = resolve(import.meta.dir, "../src-tauri/gen/android/app/src/main/res/values/pipaya_firebase.xml");
		writeFileSync(output, firebaseResources(readFileSync(firebaseConfigPath, "utf8")));
		console.log(`Firebase Android resources configured from ${firebaseConfigPath}`);
	}
	console.log("Android launcher icons, release signing and HTTP server access configured.");
}
