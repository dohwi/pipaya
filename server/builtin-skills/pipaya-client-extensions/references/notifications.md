# 시스템 알림 · 모바일 푸시

## 정책

- **설정 → 일반 → 시스템 알림**에서 사용자가 직접 OS 권한을 허용합니다. 기본은 꺼짐이며 확장은 권한창을 자동으로 띄울 수 없습니다.
- 같은 pipaya 서버의 Bearer 토큰을 사용하는 기기들은 한 사용자로 취급합니다. 서버별로 독립이고 다중 사용자 계정 시스템은 아닙니다.
- 어느 기기든 앱 창이 보이고 포커스가 있으면 OS/푸시 알림을 억제합니다. 다른 세션을 보고 있어도 OS 알림은 억제하고 기존 읽지 않음 표시·앱 내부 알림·승인 UI는 유지합니다.
- 아무 창도 보고 있지 않으면 하나의 기기에만 라이브 OS 알림을 전달합니다. 데스크톱 우선, 그다음 최근 접속 창입니다.
- **PC에서 읽지 않으면 폰으로 (Discord 방식)**: PC가 알림을 표시했더라도 설정한 시간(기본 3분, 1분~1시간 또는 끔) 동안 어느 기기에서도 앱 창을 열어 보지 않으면 서버가 모바일로도 푸시합니다. 그 사이 한 번이라도 앱을 보면 취소하고, 승인 처리·새 실행 시작으로 불필요해진 알림도 취소합니다. 대기 중인 푸시는 DB에 저장되어 서버를 재시작해도 이어지며, 10분 넘게 지난 것은 버립니다. 이 시간은 서버 단위 설정(`notificationPolicy`)이라 같은 서버에 연결한 모든 기기에 똑같이 적용됩니다. 설정 → 일반 → 시스템 알림에서 바꿉니다.
- **서버가 직접 만드는 알림(작업 완료·실패·승인 필요)의 문구**: 서버가 받는 기기의 언어로 씁니다. 앱이 꺼진 폰으로 가는 푸시는 앱을 거치지 않으므로 서버가 쓴 문구가 그대로 보이기 때문입니다. 기기는 상태를 알릴 때마다 자기 언어(`lang`)를 함께 보내고, 서버가 모르면 영어로 씁니다.
  - 제목은 무슨 일인지와 어느 대화인지(`✅ 작업 완료 · 로그인 버그`), 본문은 미리보기입니다: 완료는 에이전트의 마지막 답변(마크다운과 코드 블록을 빼고 약 110자), 실패는 오류 원인, 승인 필요는 도구 이름과 명령·경로입니다. 20초 넘게 걸린 작업은 소요 시간을 덧붙입니다.
  - 파일 내용 등 그 밖의 도구 인자와 사용량은 알림에 넣지 않습니다. 답변 일부는 OS 알림 센터, 잠금화면, Google/Apple 전달 시스템을 거치므로 민감한 내용이 있다면 이 점을 고려하세요.
  - 확장이 보내는 알림과 사용자 규칙의 제목·본문은 쓴 그대로 보냅니다.
- PC가 꺼져 있거나 알림을 받을 창이 없으면 위의 긴 대기 없이 아래 15초 지연 뒤 바로 푸시합니다.
- 모바일 푸시는 15초 지연합니다. PC/다른 기기가 OS 알림을 처리했다고 확인하거나 그사이 앱을 다시 보면 모바일 중복 알림을 억제합니다. 살아 있는 것처럼 보이는 소켓이 응답하지 않으면 푸시로 대체합니다.
- 포커스 상태는 15초마다 갱신하고 45초 뒤 만료됩니다. 기기 간 억제는 네트워크 지연에 따른 짧은 경합이 있을 수 있으며 정확히 한 번 배달 보장은 아닙니다.
- 작업 완료·실패·승인 필요는 서버에서 생성합니다. 사용자가 중단한 실행(`aborted`)에는 알리지 않습니다. 확장은 사용자 요청(`user_request`)을 보낼 수 있지만 이것이 에이전트의 질문을 자동 감지하는 기능은 아닙니다.
- 알림 클릭은 해당 세션을 엽니다. **알림 자체에서 도구 승인을 실행하지 않습니다.**

## 플랫폼 지원 상태

| 플랫폼 | 라이브 OS 알림 | 앱 종료 상태 원격 푸시 |
|---|---|---|
| Windows EXE / macOS DMG | Tauri notification plugin | 앱 프로세스가 종료되면 데스크톱 알림 없음; 등록된 모바일로 대체 |
| Android APK | Tauri notification plugin | FCM 네이티브 등록 + Firebase 설정 시 지원. 실기기 검증 필요 |
| iOS | 앱(IPA) 지원 종료 | 배포 안 함. 서버 푸시 코드와 `NativePushAdapter` 확장 지점만 남아 있음 |
| 웹 | 브라우저 Notification API, 권한 및 secure context 필요 | Service Worker/Web Push 미구현 |

Android OS 설정의 **강제 종료(force-stop)**는 일반적인 프로세스 종료와 다릅니다. 강제 종료된 앱은 사용자가 다시 열기 전 FCM을 받지 못할 수 있습니다. APNs/FCM은 전달 지연·OS 정책·네트워크 상태의 영향을 받습니다.

## Android FCM 설정

1. Firebase 프로젝트에 Android 앱 `work.pipaya.app`를 등록합니다.
2. 내려받은 `google-services.json`을 저장소 밖(`~/.secrets/pipaya/google-services.json`)에 보관합니다.
3. Android 프로젝트 초기화 후 빌드 준비 스크립트를 실행합니다 (`~/.secrets/pipaya/google-services.json`에 있으면 자동 인식되며, 다른 경로일 경우 `PIPAYA_FIREBASE_ANDROID_CONFIG` 지정 가능).

```sh
cd client
bun run android:init
# ~/.secrets/pipaya/google-services.json 에 파일이 있으면 환경 변수 없이 바로 실행 가능:
bun run android:prepare

# 다른 위치에 보관 중인 경우 환경 변수로 경로 지정:
# PIPAYA_FIREBASE_ANDROID_CONFIG=~/.secrets/pipaya/google-services.json bun run android:prepare

# 기존 Android 서명용 환경 변수도 그대로 필요
bun run build:android
```

준비 스크립트는 올바른 application ID를 검증하고 Firebase public 앱 설정을 생성된 Android resource에 넣습니다. Firebase 서비스 계정 비밀키를 APK에 넣지 마세요. 설정이 없으면 APK는 정상 빌드되지만 원격 푸시 등록은 지원하지 않는 것으로 표시합니다. CI도 `android:prepare` 전에 같은 환경 변수와 파일을 공급해야 합니다. 현재 기본 릴리스 CI는 Firebase 파일을 자동 복원하지 않습니다.

서버에서는 Google Application Default Credentials를 사용합니다. `~/.secrets/pipaya/firebase-adminsdk.json`이 존재하면 자동으로 인식하며, 명시적으로 지정할 수도 있습니다.

```sh
# ~/.secrets/pipaya/firebase-adminsdk.json 이 있으면 PIPAYA_PUSH_FCM=1 만으로 동작
PIPAYA_PUSH_FCM=1 bun run start

# 또는 명시적 경로 지정
PIPAYA_PUSH_FCM=1 \
GOOGLE_APPLICATION_CREDENTIALS="$HOME/.secrets/pipaya/firebase-adminsdk.json" \
bun run start
```

서버 토큰·서비스 계정·기기 푸시 토큰은 확장 SDK에 노출하지 않습니다. 알림 제목/본문은 OS 및 Google/Apple 전달 시스템에 전송될 수 있으므로 비밀·도구 인자·대화 원문을 넣지 마세요. 내장 알림은 원문 없이 일반 문구와 세션 ID만 사용합니다.

## iOS 확장 지점 (IPA 배포 종료)

IPA 배포는 지원 종료됐고 공식 빌드는 APK·EXE·DMG만 제공합니다. 아래는 서버/SDK에 남은 확장 지점입니다. 정책과 SDK는 OS에 종속되지 않습니다.

- `DevicePlatform`: `desktop | android | ios | web`
- 등록: `{provider: 'fcm' | 'apns', token}`. Android는 FCM, iOS는 FCM/APNs 중 선택할 수 있습니다.
- 서버 `PushTransports`는 제공자별 전송 어댑터입니다. 현재 기본 구현은 FCM이며 iOS FCM 메시지에는 APNs alert/expiry/thread 정보가 포함됩니다. Firebase에 Apple APNs 키/인증서를 등록해야 합니다. **직접 APNs 전송 구현은 아직 없습니다.**
- 클라이언트 `NativePushAdapter`는 `register`, `onTokenChanged`, `onTap`만 제공합니다. iOS 네이티브 구현을 추가해 `nativePushAdapter()`에서 선택하면 공통 Presence/SDK를 재작성할 필요가 없습니다.
- iOS native lifecycle에 APNs 등록 성공/실패, 토큰 갱신, 앱 종료 상태 알림 클릭, foreground presentation 억제를 연결합니다. Tauri 로컬 알림 플러그인의 `UNUserNotificationCenterDelegate`와 충돌하지 않게 통합해야 합니다.
- Xcode에서 Push Notifications capability, 올바른 `aps-environment` entitlement, Apple Developer 팀과 provisioning profile, 서명/IPA 내보내기 설정이 필요합니다. 백그라운드 silent push만으로 알림을 보장하지 말고 사용자 표시용 alert push를 사용합니다.

## 확장 SDK

기존 `notifications` 권한과 `show(text)`는 **앱 내부 토스트만** 유지합니다. OS/푸시 능력에는 별도 **`system-notifications`** 권한이 필요합니다.

```js
// manifest.permissions: ['system-notifications']
const status = await sdk.notifications.status();
// {enabled, permission, pushConfigured}; 토큰은 없음
await sdk.notifications.send({
  title: '확인해 주세요', body: '배포 대상을 선택해야 합니다.',
  kind: 'user_request', sessionId: 'session-id', key: 'deploy-request-1'
});
// {id, delivered, suppressed}; delivered는 라이브 전송 대상 수이지 OS/푸시 수신 보장이 아님

// 앱이 닫혀 있어도 서버가 실행하는 데이터-only 규칙
await sdk.notifications.register('done', {
  event: 'run_finished', title: '작업이 끝났습니다'
});
await sdk.notifications.register('approval', {
  event: 'approval_requested', title: '도구 승인이 필요합니다'
});
await sdk.notifications.remove('done');
```

- `send`: title 100자, body 300자, sessionId/key 80자. 알 수 없는 필드·임의 URL·force·액션은 거부합니다. 제목에는 확장 이름을 호스트가 붙입니다.
- 종류: `task_completed`, `task_failed`, `approval_required`, `user_request`, `info`.
- `key`는 같은 서버/확장 안에서 24시간 중복 억제합니다. 이벤트 재수신 후 SDK 발송에도 사용하는 것을 권장합니다.
- 확장당 10초에 5개, 서버 규칙은 확장당 5개입니다. 여러 기기가 동일 확장/규칙 ID를 등록하면 같은 서버 등록을 갱신합니다.
- 서버 규칙은 코드/필터/대화/도구 인자를 받지 않고 `run_finished`와 `approval_requested`만 지원합니다. 해당 이벤트에 확장 규칙이 있으면 기본 시스템 알림 대신 등록된 규칙을 사용합니다.
- 비활성화·삭제·패키지 교체·실패·안전 모드는 해당 확장의 서버 규칙을 해제합니다. 오프라인 해제는 로컬 큐에 남겨 재연결 시 재시도하며, 서버에 도달하기 전까지 기존 규칙이 동작할 수 있습니다.
- 단순 앱 종료·페이지 새로고침에는 서버 규칙을 지우지 않습니다. 클라이언트 Worker 자체는 종료 상태에서 실행되지 않습니다.
- `events` 권한의 이벤트 목록에 `approval_requested`/`approval_resolved`가 추가됩니다. 메타데이터만 전달하고 원문과 도구 인자는 제외합니다.

## 코드와 검증

서버: `notifications.ts`, `notification-routes.ts`, `push.ts`; 기기/규칙/중복 키는 SQLite, 포커스 lease는 메모리입니다. 서버 재시작 시 lease만 초기화되고 등록은 유지합니다. 15초 지연 타이머는 내구성 큐가 아니므로 그 15초 안에 서버가 재시작하면 해당 알림은 유실될 수 있습니다. "PC에서 읽지 않으면 폰으로" 대기는 `notification_escalations` 테이블에 저장되어 재시작 후에도 이어집니다.

클라이언트: `notifications.ts`, `notification-contract.ts`, `notification-rules.ts`, `native-push.ts`, `NotificationSettings.svelte`; 네이티브 Android 플러그인: `src-tauri/plugins/push/`.

```sh
cd client && bun run check && bun test tests && bun run build
cd ../server && bun run typecheck && bun test
```

출시 전 실제 Windows/macOS/Android/iOS 기기에서 권한 거부·앱 포커스·PC↔모바일 전환·백그라운드·종료·알림 클릭·토큰 갱신·삭제·FCM/APNs 설정 오류를 확인해야 합니다. 브라우저 테스트와 ARM64 컴파일만으로 푸시 실기기 검증을 대신하지 않습니다.
