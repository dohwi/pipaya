package pipaya.push

import android.app.NotificationManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** FCM's notification payload is displayed by Android while the process is stopped.
 * Refreshing getToken() on resume registers token rotations with the server. */
class PushService : FirebaseMessagingService() {
    override fun onCreate() {
        super.onCreate()
        PushPlugin.createChannel(this) // the channel must exist before the first push, which can arrive with the app never opened
    }
    override fun onNewToken(token: String) {
        getSharedPreferences("pipaya-push", MODE_PRIVATE).edit().putString("token", token).apply()
    }
    /**
     * Only data-only messages arrive here (the system shows the ones with a notification part itself). `clear` means the
     * session was read on another device: its notification, tagged with the session id, leaves the shade.
     */
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["type"] != "clear") return
        val sessionId = message.data["sessionId"]
        if (sessionId.isNullOrEmpty()) return
        PushPlugin.clearSession(this, sessionId)
    }
}
