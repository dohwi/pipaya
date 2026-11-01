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
 *
 * Keyboard after a system dialog: Android System WebView 155-157 hides the soft keyboard the moment it hears that the
 * window lost focus (Chromium f04844f7e0, fixed in 158 by 37d5228c9e, b/560321831). A dialog from the keyboard app
 * itself (delete in its clipboard panel), the notification shade or the power menu takes the focus while the app is
 * still in front, so the keyboard vanished with it. The shell around the WebView keeps the focus loss from reaching
 * it, and if the keyboard is hidden anyway (the activity was paused, so the loss went through) it is shown again when
 * the focus returns.
 */
export function mainActivity(packageName: string): string {
	return `package ${packageName}

import android.content.Context
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner

class MainActivity : TauriActivity() {
  /** The soft keyboard is on screen, as the window insets last reported. */
  private var imeVisible = false
  /** The keyboard was up when a dialog or overlay took the window focus: bring it back when the focus returns. */
  private var restoreOnFocus = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val root = findViewById<ViewGroup>(android.R.id.content)
    keepKeyboardThroughDialogs(root)
    // Until the page reports its theme (plugin setSystemBars), start from the system's light/dark setting.
    val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES
    window.decorView.setBackgroundColor(if (night) 0xFF161616.toInt() else 0xFFFFFFFF.toInt())
    WindowInsetsControllerCompat(window, root).isAppearanceLightStatusBars = !night
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val ime = insets.isVisible(WindowInsetsCompat.Type.ime())
      // Chromium hides the keyboard a moment after the window lost the focus, so the inset that reports it can land
      // after the focus change: remember the hide here as well, while the app is still in front.
      if (imeVisible && !ime && !view.hasWindowFocus() && !isFinishing &&
        lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) restoreOnFocus = true
      imeVisible = ime
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      // Keyboard: the page resizes itself (interactive-widget=resizes-content), so only the bars are padded here.
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  /**
   * Puts a shell between the content view and the WebView that keeps telling the WebView the window is focused while
   * this activity is in front (see the comment above). The WebView is made by the Rust side a moment after the
   * activity starts, so it is caught as it arrives. Nothing else is focusable there, so the WebView loses nothing.
   */
  private fun keepKeyboardThroughDialogs(root: ViewGroup) {
    root.setOnHierarchyChangeListener(object : ViewGroup.OnHierarchyChangeListener {
      override fun onChildViewAdded(parent: View, child: View) {
        if (child is WebView) parent.post { wrapInFocusKeepingShell(child) }
      }

      override fun onChildViewRemoved(parent: View, child: View) = Unit
    })
    (0 until root.childCount).map(root::getChildAt).filterIsInstance<WebView>()
      .forEach { root.post { wrapInFocusKeepingShell(it) } }
  }

  /** Moves the WebView into the shell (once: a WebView already in one is left alone). */
  private fun wrapInFocusKeepingShell(web: WebView) {
    val parent = web.parent as? ViewGroup ?: return
    if (parent is FocusKeepingShell) return
    val fill = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    parent.removeView(web)
    val shell = FocusKeepingShell(this)
    shell.addView(web, fill)
    parent.addView(shell, fill)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    // The activity hears of the change before the WebView does, so the keyboard has not been hidden yet.
    if (!hasFocus) restoreOnFocus = restoreOnFocus || imeVisible
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus && restoreOnFocus) restoreKeyboard(0)
  }

  override fun onStop() {
    // Leaving the app (home, app switch, screen off): coming back must not pop the keyboard up, as in any other app.
    restoreOnFocus = false
    super.onStop()
  }

  /**
   * Shows the keyboard again, for the cases where the WebView heard the focus loss after all. Chromium drops the page's
   * input connection with the focus, so a plain showSoftInput can be ignored: the page's own field is focused again
   * first, which makes the WebView build a new connection and ask for the keyboard itself. Both are tried a few times,
   * because the field, the IME and the dialog closing all take a moment.
   */
  private fun restoreKeyboard(attempt: Int) {
    if (!restoreOnFocus) return
    if (attempt > 8 || isFinishing) {
      restoreOnFocus = false
      return
    }
    window.decorView.postDelayed({
      if (!restoreOnFocus) return@postDelayed
      if (!hasWindowFocus() || isFinishing) {
        restoreOnFocus = false
        return@postDelayed
      }
      if (imeVisible) {
        restoreOnFocus = false
        return@postDelayed
      }
      val target = currentFocus ?: window.decorView
      if (attempt == 0 || attempt == 2) (target as? WebView)?.evaluateJavascript(REFOCUS_FIELD, null)
      val ime = getSystemService(InputMethodManager::class.java)
      // The input connection was dropped with the focus, so the IME may not take the request before it is rebuilt.
      if (attempt == 1) ime?.restartInput(target)
      ime?.showSoftInput(target, InputMethodManager.SHOW_IMPLICIT)
      restoreKeyboard(attempt + 1)
    }, 150L)
  }

  private companion object {
    /** Focus the page's field again: blur first, since focusing the field that already has it changes nothing. */
    const val REFOCUS_FIELD =
      "(function(){var e=document.activeElement;if(!e)return;var t=e.tagName;if(t!=='TEXTAREA'&&t!=='INPUT')return;e.blur();e.focus();})()"
  }
}

/** Keeps the window focus for the WebView while the activity is in front (see MainActivity.keepKeyboardThroughDialogs). */
private class FocusKeepingShell(context: Context) : FrameLayout(context) {
  override fun dispatchWindowFocusChanged(hasFocus: Boolean) {
    val inFront = (context as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true
    super.dispatchWindowFocusChanged(hasFocus || inFront)
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
