# System notifications and mobile push

## Policy

- The user turns OS notifications on in Settings > General > System notifications (off by default). Extensions cannot open the permission prompt.
- All devices using the same server's Bearer token count as one user, per server. There are no user accounts.
- If any device has the app visible and focused, OS/push notifications are suppressed (unread marks, toasts and approval UI stay). A phone that reported focus counts as looking for 25 s only, since Android may freeze the WebView before it reports blur.
- If nobody is looking, exactly one device gets a live OS notification: desktop first, then the most recently active window.
- **Unread on PC → phone (Discord style)**: if the PC showed it but no device opens the app within `notificationPolicy.escalateMinutes` (server-wide; default 3, choices 0 = off, 1, 2, 3, 5, 10, 15, 30, 60), the server pushes to the phone. Looking at the app, resolving the approval or starting a new run cancels it. Pending escalations are stored (`notification_escalations`) and survive restarts; ones overdue by more than 10 min are dropped.
- With no PC window able to show it, push goes out after a short wait (5 s for a PC/browser receipt; 1 s grace when no device can show a local notification).
- Presence is refreshed every 10 s and expires after 45 s. Cross-device suppression can race briefly; delivery is not exactly-once.
- The server creates task completed / failed / approval needed notifications, in the receiving device's language (devices send `lang` with presence; English if unknown). Title: what happened and which chat (`✅ Task completed · Login bug`). Body: the last answer (markdown and code stripped, ~110 chars), the error, or the tool and its command/path. Runs over 20 s add the duration. No other tool args or usage. Aborted runs are silent.
- Text passes through the OS notification center, lock screen and Google/Apple delivery; keep secrets, transcripts and tool args out of extension notifications.
- Clicking opens the session. A notification never approves a tool call.

## Platforms

| Platform | Live OS notification | Push while the app is closed |
|---|---|---|
| Windows EXE / macOS DMG | Tauri notification plugin | none; falls back to registered phones |
| Android APK | Tauri notification plugin | FCM, when Firebase is configured |
| iOS | IPA no longer shipped | server push code and `NativePushAdapter` hook remain |
| Web | Notification API (permission + secure context) | no Service Worker / Web Push |

A force-stopped Android app may not receive FCM until reopened.

## Android FCM setup

1. Register Android app `work.pipaya.app` in a Firebase project.
2. Keep `google-services.json` outside the repo, at `~/.secrets/pipaya/google-services.json` (or set `PIPAYA_FIREBASE_ANDROID_CONFIG`).
3. Build:

```sh
cd client
bun run android:init
bun run android:prepare   # validates the application ID, writes the public Firebase config into Android resources
bun run build:android     # needs the usual Android signing env vars
```

Never put the Firebase service-account key in the APK. Without the config the APK builds but reports push as unsupported. Release CI does not restore the Firebase file.

Server: push is on when credentials exist (`PIPAYA_PUSH_FCM=0` disables). It uses Google Application Default Credentials and picks up `~/.secrets/pipaya/firebase-adminsdk.json`, or set `GOOGLE_APPLICATION_CREDENTIALS`.

Server tokens, service accounts and device push tokens are never exposed to the SDK.

## iOS hook (not shipped)

- `DevicePlatform`: `desktop | android | ios | web`; registration `{provider: 'fcm' | 'apns', token}`.
- Server `PushTransports` has an FCM transport (iOS messages carry APNs alert/expiry/thread fields; needs an APNs key in Firebase). No direct APNs transport.
- Client `NativePushAdapter` exposes `register`, `onTokenChanged`, `onTap`; an iOS implementation selected in `nativePushAdapter()` would reuse presence and SDK as is. It must coexist with the Tauri notification plugin's `UNUserNotificationCenterDelegate` and needs the Push capability, `aps-environment` entitlement and signing. Use alert pushes, not silent ones.

## SDK

`notifications` + `show(text)` stays in-app toasts only. OS/push needs **`system-notifications`**.

```js
const status = await sdk.notifications.status();   // {enabled, permission, pushConfigured}; no tokens
await sdk.notifications.send({ title: 'Please check', body: 'Pick a deploy target.',
  kind: 'user_request', sessionId: 'session-id', key: 'deploy-request-1' });
// {id, delivered, suppressed}; delivered = live targets, not a receipt

// data-only rules the server runs even while the app is closed
await sdk.notifications.register('done', { event: 'run_finished', title: 'Task finished' });
await sdk.notifications.register('question', { event: 'question_requested', title: 'The agent has a question' });
await sdk.notifications.remove('done');
```

- `send`: title ≤100, body ≤300, sessionId/key ≤80. Unknown fields, URLs, force flags and actions are refused. The host prefixes the extension name.
- `kind`: `task_completed`, `task_failed`, `user_request`, `info`.
- `key` dedupes for 24 h per server and extension; use it when reacting to events that may repeat.
- 5 sends per 10 s, 5 server rules per extension. Several devices registering the same rule ID update one server rule.
- Rules take no code, filters, transcripts or tool args and support only `run_finished` and `question_requested`. A rule replaces the built-in notification for that event.
- Disable, delete, replace, failure and safe mode revoke the rules; offline revocations are queued and retried (the old rule may fire until then). Plain app exit or reload keeps them. The Worker itself never runs while the app is closed.

## Code and verification

Server: `notifications.ts`, `notification-routes.ts`, `push.ts`, `client-settings.ts` (`notificationPolicy`); devices, rules and dedupe keys in SQLite, presence leases in memory. The short pre-push wait is not durable; a restart during it can lose that notification.

Client: `notifications.ts`, `notification-contract.ts`, `notification-rules.ts`, `native-push.ts`, `NotificationSettings.svelte`; Android plugin `src-tauri/plugins/push/`.

```sh
cd client && bun run check && bun run test && bun run build
cd ../server && bun run typecheck && bun test
```

Before release, check on real devices: permission denied, focus, PC↔phone handoff, background, closed app, click, token refresh, delete, FCM config errors. Browser tests do not replace this.
