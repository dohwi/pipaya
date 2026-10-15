# Client builds and rolling release

## Downloads

[Latest client build](https://github.com/dohwi/pipaya/releases/tag/latest):

| Asset | Platform |
|---|---|
| `harness-windows-x64-setup.exe` | Windows x64 NSIS installer |
| `harness-macos-arm64.dmg` | macOS Apple Silicon (M1 and later), ad-hoc signed, not notarized |
| `harness-android-arm64.apk` | Android 7+ ARM64, signed release APK |
| `harness-ios-arm64-unsigned.ipa` | iPhone/iPad ARM64, unsigned package for re-signing; not directly installable |
| `SHA256SUMS.txt` | SHA-256 checksums for all four downloads |
| `latest.json`, `*.sig`, `harness-macos-arm64.app.tar.gz` | Update manifest, signatures and the macOS update bundle used by the in-app updater; not for manual download |

`install.sh client` (macOS) and `install.ps1` (Windows) in the repository root download these files and verify them against `SHA256SUMS.txt` before opening them.

The server is not bundled. Run the server separately and enter its URL and token in the app. For a server on a Tailscale network, use its Tailscale address (for example `http://100.64.0.1:8787`) with Tailscale connected on the device; `localhost` on a phone refers to the phone itself.

Android release builds allow user-configured HTTP endpoints. Only use HTTP inside a trusted network such as Tailscale; use HTTPS otherwise. The Windows installer is not Authenticode-signed and may trigger SmartScreen.

The macOS app is ad-hoc signed for Apple Silicon but has no Apple Developer ID signature or notarization. Mount the DMG and drag `pipaya.app` to Applications. Gatekeeper may block the first launch: for a download you trust, open **System Settings → Privacy & Security → Open Anyway** after attempting to launch it. Do not disable Gatekeeper globally. An Intel Mac is not supported by this DMG.

## Automation

`.github/workflows/client-release.yml` runs when `client/**` or the workflow changes on `main`, or manually via **Actions → Client release → Run workflow** (select `main`).

1. Install the locked Bun dependencies, run Svelte checks, tests, and frontend build.
2. Build the Windows x64 NSIS installer on Windows, Apple Silicon DMG on macOS 15, unsigned iOS ARM64 IPA on macOS 15, and signed Android ARM64 APK on Linux.
3. Verify the macOS app's ARM64 architecture and ad-hoc signature, disk image integrity, iOS device architecture/package metadata, and APK signature; upload short-lived build artifacts (3-day retention).
4. Only after all four builds succeed, update the fixed `latest` tag and release assets. Builds no longer at the tip of `main` do not publish.

No per-version releases are created. Existing unrelated releases are deliberately not deleted. New assets are uploaded under temporary names before the previous files are replaced, so compilation or upload failures preserve the old downloads. GitHub cannot atomically swap multiple release assets: an API failure during the final rename step can still require rerunning the workflow. Publishing is serialized and never automatically cancelled midway.

Build versions are `0.1.<GitHub run number>`. Android `versionCode` is `100000 + run number`, enabling installation over the previous build with the same signing key. Rerunning the same Actions run uses the same version. The rolling version scheme must be revised before run number 65536 due to Windows version limits. Keep the workflow filename/run counter and Android signing key stable.

## In-app updates

| Platform | Behavior |
|---|---|
| Windows, macOS | The Tauri updater checks `latest.json` at startup (at most every 6 hours) and from Settings → General → App updates. Pressing **Update** downloads the bundle, verifies its signature against the public key in `tauri.conf.json`, installs it and restarts. Nothing installs without that click. |
| Android | The system installer must confirm every install, so the app only detects a newer `Version:` in the `latest` release and opens the APK download. |
| iOS, browser | No update check. |

Updater signing is separate from Android signing. Register these repository secrets as well:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the updater private key (`tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password |

The matching public key is committed in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). **Back up the private key and password offline.** If either is lost, installed apps can no longer verify any update, and every user has to reinstall by hand. Rotating the key has the same effect.

`createUpdaterArtifacts` is switched on only by the release workflow, so local builds do not need the private key. Because the Windows and macOS builds must be signed for `latest.json` to be valid, a missing secret fails the whole run instead of publishing a release that cannot update.

The first build that contains the updater has to be installed by hand; earlier installs have no updater. The version must increase for an update to be offered, which the workflow's `0.1.<run number>` scheme guarantees.

Play Store deployment is not configured.

## Android signing secrets

Register these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Signing key alias |
| `ANDROID_KEY_PASSWORD` | Key password |

Never commit keystores or passwords. Back up the keystore and passwords offline: GitHub cannot return the original secret values. Losing or changing the signing key prevents updating existing installations without uninstalling them (which deletes local app data).

The workflow restores the key in the runner's temporary directory, passes credentials directly to Gradle, verifies the resulting signature with `apksigner`, and deletes the temporary key even on failure. Build jobs have read-only repository permissions; only the publish job can write releases.

## Local Windows build

Install Bun, Rust (MSVC), Visual Studio Build Tools with **Desktop development with C++** and the Windows SDK. WebView2 Runtime is required to run the app.

```powershell
cd client
bun install --frozen-lockfile
bun run check
bun run build:windows
```

The installer is under `src-tauri/target/release/bundle/nsis/`.

## Local Apple Silicon macOS build

On an Apple Silicon Mac, install Xcode Command Line Tools (`xcode-select --install`), Bun, and Rust. Add the ARM64 target:

```bash
rustup target add aarch64-apple-darwin
cd client
bun install --frozen-lockfile
bun run check
bun run build:macos --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}' -- --locked
```

The DMG is under `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`. CI explicitly uses ad-hoc signing (`signingIdentity: "-"`), verifies the app with `codesign`, and checks the DMG with `hdiutil verify`. No Apple credentials are needed for this test distribution. Developer ID signing and Apple notarization are separate future work and require an Apple Developer account and signing credentials.

## Unsigned iOS IPA

`harness-ios-arm64-unsigned.ipa` is an iPhone/iPad device build (ARM64, minimum iOS 15), **not a simulator build and not an install-ready signed IPA**. Tauri's `ios build --no-sign` archives the app without Apple signing and packages it as `Payload/*.app` inside the IPA. No Apple account or credentials are used by CI.

To install on a normal device, re-sign with a valid Apple signing identity and matching provisioning profile, including device registration where required. A sideloading tool such as AltStore or Sideloadly can handle personal-account signing, subject to Apple's expiry and account restrictions. The unsigned release cannot be uploaded directly to TestFlight/App Store. Official distribution requires Apple Developer membership and a signed export workflow, not merely renaming this file.

`src-tauri/Info.ios.plist` permits user-configured HTTP/WebView endpoints and describes local-network access. Use HTTPS on untrusted networks. These transport exceptions must be reconsidered for App Store review. Packaging checks do not replace real-device install, permissions, and connectivity testing.

Local unsigned build on a Mac with full Xcode, Bun, Rust, XcodeGen, and CocoaPods:

```bash
brew install xcodegen cocoapods
rustup target add aarch64-apple-ios
cd client
bun install --frozen-lockfile
bun run ios:init --ci --skip-targets-install
bun run build:ios:unsigned --ci -- --locked
```

The generated IPA is under `src-tauri/gen/apple/` (search recursively for `*.ipa`). iOS CLI commands are available only on macOS; this Linux VM cannot compile an IPA locally. CI checks the ZIP integrity, app identifier, `iPhoneOS` platform, ARM64 executable, absence of a provisioning profile, and HTTP transport configuration before publishing.

## Local Android build

Toolchain for the locked Tauri CLI 2.12.2: JDK 17, SDK platform 37 (`platforms;android-37.0`), Build Tools 37.0.0, NDK 29.0.13846066, and Rust target `aarch64-linux-android`.

```bash
export JAVA_HOME="<JDK 17 directory>"
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.13846066"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

sdkmanager "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" "ndk;29.0.13846066"
rustup target add aarch64-linux-android

cd client
bun install --frozen-lockfile
bun run android:init --ci --skip-targets-install
```

For a debug build, before applying the release signing configuration:

```bash
bun run tauri android build --debug --apk --target aarch64
```

For a signed release, supply all four signing environment variables (the local path is used instead of the Base64 secret):

```bash
export ANDROID_KEYSTORE_PATH="<absolute path to release keystore>"
export ANDROID_KEYSTORE_PASSWORD="<keystore password>"
export ANDROID_KEY_ALIAS="harness"
export ANDROID_KEY_PASSWORD="<key password>"

bun run android:prepare
bun run build:android -- --locked
```

After `android:prepare`, Gradle requires signing credentials even for debug tasks; regenerate the Android project if switching back to an unsigned development setup. Generated Android files are ignored by Git and recreated/patched by CI. The preparation script is idempotent and fails if required Tauri template anchors change.

APKs are under `src-tauri/gen/android/app/build/outputs/apk/`. To update an installation from GitHub locally, use the same release key and a `bundle.android.versionCode` override greater than its installed version. A default local `0.1.0` build has a lower version code than CI builds.

Verify and install:

```bash
"$ANDROID_HOME/build-tools/37.0.0/apksigner" verify --verbose "<APK path>"
adb install -r "<APK path>"
```
