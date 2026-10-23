package pipaya.push

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import android.graphics.Color
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

@InvokeArg
class SystemBarsArgs {
    var color: String = "#000000"
    var dark: Boolean = true
}

@InvokeArg
class DownloadArgs {
    var url: String = ""
}

@InvokeArg
class ClearArgs {
    var sessionIds: Array<String> = emptyArray()
}

@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
    private var tap: JSObject? = null
    private fun capture(intent: Intent?) {
        val sid = intent?.getStringExtra("sessionId") ?: return
        tap = JSObject().put("sessionId", sid).put("notificationId", intent.getStringExtra("notificationId") ?: "")
    }
    init {
        capture(activity.intent)
        thread(name = "pipaya-apk-cleanup") { cleanStaleApk() }
        // No createChannel here: on Android 13+ the first channel makes the system ask for notification permission,
        // which would pop up on first launch. register() creates it once permission has been granted.
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); capture(intent) }
    @Command
    fun pendingTap(invoke: Invoke) {
        val current = tap
        tap = null
        invoke.resolve(current ?: JSObject())
    }
    /** The session was read in the app: its notification in the shade has served its purpose. */
    @Command
    fun clearNotifications(invoke: Invoke) {
        for (id in invoke.parseArgs(ClearArgs::class.java).sessionIds) clearSession(activity, id)
        invoke.resolve()
    }
    /** The bar behind the clock and battery takes the app's own background, and its icons turn light or dark to stay readable. */
    @Command
    fun setSystemBars(invoke: Invoke) {
        val args = invoke.parseArgs(SystemBarsArgs::class.java)
        val color = try { Color.parseColor(args.color) } catch (e: IllegalArgumentException) { invoke.reject("Invalid colour"); return }
        activity.runOnUiThread {
            // The activity's root view is padded by the bars (see MainActivity), so painting its background colours the
            // area behind them. The window background covers the navigation bar the same way.
            activity.window.decorView.setBackgroundColor(color)
            WindowInsetsControllerCompat(activity.window, activity.window.decorView).apply {
                isAppearanceLightStatusBars = !args.dark
                isAppearanceLightNavigationBars = !args.dark
            }
            invoke.resolve()
        }
    }
    /**
     * What the phone is called. A phone has no hostname (the OS answers "localhost"), so use the name the user gave it in
     * Settings (Settings -> About phone -> Device name), and fall back to the maker and model ("Google Pixel 8").
     */
    @Command
    fun deviceName(invoke: Invoke) {
        val given = try { Settings.Global.getString(activity.contentResolver, "device_name") } catch (e: Exception) { null }
        val maker: String = Build.MANUFACTURER ?: ""
        val model: String = Build.MODEL ?: ""
        // "Pixel 8" already says who made it; "SM-S918B" does not, so the maker goes in front
        val label = if (maker.isEmpty() || model.startsWith(maker, ignoreCase = true)) model else "$maker $model"
        val name = if (given != null && given.trim().isNotEmpty()) given.trim() else label.trim()
        invoke.resolve(JSObject().put("name", name))
    }
    // ---- in-app update (Android cannot install silently: the system installer always asks, which is wanted) ----
    @Volatile private var dlDone = 0L
    @Volatile private var dlTotal = 0L
    @Volatile private var dlState = "idle" // idle | downloading | done | error
    @Volatile private var dlError = ""
    /**
     * The installer leaves the APK in the cache for good. Drop it once the app is at least that version (the update went
     * through) or it does not parse; a newer one stays, since the user may still be on the "allow installs" page.
     */
    private fun cleanStaleApk() {
        try {
            val dir = File(activity.cacheDir, "updates")
            val files = dir.listFiles() ?: return
            val apk = File(dir, "pipaya-update.apk")
            files.filter { it.name.endsWith(".part") || (it != apk && it.isFile) }.forEach { it.delete() }
            if (!apk.exists() || dlState == "downloading") return
            val pm = activity.packageManager
            val archive = pm.getPackageArchiveInfo(apk.path, 0)
            val current = pm.getPackageInfo(activity.packageName, 0)
            @Suppress("DEPRECATION")
            val stale = archive == null || archive.packageName != activity.packageName ||
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) archive.longVersionCode <= current.longVersionCode
                else archive.versionCode <= current.versionCode)
            if (stale) apk.delete()
        } catch (e: Exception) { /* cache only: the OS reclaims it anyway */ }
    }
    private fun apkFile() = File(File(activity.cacheDir, "updates").apply { mkdirs() }, "pipaya-update.apk")

    /**
     * Start downloading the APK into the app's cache. Only a link under this repository's `latest` release is taken: the
     * JS side checks it too, but this is the side that writes the file, so it does not rely on that.
     */
    @Command
    fun downloadApk(invoke: Invoke) {
        val url = invoke.parseArgs(DownloadArgs::class.java).url
        if (!url.startsWith("https://github.com/dohwi/pipaya/releases/download/latest/")) { invoke.reject("Unexpected update link"); return }
        if (dlState == "downloading") { invoke.resolve(); return }
        dlDone = 0; dlTotal = 0; dlState = "downloading"; dlError = ""
        thread(name = "pipaya-apk-download") {
            val target = apkFile()
            val part = File(target.parentFile, "pipaya-update.apk.part")
            try {
                target.delete(); part.delete()
                // GitHub answers with a redirect to its CDN; HttpURLConnection follows https -> https on its own
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 15000
                conn.readTimeout = 30000
                conn.instanceFollowRedirects = true
                if (conn.responseCode != 200) throw RuntimeException("HTTP ${conn.responseCode}")
                dlTotal = conn.contentLengthLong.coerceAtLeast(0)
                conn.inputStream.use { input -> part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        dlDone += n
                    }
                } }
                if (dlDone <= 0 || (dlTotal > 0 && dlDone != dlTotal)) throw RuntimeException("Incomplete download")
                if (!part.renameTo(target)) throw RuntimeException("Could not save the update")
                dlState = "done"
            } catch (e: Exception) {
                part.delete()
                dlError = e.message ?: "Download failed"
                dlState = "error"
            }
        }
        invoke.resolve()
    }

    /** Where the download is: polled by the app for the progress bar. */
    @Command
    fun updateProgress(invoke: Invoke) {
        invoke.resolve(JSObject().put("state", dlState).put("done", dlDone).put("total", dlTotal).put("error", dlError))
    }

    /**
     * Hand the downloaded APK to the system installer. Installing from an app needs the user's one-time "allow from this
     * source" switch; without it the settings page for it is opened and `needsPermission` is returned, and the app tries
     * again when the user comes back.
     */
    @Command
    fun installApk(invoke: Invoke) {
        val file = apkFile()
        if (!file.exists()) { invoke.reject("No downloaded update"); return }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(settings)
            invoke.resolve(JSObject().put("needsPermission", true))
            return
        }
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
        val install = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(install)
        invoke.resolve(JSObject().put("needsPermission", false))
    }

    @Command
    fun register(invoke: Invoke) {
        // `enabled` defaults to on, so register() also runs on first launch. Creating the channel there would trigger the
        // system permission prompt, so only do it once permission is already granted (the settings toggle asks first).
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) createChannel(activity)
        if (FirebaseApp.getApps(activity).isEmpty() && FirebaseApp.initializeApp(activity) == null) {
            invoke.resolve(JSObject()) // No Firebase config: normal builds remain usable.
            return
        }
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) invoke.resolve(JSObject().put("provider", "fcm").put("token", task.result))
            else invoke.reject("Push registration unavailable")
        }
    }

    companion object {
        /**
         * Android 8+ shows a notification only through a channel, and the channel's importance decides whether it makes a
         * sound and pops up. Without naming one, a push that arrives while the app is closed lands in a default channel
         * the system may treat as low priority: it sits silently in the shade. The channel is made here with high
         * importance, and the manifest points FCM at it. A channel's importance cannot be raised once it exists, hence
         * a new id rather than editing an old one.
         */
        const val CHANNEL_ID = "pipaya_alerts"
        /** Pushes carry the session id as their tag (see the server's push.ts), so the tag finds them. FCM posts them with id 0. */
        fun clearSession(context: Context, sessionId: String) {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(sessionId, 0)
        }
        fun createChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            val channel = NotificationChannel(CHANNEL_ID, "Pipaya", NotificationManager.IMPORTANCE_HIGH)
            channel.description = "Task results and questions for you"
            manager.createNotificationChannel(channel)
        }
    }
}
