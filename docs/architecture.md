# 아키텍처

## 전체 그림

```text
 ┌──────────────── 클라이언트 (Svelte 5 + Tauri 2) ────────────────┐
 │  채팅 UI · 세션 그룹 · 설정 · 알림                              │
 │  ┌──────────── 확장 호스트 ────────────┐                        │
 │  │ iframe(opaque) └ Worker ←MessagePort→ host.request()        │
 │  └─────────────────────────────────────┘                        │
 └───────────────┬─────────────────────────▲───────────────────────┘
        REST (명령·설정)             SSE / WebSocket (진행 상황)
 ┌───────────────▼─────────────────────────┴───────────────────────┐
 │  서버 (Bun + Fastify)                                           │
 │   인증 훅 → 라우트 → SessionManager ──► Agent(pi-agent-core)    │
 │                          │   ▲               │ tool call        │
 │                          │   └─ ApprovalManager ◄─ 승인 정책    │
 │                          ▼                   ▼                  │
 │                       EventBus ───►  tools (read/write/edit/    │
 │                          │            ls/grep/bash/ask_user/    │
 │                          ▼            delegate)                 │
 │                      SQLite (WAL)          │                    │
 └────────────────────────────────────────────┼────────────────────┘
                                              ▼
                              모델 엔드포인트 (직접 등록한 URL)
```

## 서버

서버는 **API 전용**입니다. HTML, 프론트엔드 에셋, API 문서 페이지를 서빙하지 않고 `client/`와 독립적으로 실행됩니다.

### 서버 모듈 지도 (`server/src/`)

| 영역 | 파일 | 역할 |
|---|---|---|
| 진입 | `index.ts`, `app.ts`, `config.ts` | 설정 로딩, Fastify 조립, 인증 훅, CORS, 종료 처리 |
| 세션 | `sessions.ts`, `store.ts`, `context.ts`, `groups.ts` | 세션 수명주기, 메시지 저장, 컨텍스트 스냅샷, 분할 레이아웃 |
| 에이전트 도구 | `tools.ts`, `approvals.ts`, `questions.ts`, `subagent*.ts` | 도구 정의·경로 제한, 승인 대기, 사용자 질문, 서브에이전트 |
| 모델 | `models.ts`, `configuration.ts`, `llm*.ts`, `model-*.ts` | 사용자 정의 제공자·모델 카탈로그, 기본 모델, 보조 모델 선택 |
| 컨텍스트 | `skills*.ts`, `compaction*.ts` | 스킬 탐색·켜기/끄기, 컨텍스트 압축 |
| 실시간 | `events.ts`, `sse.ts`, `ws.ts` | 이벤트 버스(영속 커서), SSE, WebSocket |
| 클라이언트 지원 | `client-settings*.ts`, `extension-settings*.ts`, `locales*.ts` | 서버 범위 설정, 확장 설정 파일, 언어팩 |
| 알림·기기 | `notifications*.ts`, `push.ts`, `pairing*.ts`, `device-tokens.ts` | 알림 라우팅, FCM, 페어링 코드, 기기 토큰 |
| 보안·정리 | `security.ts`, `fs-routes.ts`, `retention.ts` | CORS 정책·로그 마스킹, 폴더 선택기, 오래된 세션 정리 |

### 요청이 처리되는 순서

1. `onRequest` 훅이 `Authorization: Bearer`를 검사합니다. 예외는 `GET /health`와 페어링 코드 교환 한 곳뿐입니다. 토큰 비교는 `timingSafeEqual`을 씁니다.
2. 라우트는 TypeBox 스키마로 입력을 검증합니다. 오류는 `{ "error": { "code", "message" } }` JSON입니다.
3. 메시지 전송(`POST /sessions/:id/messages`)은 **`202`로 즉시 응답**하고 실행은 백그라운드에서 이어집니다. 결과는 이벤트 스트림으로 옵니다.

### 모델 연결은 어디에 저장되나

- 제공자·모델 정의: SQLite `custom_providers`, 기본값은 `settings`
- API 키: SQLite `credentials` (**암호화되지 않음**. 데이터 디렉터리는 `0700`, DB와 토큰은 `0600`)
- 환경변수로 인증하는 방식은 없습니다. 키는 `PUT /providers/:id/credential`이나 설정 화면으로만 넣습니다.

## 클라이언트

`client/src/`는 크게 세 덩어리입니다.

| 위치 | 내용 |
|---|---|
| `components/` | 화면 컴포넌트 (Sidebar, MessageList, Composer, Settings, Skills, SubAgents, Extensions …) |
| `lib/` | 상태(`store.svelte.ts`, `chat.svelte.ts`), 서버 클라이언트(`api.ts`), 레이아웃, 단축키, 알림, i18n |
| `lib/extensions/` | 확장 런타임: 스키마 검증, 호스트, 샌드박스 Worker, UI 노드 검증 |

- 하나의 클라이언트가 **여러 서버**에 연결할 수 있습니다. 서버 목록과 토큰은 기기에 저장됩니다.
- 테마, 언어, 단축키, 사운드 같은 **기기 설정**은 `localStorage`에만 있고, 즐겨찾기 모델·설치된 확장·알림 정책 같은 **서버 설정**은 서버가 원본입니다. 기준은 [설정은 어디에 저장되나](settings-scope.md)에 정리되어 있습니다.
- 이벤트는 `EventSource`로 받습니다. 브라우저 `EventSource`는 헤더를 못 붙이므로 `/events`, `/sessions/:id/events`, `/ws` 세 곳에 한해 `?token=`을 허용하고, 서버는 이 값을 로그에서 지웁니다.

## 저장소 레이아웃

```text
~/.pipaya/
├── harness.db        # 세션, 메시지, 이벤트, 모델 설정, 기본값, 자격 증명
├── harness.db-wal    # SQLite가 관리
├── harness.db-shm
├── token             # 0600
├── extensions/<id>/settings.json   # 확장 설정 (기본 scope)
└── workspace/        # 기본 작업 디렉터리
```

> [!WARNING]
> 실행 중인 DB 파일만 복사하면 일관되지 않은 백업이 됩니다. SQLite를 인지하는 백업을 쓰거나, 서버를 멈추고(또는 체크포인트 후) 복사하세요.

주요 테이블: `sessions`, `messages`(세션별 `seq`), `events`(전역 증가 커서), `credentials`, `custom_providers`, `settings`, `groups`, `session_contexts`, `session_compactions`, `client_settings`, `device_tokens`, `notification_*`. 스키마는 `server/src/db.ts`의 순차 마이그레이션으로 관리됩니다.

## 이벤트와 재연결

이벤트 봉투는 `{ id, sessionId, type, ts, data }`입니다.

- **영속 이벤트**는 전역 증가 `id`를 가집니다. `Last-Event-ID` 헤더나 `?after=<id>`로 재연결하면 놓친 이벤트를 **빠짐없이** 재생한 뒤 실시간으로 이어집니다.
- **일시 이벤트**(`id: 0`)는 어시스턴트 토큰 델타(`message_update`), 도구 부분 출력(`tool_execution_update`), 기기 지정 `notification`입니다. 실시간으로만 전달되고 재생되지 않습니다.
- 그래서 **프롬프트를 보내기 전에 먼저 구독**해야 하고, 늦게 들어온 클라이언트는 `GET /sessions/:id/status`로 진행 중인 부분 메시지를 받아 따라잡습니다.
- 이벤트 로그는 7일 뒤 만료되고, 대화 기록(`messages`)은 별도로 보관됩니다.
- WebSocket `/ws`는 같은 이벤트에 더해 `prompt`, `abort`, `approve` 같은 조작을 받습니다.

머신 판독용 페이로드 스키마는 `GET /events/types`에서 얻습니다.
