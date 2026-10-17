서버는 **API 전용**입니다. HTML이나 API 문서 페이지를 제공하지 않고, 앱(클라이언트)과 독립적으로 실행됩니다. 이 문서는 라우트 전체를 `server/src`의 등록 코드에서 옮겨 정리한 것입니다.

## 인증과 공통 규칙

```bash
TOKEN="$(< ~/.pipaya/token)"
curl -H "Authorization: Bearer $TOKEN" http://<서버 주소>:8787/configuration
```

| 항목 | 규칙 |
|---|---|
| 헤더 | `Authorization: Bearer <토큰>` — 관리자 토큰 또는 기기 토큰 |
| 공개 경로 | `GET /health`, `POST /pairing/redeem` |
| `?token=` 허용 | `/ws`, `/events`, `/sessions/:id/events`, `/terminals/:id/ws` 만 (브라우저 스트림용) |
| 관리자 전용 | `POST`/`DELETE /pairing`, `GET /devices/tokens`, `DELETE /devices/tokens/:id`, `POST /server-extensions/reload`, `GET`/`POST /server/update` |
| 호환성 | `X-Pipaya-Protocol` 헤더 (스트림은 `?protocol=`). 서버의 `minClientProtocol`보다 낮으면 `426 client_too_old` |
| CORS | 루프백·Tailscale·사설망·Tauri 출처는 항상 허용, 그 밖은 `PIPAYA_CORS_ORIGINS` |
| 요청 크기 | 기본 2MB, `POST /sessions/:id/messages`는 192MB, 클라이언트 설정은 16MiB |

### 오류 형식

```json
{ "error": { "code": "invalid_request", "message": "..." } }
```

요청 스키마(TypeBox)가 검증과 핸들러 타입을 제공합니다. API 메시지와 `GET /tools` 설명은 영어이고 UI 번역은 클라이언트가 합니다.

| HTTP | `code` | 의미 |
|---|---|---|
| 400 | `invalid_request` | 요청이 잘못됨 |
| 400 | `update_unavailable` | 이 서버는 스스로 업데이트할 수 없음 |
| 401 | `unauthorized` | 토큰이 없거나 틀림 |
| 403 | `admin_only` | 기기 토큰으로 관리자 전용 경로를 부름 |
| 403 | `invalid_pairing_code` | 연결 코드가 유효하지 않음 |
| 403 | `terminals_disabled` | 서버가 `PIPAYA_TERMINAL=0` |
| 404 | `not_found` | 대상이 없음 |
| 409 | `conflict` | 상태가 맞지 않음 (실행 중, 압축 중, 닫힌 세션 등) |
| 409 | `sessions_running` | 실행 중인 대화가 있어 업데이트 거부 |
| 409 | `too_many_terminals` | 터미널 16개 한도 |
| 409 | `up_to_date` / `update_in_progress` | 업데이트 관련 |
| 413 | `payload_too_large`, `too_large` | 요청·파일이 너무 큼 |
| 426 | `client_too_old` | 앱이 너무 오래됨 |
| 429 | `pairing_throttled`, `notification_limit` | 시도·알림이 너무 많음 |
| 500 | `internal_error` | 서버 오류 |
| 501 | `compaction_not_supported` | 이 서버는 압축을 지원하지 않음 |
| 502 | `upstream_error`, `update_failed` | 모델 호출 실패 / 업데이트 설치 실패 |

## 상태와 업데이트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | 공개. `ok`, `version`, `protocol`, `minClientProtocol`. 토큰을 붙이면 `uptimeMs`, `runningSessions`, `subscribers`도 |
| GET | `/server/update` | **관리자.** 새 커밋이 있는지, 스스로 재시작 가능한지(`managed`, `reason`) |
| POST | `/server/update` | **관리자.** `{force?}` 새 커밋으로 이동 → 의존성 설치 → 프로세스 종료(서비스 관리자가 재시작). 실행 중 대화가 있으면 `409 sessions_running` |
| GET | `/tools` | 도구 목록과 기본값 |
| GET | `/workspace` | 기본 작업 디렉터리(`root`), 홈, 폴더별 활성·닫힌 세션 수 |
| GET | `/activity` | 세션별 실행 중·승인 대기 상태 |

## 세션

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/sessions` | 생성. `{title?, cwd?, provider?, model?, thinkingLevel?, systemPrompt?, tools?, approval?}` |
| GET | `/sessions` | 목록. `?limit=1..200(50)&before=&closed=` → `{sessions, nextBefore}` |
| POST | `/sessions/delete` | 일괄 삭제 `{ids: 1..500}` → `{deleted, skipped}` (실행 중·대기 중은 건너뜀) |
| GET / PUT | `/sessions/retention` | 자동 삭제 정책 `{enabled, days: 1..3650, onlyClosed}`, 마지막 실행, 지금 삭제 대상 수 |
| GET | `/sessions/:id` | 조회 |
| PATCH | `/sessions/:id` | 수정 `{title?, purpose?, provider?, model?, thinkingLevel?, systemPrompt?*, tools?*, approval?, closed?}` (*첫 메시지 전에만) |
| DELETE | `/sessions/:id` | 삭제 (204) |
| GET | `/sessions/:id/status` | 실행 상태, 스트리밍 중인 부분 메시지, 대기열, 대기 중 승인·질문 |
| GET | `/sessions/:id/usage` | 토큰·비용 합계 |
| GET | `/sessions/:id/context` | 컨텍스트 스냅샷(AGENTS.md, 스킬, 시스템 프롬프트, 읽은 파일) |
| POST | `/sessions/:id/messages` | 전송 `{text, mode?, images?, files?}` → `202`. 본문 한도 192MB |
| GET | `/sessions/:id/messages` | 저장된 기록. `?after=&limit=1..5000(1000)` |
| POST | `/sessions/:id/abort` | 중단 → `{aborted}` |
| POST | `/sessions/:id/queue/cancel` | 대기열 메시지 취소 `{mode: "steer"\|"follow_up", text}` → `{cancelled}` |
| POST | `/sessions/:id/retry` | 재시도 → `202` |
| POST | `/sessions/:id/fork` | 분기 `{atSeq?, title?}` → `201` |
| POST | `/sessions/:id/compact` | 압축 `{customInstructions?}` (최대 2,000자) |
| GET | `/sessions/:id/files` | 작업 폴더의 파일 내려받기. `?path=` (최대 50MB, 웹 페이지로 실행 불가 헤더) |
| GET | `/sessions/:id/extension-entries` | 서버 확장이 남긴 기록. `?extension=&type=` |

메시지 전송 본문:

```json
{
  "text": "…",
  "mode": "prompt",
  "images": [{ "type": "image", "data": "<base64>", "mimeType": "image/png" }],
  "files":  [{ "name": "report.pdf", "data": "<base64>" }]
}
```

`mode`는 `prompt`(대기 중일 때만), `steer`, `follow_up`입니다. `images`는 최대 8개, `files`는 최대 8개(개당 50MB, 합계 100MB)입니다.

## 승인과 질문

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/approvals` | 대기 중인 승인. `?sessionId=` |
| POST | `/sessions/:id/approvals/:toolCallId` | 결정 `{approved, reason?(≤2000자)}` |
| GET | `/questions` | 대기 중인 `ask_user` 질문 |
| POST | `/sessions/:id/questions/:toolCallId` | 답변 `{answer}` 또는 여러 질문이면 `{answers: […]}` (각 ≤10,000자) |

## 모델과 프로바이더

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/models` | 카탈로그. `?provider=&configured=true` |
| GET | `/providers` | 사용 가능 여부와 로그인 방식 (키 값은 안 돌려줌) |
| POST | `/providers/:id/login` | 로그인 시작 `{type: "api_key"\|"oauth"}` |
| GET | `/logins/:id` | 진행 상태(열 링크, 기기 코드, 대기 질문) |
| POST | `/logins/:id/answer` | 질문에 답 `{promptId, value}` |
| POST | `/logins/:id/cancel` | 취소 |
| PUT | `/providers/:id/credential` | 키 저장 `{key}` |
| DELETE | `/providers/:id/credential` | 키 삭제 |
| GET | `/configuration` | 커스텀 프로바이더와 기본값 (비밀 제외) |
| GET | `/configuration/catalog` | 모델 ID 자동완성용 번들 카탈로그 |
| POST | `/configuration/discover` | 엔드포인트의 모델 목록 가져오기 |
| PUT | `/configuration/providers/:id` | 커스텀 엔드포인트 생성·수정 |
| POST | `/configuration/providers/:id/refresh` | 업스트림과 모델 목록 동기화 |
| DELETE | `/configuration/providers/:id` | 엔드포인트와 저장된 키 삭제 |
| PUT | `/configuration/defaults` | 기본 모델 `{provider, model}` (`null`로 되돌림) |
| PUT | `/configuration/workdir` | 기본 작업 폴더 `{path}` (`null`로 되돌림) |
| PUT | `/configuration/approval` | 기본 승인 정책 `{approval}` |
| PUT | `/configuration/ask-user` | `ask_user` 허용 `{enabled}` |
| POST | `/configuration/test` | 연결 테스트 `{provider, model}` → `{ok, durationMs, text?, error?}` (요금 발생 가능) |
| GET / PUT | `/compaction` | `{auto, model}` 자동 압축과 요약 모델 |
| GET / PUT | `/subagents` | 하위 에이전트 (PUT은 **전체 교체**) |
| GET / PUT | `/system-model` | 세션 제목·역할을 쓰는 모델 (`null`이면 끔) |
| GET / PUT | `/model-roles` | 역할별 모델 (PUT은 **전체 교체**) |
| POST | `/llm/complete` | 세션 없는 단발 완성 `{role \| provider+model, system?, input, maxTokens?}` |

## 폴더와 파일

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/fs/dirs` | 폴더 탐색(폴더만). `?path=&hidden=` → 최대 500개 |
| POST | `/fs/dirs` | 폴더 만들기 `{parent, name}` |
| GET | `/fs/files` | `#` 지목용 파일·폴더 이름 검색. `?cwd=&q=&limit=1..100(50)` |

## 그룹과 터미널

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET / POST | `/groups` | 그룹 목록 / 생성 `{name?, layout}` |
| PATCH / DELETE | `/groups/:id` | 이름·레이아웃 수정 / 삭제 |
| GET | `/terminals/info` | 터미널 지원 여부, 플랫폼, 셸 목록, 최대 개수 |
| GET / POST | `/terminals` | 목록 / 생성 `{cwd?, shell?, title?, cols?, rows?}` |
| PATCH / DELETE | `/terminals/:id` | 이름 변경 / 종료 |
| WS | `/terminals/:id/ws` | 입출력 소켓 |

## 스킬·템플릿·확장·언어

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/skills` | 스킬 목록과 켜기/끄기. `?cwd=&sessionId=` |
| PUT | `/skills/:id` | `{scope: "global"\|"project"\|"session", enabled: bool\|null, cwd?, sessionId?}` |
| GET | `/templates` | 프롬프트 템플릿. `?cwd=` |
| GET | `/server-extensions` | 불러온 서버 확장·명령 |
| POST | `/server-extensions/reload` | **관리자.** 다시 읽기 |
| GET | `/server-extensions/errors` | 오류 기록(최근 100개) |
| POST | `/server-extensions/:확장/methods/:메서드` | 확장 메서드 호출. `?sessionId=` |
| GET | `/extensions/settings` | 클라이언트 확장 설정 전체 |
| PUT | `/extensions/:id/settings` | `{settings}` JSON 객체(≤16,000자) |
| DELETE | `/extensions/:id` | 확장 설정 삭제 |
| GET | `/locales` | 언어팩 목록 |
| GET / PUT / DELETE | `/locales/:tag` | 팩 조회 / 저장 `{name, messages, owner?}` / 삭제(`?owner=`). `ko`·`en` 예약 |
| GET | `/client-settings` | 서버에 묶인 클라이언트 설정 전체 |
| GET / PUT | `/client-settings/:key` | `favModels` · `extensions` · `notificationPolicy` |

## 기기와 알림

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/pairing` | **관리자.** 연결 코드 → `{code, expiresAt}` |
| DELETE | `/pairing` | **관리자.** 발급된 코드 모두 취소 |
| POST | `/pairing/redeem` | **공개.** `{code, name?}` → `{token}` (기기 토큰) |
| GET | `/devices/tokens` | **관리자.** 기기 토큰 목록 (`id`, `name`, `createdAt`, `lastUsedAt`) |
| DELETE | `/devices/tokens/:id` | **관리자.** 해지 |
| GET | `/notifications/status` | `{pushConfigured, providers}` |
| GET | `/notifications/devices` | 알림 수신 기기 목록 |
| PUT | `/notifications/devices/:id` | 기기 상태 보고(하트비트) |
| POST | `/notifications/devices/:id/test` | 시험 알림 |
| DELETE | `/notifications/devices/:id` | 기기 알림 등록 삭제 |
| POST | `/notifications/:id/received` | 기기가 알림을 표시했음을 확인 |
| POST | `/notifications` | `{source, notification}` 알림 보내기 |
| PUT | `/notifications/rules/:owner/:id` | 알림 규칙 등록 |
| DELETE | `/notifications/rules/:owner[/:id]` | 규칙 삭제 |

## 이벤트와 스트림

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/events` | SSE (전체) |
| GET | `/sessions/:id/events` | SSE (세션) |
| GET | `/events/history` | 저장된 이벤트와 최신 커서. `?sessionId=&after=&limit=1..1000(200)` |
| GET | `/events/types` | 이벤트 페이로드 스키마 |
| WS | `/ws` | 양방향 WebSocket |

자세한 프로토콜은 [[events]]에 있습니다.

## 예: 대화 하나 만들어 보내기

```bash
TOKEN="$(< ~/.pipaya/token)"; URL=http://<서버 주소>:8787

# 1. 구독을 먼저 시작 (다른 터미널)
curl -N -H "Authorization: Bearer $TOKEN" "$URL/events?types=message_end,run_finished"

# 2. 세션 만들기
ID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"cwd":"."}' "$URL/sessions" | jq -r .id)

# 3. 메시지 보내기 (202)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"이 폴더의 구조를 설명해줘"}' "$URL/sessions/$ID/messages"
```

> [!WARNING]
> 스트리밍 조각(`message_update`)은 저장되지 않으므로 **프롬프트를 보내기 전에 먼저 구독**하세요. 놓친 부분은 `GET /sessions/:id/messages`로 완성된 메시지를 읽어 채울 수 있습니다.
