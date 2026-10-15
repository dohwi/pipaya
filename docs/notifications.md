# 알림

작업이 끝났거나 승인이 필요할 때 사용자가 어느 기기에 있든 알려 주는 기능입니다. 서버가 어느 기기에 알릴지 **조율**하고, 클라이언트가 OS 알림을 띄웁니다.

## 정책

- 기본은 **꺼짐**입니다. 사용자가 **설정 → 일반 → 시스템 알림**에서 OS 권한을 직접 허용해야 하며, 확장이 권한창을 대신 띄울 수 없습니다.
- 같은 서버의 토큰을 쓰는 기기들은 **한 사용자**로 취급합니다. 다중 사용자 계정 시스템은 아닙니다.
- 어느 기기든 **앱 창이 보이고 포커스가 있으면** OS 알림과 푸시를 억제합니다.
- 아무 창도 보고 있지 않으면 **한 기기에만** 실시간 OS 알림을 보냅니다. 데스크톱이 우선이고, 그다음은 최근에 접속한 창입니다.
- **PC에서 읽지 않으면 폰으로**: PC가 알림을 띄웠더라도 설정한 시간(기본 3분, 1분~1시간 또는 끔) 동안 어느 기기에서도 앱을 열지 않으면 폰에 푸시합니다. 이 대기는 서버가 DB(`notification_escalations`)에 보관하므로 서버를 재시작해도 이어집니다. 이 값은 서버 범위 설정입니다 (`notificationPolicy.escalateMinutes`).
- PC가 꺼져 있거나 알림을 받을 창이 없으면 긴 대기 없이 **15초 지연** 뒤 바로 푸시합니다. 그 사이 PC가 알림을 처리했다고 확인하거나 앱을 다시 보면 모바일 중복 알림을 억제합니다.
- 포커스 상태는 15초마다 갱신되고 45초 뒤 만료됩니다. 기기 간 억제에는 네트워크 지연에 따른 짧은 경합이 있을 수 있고, **정확히 한 번 전달을 보장하지 않습니다.**
- 사용자가 직접 중단한 실행(`aborted`)에는 알리지 않습니다.
- 알림을 누르면 해당 세션이 열립니다. 알림에서 도구를 승인하지는 않습니다.

## 서버가 만드는 알림

작업 완료, 작업 실패, 승인 필요는 서버가 만듭니다. 문구는 **받는 기기의 언어**로 서버가 씁니다. 앱이 꺼진 폰으로 가는 푸시는 앱을 거치지 않기 때문에, 기기가 등록할 때 알려 준 언어(`lang`)를 서버가 기억해 둡니다.

- 제목은 무슨 일인지와 어느 대화인지, 본문은 미리보기입니다. 완료는 에이전트의 마지막 답변 일부입니다.
- 파일 내용 같은 도구 인자와 사용량은 알림에 넣지 않습니다. 알림 일부는 OS 알림 센터, 잠금화면, Google/Apple 전달 시스템을 거치므로 민감한 내용이 새지 않게 하려는 것입니다.
- 확장이 보내는 알림과 사용자 규칙은 쓴 그대로 보냅니다.

## 플랫폼 지원

| 플랫폼 | 실시간 OS 알림 | 앱 종료 상태 원격 푸시 |
|---|---|---|
| Windows / macOS | Tauri notification 플러그인 | 앱 프로세스가 종료되면 데스크톱 알림은 없음. 등록된 모바일로 대체 |
| Android APK | Tauri notification 플러그인 | FCM 등록 + Firebase 설정 시 지원 |
| iOS | 공통 Tauri 로컬 알림 | **네이티브 등록 미구현** |
| 웹 | 브라우저 Notification API (보안 컨텍스트와 권한 필요) | Service Worker / Web Push 미구현 |

Android에서 설정으로 앱을 **강제 종료**하면 사용자가 다시 열기 전까지 FCM을 못 받을 수 있습니다. 일반적인 프로세스 종료와 다릅니다.

## 서버 쪽 FCM 켜기

서버에 `HARNESS_PUSH_FCM=1`을 주면 Google Application Default Credentials로 FCM을 보냅니다. 자격 증명은 클라이언트나 확장에 절대 노출되지 않습니다. Android 앱 빌드와 `google-services.json` 준비는 저장소의 `client/docs/notifications.md`와 `client/docs/releases.md`를 보세요.

## API 요약

| 요청 | 용도 |
|---|---|
| `GET /notifications/status` | 푸시 설정 여부와 제공자 |
| `GET /notifications/devices` | 이 토큰으로 접속한 기기 목록. 푸시 토큰은 반환하지 않음 |
| `PUT /notifications/devices/:id` | 기기 하트비트 (`platform`, `focused`, `enabled`, `visibleSessionIds`, 이름, 모바일 푸시 토큰) |
| `DELETE /notifications/devices/:id` | 기기 제거. 기기는 `device_revoked`를 받고 보고를 멈춤 |
| `POST /notifications/:id/received` | 기기가 알림을 띄웠다고 확인 → 지연된 모바일 푸시 건너뜀 |
| `POST /notifications` | `{source, notification}` 확장·외부 알림. **5개 / 10초 / source**로 제한. `source: "harness"`는 예약 |
| `PUT/DELETE /notifications/rules/:owner/:id` | 확장 규칙 (`run_finished` / `approval_requested`의 기본 알림을 대체). owner당 최대 5개 |

## 확장에서 쓰기

`system-notifications` 권한이 있으면 `sdk.notifications.send / status / register / remove`를 쓸 수 있습니다. 규칙은 앱이 꺼져도 유지돼야 하므로 서버에 저장되고, 확장을 비활성화·삭제하거나 안전 모드로 들어가면 회수됩니다. 자세한 내용은 [SDK 레퍼런스](ext-sdk.md)를 보세요.
