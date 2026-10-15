package pipaya.push

import com.google.firebase.messaging.FirebaseMessagingService

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
}
