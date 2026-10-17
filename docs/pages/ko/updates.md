서버와 앱을 최신으로 유지하는 방법, 클라이언트가 빌드되고 배포되는 방식, 호환성 규칙을 설명합니다.

## 한눈에 보기

| 대상 | 방법 | 사용자 확인 |
|---|---|---|
| 서버 | 앱의 **서버 업데이트**, `install.sh update`, 또는 Docker 재빌드 | 앱에서 누름 |
| Windows·macOS 앱 | 앱 안 업데이트 (서명 검증 후 설치, 앱 재시작) | 버튼을 눌러야 설치됨 |
| Android 앱 | 앱 안에서 APK를 내려받아 시스템 설치 화면 열기 | 시스템이 한 번 더 확인 |
| iOS 앱 | 서명 없는 IPA를 직접 다시 설치 | 수동 |
| 웹 클라이언트 | 서버를 업데이트하고 클라이언트 빌드를 다시 만들어 배포 | 수동 |

## 서버 업데이트

### 앱에서

앱은 서버의 `GET /server/update`로 새 커밋이 있는지 확인하고, 있으면 **서버 업데이트**를 보여 줍니다. 앱을 업데이트할 때는 **서버도 함께 업데이트** 선택지가 나오며, 서버를 먼저 업데이트하고 다시 시작한 뒤 앱을 업데이트합니다(앱 설치가 앱을 재시작해 그 뒤 단계가 실행되지 않기 때문).

`POST /server/update`가 하는 일:

::: steps
### 확인

이 체크아웃이 추적하는 브랜치에 새 커밋이 있는지 `git fetch --depth 1`로 확인합니다.

### 실행 중 대화 확인

실행 중인 대화가 있으면 `409 sessions_running`으로 거부합니다. `{"force": true}`를 주면 무시하고 진행합니다.

### 이동과 설치

새 커밋으로 옮기고 의존성을 설치합니다. 설치에 실패하면 이전 버전으로 되돌리고 `502 update_failed`를 돌려줍니다.

### 재시작

프로세스를 종료합니다. 서비스 관리자(systemd·launchd)가 새 코드로 다시 띄웁니다.
:::

관리자 토큰만 쓸 수 있습니다. QR로 연결한 기기 토큰은 `403 admin_only`입니다.

### 업데이트할 수 없는 경우

서버는 이유를 응답에 담습니다(`reason`).

| `reason` | 의미 | 조치 |
|---|---|---|
| `disabled` | `PIPAYA_SELF_UPDATE=0` | 끈 상태. 켜려면 값을 지우거나 `1` |
| `not_git` | 코드 폴더에 `.git`이 없음 (Docker 이미지, 컴파일된 바이너리) | 이미지를 다시 빌드하거나 배포 방식대로 교체 |
| `unmanaged` | 프로세스를 다시 띄워 줄 감독자를 못 찾음 | systemd·launchd 서비스로 실행하거나 `PIPAYA_SELF_UPDATE=1` 지정 |
| `detached` | 태그나 커밋에 고정된 체크아웃 (브랜치가 아님) | 고정한 선택이므로 서버가 옮기지 않음. 브랜치로 바꾸기 |
| `fetch_failed` | 원격에서 가져오지 못함 | 네트워크·원격 접근 확인 |

"감독자"는 systemd가 설정하는 `INVOCATION_ID` 환경 변수가 있거나, macOS launchd가 설정하는 `XPC_SERVICE_NAME`이 `app.pipaya.server`인 경우로 자동 판단합니다. `install.sh`가 만든 서비스가 여기에 해당합니다. 다른 감독 프로세스를 쓴다면 `PIPAYA_SELF_UPDATE=1`로 강제로 켭니다.

### 스크립트로

```bash
install.sh update      # 최신 코드를 받고 서비스를 다시 시작
```

### Docker

```bash
git pull
docker compose up -d --build
```

## 클라이언트 업데이트

### Windows·macOS

Tauri 업데이터를 씁니다. 업데이트 정보는 릴리스의 `latest.json`에서 읽고, 내려받은 번들은 앱에 내장된 **공개 키로 서명을 검증**한 뒤 설치하며 앱을 다시 시작합니다. 사용자가 버튼을 누르기 전에는 아무것도 설치되지 않습니다.

### Android

Android는 앱이 스스로 조용히 설치할 수 없습니다. 앱이 GitHub `latest` 릴리스의 본문에서 `Version: x.y.z` 줄을 읽어 현재 버전과 비교하고, 더 새로우면 진행률과 함께 APK를 앱 안에서 내려받아 시스템 설치 화면에 넘깁니다. APK 링크는 `https://github.com/dohwi/pipaya/releases/download/latest/` 아래의 것만 인정합니다. 설치를 허용하지 않은 상태라면 설정에서 이 앱의 설치를 허용하고 돌아오면 설치 화면이 이어서 열립니다.

### 설정

설정 → 일반의 **업데이트**:

| 항목 | 설명 |
|---|---|
| 업데이트 확인 | 지금 확인 |
| 시작할 때 새 버전 확인 | 앱을 켤 때 자동 확인 |
| 서버 버전 | 연결한 서버의 버전 표시 |
| 서버도 함께 업데이트 | 앱 업데이트 때 서버를 먼저 업데이트 (실행 중인 대화가 있으면 서버는 건너뜀) |

새 버전이 있으면 상단에 **업데이트 배너**가 뜨고 "나중에"로 미룰 수 있습니다. 서버를 업데이트하는 동안에는 "서버가 다시 시작되기를 기다리는 중…"이 표시됩니다.

## 호환성 (protocol)

서버와 앱은 정수 **`protocol`** 번호로 호환성을 맞춥니다.

- `protocol`은 REST·WebSocket·SSE의 형식이 바뀌어 **이전 상대가 처리하지 못할 때만** 올립니다. 필드나 라우트를 추가하는 것만으로는 올리지 않습니다(클라이언트는 모르는 필드를 무시).
- 서버는 `GET /health`로 `version`, `protocol`, `minClientProtocol`을 공개합니다(토큰 없이 읽을 수 있음). WebSocket 첫 프레임(`hello`)에도 같은 값이 들어 있습니다.
- 클라이언트는 모든 요청에 `X-Pipaya-Protocol` 헤더(EventSource·WebSocket은 `?protocol=`)로 자기 번호를 보냅니다.
- 그 번호가 서버의 `minClientProtocol`보다 낮으면 `/health`를 뺀 모든 경로가 `426 client_too_old`로 거절되고, 앱이 사용자에게 업데이트를 안내합니다.

지금 값은 `protocol` 1, `minClientProtocol` 1입니다.

## 클라이언트 빌드와 릴리스

`main`에 클라이언트 변경이 푸시되면 CI(`client-release.yml`)가 네 플랫폼을 자동으로 빌드하고, 모두 성공하면 **하나뿐인 `latest` 릴리스**의 파일을 통째로 교체합니다.

| 플랫폼 | 빌드 | 산출물 |
|---|---|---|
| Windows x64 | NSIS 설치 파일 | `pipaya-windows-x64-setup.exe` (+ `.sig`) |
| macOS Apple Silicon | DMG와 업데이트 번들 | `pipaya-macos-arm64.dmg`, `pipaya-macos-arm64.app.tar.gz` (+ `.sig`) |
| iOS | 서명 없는 기기용 IPA | `pipaya-ios-arm64-unsigned.ipa` |
| Android arm64 | 서명된 APK | `pipaya-android-arm64.apk` |
| 공통 | 체크섬, 업데이트 매니페스트 | `SHA256SUMS.txt`, `latest.json` |

- 빌드마다 **롤링 버전**(`0.1.N`)이 붙습니다.
- 릴리스는 초안으로 만들었다가 검증이 끝난 뒤 공개되고 `latest`로 표시됩니다.
- macOS는 ad-hoc 서명이며 공증되지 않았습니다. Windows 설치 파일은 Authenticode 서명이 없습니다.
- 업데이트 번들은 Tauri 서명 키로 서명됩니다.

### 필요한 시크릿 (이름만)

| 이름 | 용도 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 업데이트 번들 서명 |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Android APK 서명 |
| `PIPAYA_FIREBASE_ANDROID_CONFIG` | Android 푸시용 Firebase 설정 |

### 일반 CI

`ci.yml`은 서버(`typecheck`, `lint`, `test`)와 클라이언트(`check`, `test`, `build`)를 검증합니다.

### 딥링크

앱은 `pipaya://` 스킴을 등록합니다. QR 연결 링크(`pipaya://connect…`)가 이것이며, 모바일에서는 `connect` 호스트로 열립니다. 앱 식별자는 `work.pipaya.app`입니다.

## 로컬 빌드

```bash
cd client
bun run build              # 정적 웹 번들 → dist/
bun run tauri dev          # 데스크톱 개발 실행
bun run build:windows      # NSIS 설치 파일
bun run build:macos        # Apple Silicon DMG
bun run ios:init && bun run build:ios:unsigned
bun run android:init && bun run android:prepare && bun run build:android
```

Rust(stable)와 플랫폼별 툴체인(Android SDK/NDK, Xcode 등)이 필요합니다.
