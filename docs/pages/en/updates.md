This page explains how to keep the server and the app up to date, how the client is built and distributed, and the compatibility rules.

## At a glance

| Target | Method | User confirmation |
|---|---|---|
| Server | The app's **Server update**, `install.sh update`, or a Docker rebuild | Pressed in the app |
| Windows / macOS app | In-app update (installed after signature verification, app restarts) | Installed only after you press the button |
| Android app | Downloads the APK inside the app and opens the system install screen | The system confirms once more |
| iOS app | Reinstall the unsigned IPA yourself | Manual |
| Web client | Update the server and rebuild and redeploy the client build | Manual |

## Server update

### From the app

The app checks `GET /server/update` on the server for a new commit and, if there is one, shows **Server update**. When you update the app, an **Update the server too** option appears; the server is updated first and restarted, then the app is updated (because installing the app restarts it and later steps would not run).

What `POST /server/update` does:

::: steps
### Check

It checks with `git fetch --depth 1` whether the branch this checkout tracks has a new commit.

### Check for running chats

If any chat is running, it refuses with `409 sessions_running`. Pass `{"force": true}` to ignore this and go ahead.

### Move and install

It moves to the new commit and installs dependencies. If installation fails, it goes back to the previous version and returns `502 update_failed`.

### Restart

It exits the process. The service manager (systemd or launchd) brings it back up with the new code.
:::

Only the admin token can use it. A device token from a QR connection gets `403 admin_only`.

### When it cannot update

The server puts the reason in the response (`reason`).

| `reason` | Meaning | Action |
|---|---|---|
| `disabled` | `PIPAYA_SELF_UPDATE=0` | Turned off. To turn on, remove the value or set `1` |
| `not_git` | The code folder has no `.git` (Docker image, compiled binary) | Rebuild the image or replace it in the way your deployment does |
| `unmanaged` | No supervisor that can restart the process was found | Run as a systemd or launchd service, or set `PIPAYA_SELF_UPDATE=1` |
| `detached` | A checkout pinned to a tag or commit (not a branch) | The server does not move it, since pinning was your choice. Switch to a branch |
| `fetch_failed` | Could not fetch from the remote | Check the network and remote access |

A "supervisor" is detected automatically when the `INVOCATION_ID` environment variable that systemd sets exists, or when `XPC_SERVICE_NAME`, set by macOS launchd, is `app.pipaya.server`. The service made by `install.sh` matches this. If you use another supervisor, force it on with `PIPAYA_SELF_UPDATE=1`.

### With the script

```bash
install.sh update      # fetch the latest code and restart the service
```

### Docker

```bash
git pull
docker compose up -d --build
```

## Client update

### Windows and macOS

Uses the Tauri updater. Update information is read from the release's `latest.json`, and the downloaded bundle is installed after its **signature is verified with the public key** built into the app, and then the app restarts. Nothing is installed before the user presses the button.

### Android

On Android the app cannot install itself silently. The app reads the `Version: x.y.z` line from the body of the GitHub `latest` release and compares it with the current version, and if it is newer, downloads the APK inside the app with a progress indicator and hands it to the system install screen. Only APK links under `https://github.com/dohwi/pipaya/releases/download/latest/` are accepted. If installing is not allowed, allow this app to install in settings and return, and the install screen opens and continues.

### Settings

**Updates** under Settings → General:

| Item | Description |
|---|---|
| Check for updates | Check now |
| Check for new version at startup | Check automatically when the app starts |
| Server version | Shows the connected server's version |
| Update the server too | Updates the server first during an app update (the server is skipped if a chat is running) |

When a new version exists, an **update banner** appears at the top and you can put it off with "Later". While the server is updating, "Waiting for the server to restart…" is shown.

## Compatibility (protocol)

The server and the app match compatibility with an integer **`protocol`** number.

- `protocol` is raised **only when** the format of REST, WebSocket or SSE changes in a way **an older counterpart cannot handle**. Merely adding fields or routes does not raise it (clients ignore unknown fields).
- The server publishes `version`, `protocol` and `minClientProtocol` through `GET /health` (readable without a token). The same values are in the WebSocket's first frame (`hello`).
- The client sends its own number in an `X-Pipaya-Protocol` header on every request (`?protocol=` for EventSource and WebSocket).
- If that number is lower than the server's `minClientProtocol`, every route except `/health` is rejected with `426 client_too_old`, and the app guides the user to update.

The current values are `protocol` 1 and `minClientProtocol` 1.

## Client build and release

When a client change is pushed to `main`, CI (`client-release.yml`) builds all four platforms automatically, and when all succeed, it replaces the files of **the single `latest` release** wholesale.

| Platform | Build | Artifacts |
|---|---|---|
| Windows x64 | NSIS installer | `pipaya-windows-x64-setup.exe` (+ `.sig`) |
| macOS Apple Silicon | DMG and update bundle | `pipaya-macos-arm64.dmg`, `pipaya-macos-arm64.app.tar.gz` (+ `.sig`) |
| iOS | Unsigned IPA for devices | `pipaya-ios-arm64-unsigned.ipa` |
| Android arm64 | Signed APK | `pipaya-android-arm64.apk` |
| Common | Checksums, update manifest | `SHA256SUMS.txt`, `latest.json` |

- Every build gets a **rolling version** (`0.1.N`).
- The release is created as a draft and published, marked `latest`, after verification finishes.
- macOS is ad-hoc signed and not notarized. The Windows installer has no Authenticode signature.
- Update bundles are signed with the Tauri signing key.

### Required secrets (names only)

| Name | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Signing update bundles |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Signing the Android APK |
| `PIPAYA_FIREBASE_ANDROID_CONFIG` | Firebase config for Android push |

### General CI

`ci.yml` verifies the server (`typecheck`, `lint`, `test`) and the client (`check`, `test`, `build`).

### Deep links

The app registers the `pipaya://` scheme. The QR connection link (`pipaya://connect…`) is this, and on mobile it opens with the `connect` host. The app identifier is `work.pipaya.app`.

## Local build

```bash
cd client
bun run build              # static web bundle → dist/
bun run tauri dev          # desktop development run
bun run build:windows      # NSIS installer
bun run build:macos        # Apple Silicon DMG
bun run ios:init && bun run build:ios:unsigned
bun run android:init && bun run android:prepare && bun run build:android
```

Rust (stable) and the platform toolchains (Android SDK/NDK, Xcode, etc.) are required.
