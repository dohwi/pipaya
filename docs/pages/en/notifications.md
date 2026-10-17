This page explains how to get notified when work finishes or approval is needed, how to connect a new device, and how to revoke one.

## Notification types

| Type (`kind`) | When |
|---|---|
| `task_completed` | A run finished. The title says "Task complete", and the body has a preview of the answer (whitespace-normalized, up to 110 characters) and the time taken |
| `task_failed` | Stopped with an error. The cause of the error is in the body |
| `approval_required` | Waiting for tool-run approval. "Waiting for approval to run ○○" |
| `user_request` | The agent asked a question (`ask_user`) and is waiting for the answer |
| `info` | General notifications sent by extensions and the like |

The wording is written by the server itself in **the receiving device's language** (Korean or English), because a push that arrives while the app is closed does not pass through the app. The title says "what happened in which chat" and the body holds a preview of the result, so you can decide without opening the app.

## Who receives it

The server knows the **state** of every connected device. A device reports its own state periodically (heartbeat) with `PUT /notifications/devices/:id`.

| Field | Description |
|---|---|
| `platform` | `desktop` `android` `ios` `web` |
| `focused` | Whether the app window is being looked at right now |
| `enabled` | Whether this device should receive notifications |
| `visibleSessionIds` | Chats visible on screen (up to 20) |
| `lang`, `name`, `os`, `app` | Information for display and wording |
| `push` | Mobile push token `{provider: "fcm" \| "apns", token}` (mobile only) |

The decision rules are:

| Situation | Behavior |
|---|---|
| **Any device is looking at the app** | No notification is sent (both OS notifications and push are suppressed) |
| A PC or web client is connected | OS notification on that device |
| A mobile device with push set up exists | Mobile push |
| A notification already went to the PC and nobody is looking | **Escalation** to the phone after the set time |

- It does not ring when the chat you are looking at finishes. **Approval requests make a sound even if you are looking.**
- A device whose heartbeat has not arrived for **45 seconds** is treated as disconnected.
- Mobile "looking" is honored for only **25 seconds**, because switching to another app freezes the WebView and a "not looking" report may never arrive.
- It waits **5 seconds** for the PC's confirmation that it showed the notification (`POST /notifications/:id/received`) before sending a mobile push. A mobile device with no device that can show it waits just 1 second. If the run restarts in the meantime, the push is cancelled.
- A notification with the same `source:key` is not sent twice within **24 hours**.
- Escalations that came due while the server was off are dropped if more than 10 minutes late.

### If not read on the PC, to the phone

**If not read on PC, send to phone** under Settings → General → Notifications is the escalation wait time. If a notification went to the PC and nobody opened the app on any device during this time, it is pushed to the phone. Choose from `Don't send`, 1, 2, 3 (default), 5, 10, 15, 30 and 60 minutes; it applies **to every device connected to this server** (server setting `notificationPolicy`).

## Notification settings

Set them in Settings → General.

| Item | Description |
|---|---|
| System notifications | OS notifications when work completes or fails, approval is needed or the user is asked. Not sent while you are looking at the app window |
| Send a test notification to this device | Checks the server → app → OS path once. Tells you the failing step specifically |
| Mobile push status | Whether server push is set up and whether this device has a token |
| Notification sounds | Sound on completion, confirmation needed and failure. Volume 0–200%, default 100% |
| If not read on PC, send to phone | The escalation time above |

When the test notification fails, the cause is told apart: the system notification switch is off / the operating system blocks notifications / the server does not know this device / the server did not receive the test request (the server may be an older version) / the server sent it but the app did not receive it within 6 seconds (realtime connection dropped) / the app could not hand it to the OS.

## Mobile push (FCM)

To receive them even when the app is fully closed, push must be set up on the server.

| Condition | Description |
|---|---|
| `PIPAYA_PUSH_FCM` | On unless `0` (on by default) |
| Credentials | The file the `GOOGLE_APPLICATION_CREDENTIALS` environment variable points to; if absent, `~/.secrets/pipaya/firebase-adminsdk.json` |
| Operating condition | It works only if the credentials above **actually exist**. Without them push is quietly off |
| Check | `GET /notifications/status` → `{pushConfigured, providers}` |

Per-device push tokens are stored in the server database (`notification_devices`), up to 100 devices. Push token values are never returned through the API.

> [!NOTE]
> Mobile push while the app is closed needs both native push registration and the server's FCM/APNs setup. Without them, the settings screen shows "Not connected yet".

## Notifications sent by extensions

Client and server extensions can send notifications or register **notification rules** with the `system-notifications` permission.

| Item | Value |
|---|---|
| Send directly | `POST /notifications` `{source, notification:{title, body?, kind?, sessionId?, key?}}` |
| Title / body | Title up to 183 characters (`[owner]` is put in front), body up to 300 characters |
| Rate limit | **5 per 10 seconds** per `source` |
| Reserved source | `pipaya` is for built-in notifications, so extensions cannot use it |
| Rules | `PUT /notifications/rules/:owner/:id` `{event: "run_finished" \| "approval_requested", title, body?}`. **Up to 5** per owner |
| Delete rules | `DELETE /notifications/rules/:owner/:id`, `DELETE /notifications/rules/:owner` (all) |

A rule **replaces** the built-in notification. That is, when an extension registers a `run_finished` rule, the extension's wording goes out instead of the default notification for that event. → [[client-extensions]]

## Connecting a new device (QR)

A way to connect a phone or another PC without moving the admin token by hand.

::: steps
### Create a connection code

In an already connected PC app, open **Settings → Devices → Add phone** and press **Create QR**. Check the address the phone will connect to. A `localhost` address points the phone at itself, so change it to a Tailscale or LAN address.

### Scan

Open the app on the new device and scan the QR with the camera. The link looks like `pipaya://connect…`, and you can also pass it on directly with copy link.

### The server registers the device

If the code is valid, the server creates a **token just for that device** (`hdt_…`) and returns it, and the code is discarded immediately.
:::

### Properties of codes and tokens

| Item | Value |
|---|---|
| Code validity | **2 minutes**, **single use** |
| Simultaneously valid codes | Up to 5 (the oldest is pushed out) |
| Code format | 24 random bytes (base64url). The server keeps **only the SHA-256 hash** in memory. A restart invalidates all |
| Wrong codes | Up to **10 per minute** per caller and **100 per minute** overall. Beyond that, `429` |
| Device token | `hdt_` + 32 random bytes. Only the **SHA-256 hash** is stored in the database |
| Label | A name the device gave itself, up to 60 characters |
| Last used | Updated at 60-second granularity |

The QR does not contain the admin token. Even if someone photographs the screen, the code soon becomes invalid, and once used it is finished.

### Permissions of a device token

A device token is **narrower than the admin token.** It can use most of the API, but the following are rejected (`403 admin_only`).

- `POST`/`DELETE /pairing` — letting a new device in
- `GET /devices/tokens`, `DELETE /devices/tokens/:id` — listing and revoking devices
- `POST /server-extensions/reload` — reloading server extensions (code execution)
- `GET`/`POST /server/update` — replacing server code and restarting

In other words, a connected phone cannot add another phone or change the server code.

## Managing and revoking devices

In Settings → Devices you can see the devices that connected with this token.

| Display | Description |
|---|---|
| Name, type | Web browser, desktop app, Android and so on + OS and app version |
| Connected / Disconnected | Whether a heartbeat is arriving now. This device is shown as "This device" |
| Last seen | n seconds, minutes, hours or days ago |
| Mobile push | Whether there is a push token and whether notifications are off |

If you **revoke access** for a device in the list of **devices connected with QR** (with one more confirmation), that device's token is deleted and its open socket is cut immediately. Other devices and the server token are unaffected. A revoked device receives the `device_revoked` event and stops reporting. Revoking from the notification-recipient list (`DELETE /notifications/devices/:id`) is separate and removes **only the notification registration**.
