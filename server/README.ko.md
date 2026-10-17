# pipaya server

[English](README.md) · **한국어** · [프로젝트 README](../README.ko.md)

API 전용 하네스: `pi-agent-core` + Bun + Fastify + SQLite. 명령과 설정은 REST, 진행 상황은 SSE/WebSocket으로 전달합니다.
서버는 HTML, 프론트엔드 에셋, API 문서 페이지를 제공하지 않으며 `client/`와 독립적으로 실행됩니다.

```bash
cd server && bun install
bun run dev                     # 모델 카탈로그가 빈 상태로 시작
bun run typecheck && bun test
bun run start
```

간편 설치(서비스 등록 포함)는 [프로젝트 README](../README.ko.md#빠른-설치)를, 컨테이너 격리 실행은 [Docker 샌드박스](../README.ko.md#docker로-서버-실행-sandbox)를 참고하세요.

## Authentication

토큰: `$PIPAYA_TOKEN`, 없으면 `~/.pipaya/token`에 생성됩니다.
`GET /health`를 제외한 모든 API 호출에 `Authorization: Bearer <token>`을 보냅니다.
브라우저 EventSource/WebSocket은 `/events`, `/sessions/:id/events`, `/ws`**에서만** `?token=`을 쓸 수 있습니다.
CORS preflight는 다른 origin의 클라이언트를 위해 공개입니다.
토큰은 관리자 권한을 가집니다. Tailscale 또는 HTTPS를 쓰고, 신뢰할 수 없는 클라이언트와 공유하지 마세요.

```bash
TOKEN="$(< "$HOME/.pipaya/token")"
curl -H "Authorization: Bearer $TOKEN" http://<server-ip>:8787/configuration
```

오류는 JSON입니다: `{ "error": { "code": "invalid_request", "message": "..." } }`. API 메시지와 `GET /tools` 설명은 영어이며, UI 번역은 클라이언트가 담당합니다.
요청 스키마(`src/schemas.ts`, `src/configuration.ts`)가 TypeBox 검증과 핸들러 타입을 제공합니다.
테스트는 응답 계약도 검증하고, 운영에서는 응답마다 검증하는 비용을 피합니다.

## Runtime configuration

Bun은 서버 작업 디렉터리의 `.env`를 읽습니다. `.env.example`을 참고하세요.

| Variable | Default | Purpose |
|---|---|---|
| `PIPAYA_HOST` / `PIPAYA_PORT` | `0.0.0.0` / `8787` | 수신 주소 |
| `PIPAYA_DATA_DIR` | `~/.pipaya` | 데이터베이스, 토큰, 기본 워크스페이스 |
| `PIPAYA_DB` | `<data>/pipaya.db` | SQLite 경로 |
| `PIPAYA_WORKSPACE` | `<data>/workspace` | 시작 시 기본 작업 디렉터리. 실행 중에는 `PUT /configuration/workdir`로 바꿉니다(SQLite에 저장되고 이 값을 덮어씀) |
| `PIPAYA_PROVIDER` / `PIPAYA_MODEL` | 처음 구성된 모델 | 시작 기본값. 등록된 커스텀 프로바이더/모델이어야 하며, 저장된 기본값이 우선합니다 |
| `PIPAYA_APPROVAL` | `ask` | `ask`(세션 작업 디렉터리 밖에 닿는 작업만 확인), `auto`(묻지 않음), `readonly`(변경 차단. API 전용이며 앱에서는 더 이상 고르지 않음) |
| `PIPAYA_APPROVAL_TIMEOUT_MS` | `600000` | 자동 거부까지의 시간. `0`이면 시간 제한 없음 |
| `PIPAYA_MAX_SESSIONS` | `200` | 동시에 활성인(닫히지 않은) 세션의 최대 수. 넘으면 생성·재개가 409로 거절됨. `0`이면 제한 없음 |
| `PIPAYA_LOG_LEVEL` | `info` | Fastify 로그 수준(`silent`는 로그 끔). `?token=`으로 전달된 토큰은 요청 로그에서 가려집니다 |
| `PIPAYA_PUSH_FCM` | _(자격 증명이 있으면 켜짐)_ | `0`이면 끄고, 아니면 Google Application Default Credentials로 Firebase Cloud Messaging을 통해 Android 푸시를 보냅니다. client/docs/notifications.md 참고 |
| `PIPAYA_CORS_ORIGINS` | _(비어 있음)_ | 추가로 허용할 브라우저 origin(쉼표 구분, 정확히 일치, `*`는 전체). 루프백, Tailscale `100.64.0.0/10`, RFC1918 LAN, `*.ts.net`, Tauri origin은 항상 허용됩니다 |
| `PIPAYA_TERMINAL` | `1` | `0`이면 터미널(클라이언트가 이 서버에서 여는 대화형 셸. Linux/macOS는 사용자 셸, Windows는 PowerShell)을 끕니다 |

새 서버의 카탈로그는 비어 있습니다. 내장 프로바이더도, 환경변수 기반 인증도 없습니다.
저장된 커스텀 프로바이더와 모델은 재시작해도 SQLite에서 복원됩니다.
엔드포인트와 모델은 `/configuration/providers/:id`(또는 클라이언트의 Settings → Models)로 등록하고, 키는 `/providers/:id/credential`로 설정합니다.

## REST API

| Method | Path | 입력 / 결과 |
|---|---|---|
| GET | `/health` | 공개 상태 확인. `version`, `protocol`, `minClientProtocol`도 포함하며 부하 수치는 토큰이 있을 때만 |
| GET/POST | `/server/update` | 관리자 토큰 전용. GET: 이 체크아웃이 추적하는 브랜치에 새 커밋이 있는지, 서버가 스스로 재시작할 수 있는지. POST `{force?}`: 새 커밋으로 이동하고 의존성을 설치한 뒤 프로세스를 종료해 서비스 매니저가 새 코드로 다시 띄우게 합니다. `force`가 없으면 실행 중인 대화가 있을 때 409 `sessions_running` |
| GET | `/tools` | 도구 목록과 기본값 |
| GET | `/models?provider=&configured=true` | 모델 카탈로그 |
| GET | `/providers` | 프로바이더 사용 가능 여부(키는 반환하지 않음) |
| PUT | `/providers/:id/credential` | `{key}` |
| DELETE | `/providers/:id/credential` | 저장된 키 삭제 |
| GET | `/workspace` | 기본 작업 디렉터리(`root`)와 세션이 쓰는 디렉터리 |
| PUT | `/configuration/workdir` | `{path}`: 존재하는 절대 경로, 또는 `null`(시작 기본값 복원) |
| GET | `/fs/dirs?path=&hidden=` | 선택기용: 절대 경로의 하위 디렉터리(폴더만) |
| POST | `/fs/dirs` | `{parent,name}`: 폴더 생성 |
| POST | `/sessions` | 선택 `{title,cwd,provider,model,thinkingLevel,systemPrompt,tools,approval}`. `cwd`는 서버의 존재하는 절대 경로이거나 기본 작업 디렉터리 기준 상대 경로(없으면 생성) |
| POST | `/sessions/:id/compact` | 선택 `{customInstructions}`. 오래된 메시지를 요약해 모델이 요약을 대신 보게 합니다(저장된 대화 기록은 그대로). 실행 중이거나 기록이 짧으면 409, 요약 모델 실패 시 502 |
| GET/PUT | `/compaction` | `{auto, model, thresholdPercent}`. 컨텍스트가 모델 창의 `thresholdPercent`%(30–95, 기본 90)에 이르면 프롬프트 전에 자동 압축합니다. `model`은 `{provider, model, thinkingLevel?}` 또는 `null`(세션 모델 그대로 사용) |
| GET/PUT | `/system-model` | `{model}`: 메시지 후 백그라운드에서 세션 이름과 `purpose`(역할)를 쓰는 가벼운 모델. `{provider, model, thinkingLevel?}` 또는 `null`(끄기, 제목은 첫 메시지를 줄여 씀) |
| GET/PUT | `/subagents` | `{settings: {enabled, agents: [{name, description, enabled, model, tools, maxTurns, prompt}]}, toolChoices}`. `model`은 `{provider, model, thinkingLevel?}` 또는 `null`(호출한 대화의 모델), 강도를 생략하면 `minimal`. 각 agent는 `delegate` 도구 뒤의 읽기 전용 도우미입니다(`tools`는 `read`, `grep`, `ls` 중에서, 최대 10개, `name`은 고유). `delegate`는 선택 인자 `agent`(이름)를 받고, 생략하면 켜진 첫 도우미를 씁니다. `prompt`는 기본 조사 지침 뒤에 덧붙습니다 |
| GET | `/sessions?limit=&before=&closed=` | 세션 목록과 `nextBefore` 커서 |
| GET/PATCH/DELETE | `/sessions/:id` | 세션 조회/수정/삭제. PATCH는 `closed`도 받습니다 |
| POST | `/sessions/:id/messages` | `{text,mode?,images?}`; 비동기 `202` |
| GET | `/sessions/:id/messages?after=&limit=` | 저장된 대화 기록(`seq` 순) |
| GET | `/sessions/:id/status` | 늦게 접속한 클라이언트를 위해 스트리밍 중인 부분 메시지를 포함 |
| GET | `/sessions/:id/usage` | 토큰/비용 합계 |
| GET | `/sessions/:id/context` | 컨텍스트 스냅샷(AGENTS.md 파일, 활성 스킬, 실제 시스템 프롬프트) |
| POST | `/sessions/:id/abort` | `{aborted}` |
| POST | `/sessions/:id/retry` | 실패/중단 후 재시도; `202` |
| POST | `/sessions/:id/fork` | 선택 `{atSeq,title}` |
| GET | `/activity` | 사이드바 표시용: 세션별 실행 중/승인 대기 상태 |
| GET/POST | `/groups` | 세션 그룹(이름 있는 분할 창 레이아웃, 세션 2~8개). `name`을 생략하면 서버가 `Group N`을 쓰고, 클라이언트는 보통 현지화된 이름을 보냅니다 |
| PATCH/DELETE | `/groups/:id` | 그룹 이름·레이아웃 변경, 삭제. 세션이 2개 미만이 되면(닫히거나 삭제된 세션은 그룹을 떠납니다) 서버가 그룹을 제거하고 `group_deleted`를 보냅니다 |
| GET | `/terminals/info` | 터미널 지원 정보: `{enabled, platform, pty, shell, shells[], max}`. Linux/macOS는 사용자 셸을 PTY로, Windows는 PowerShell(`pwsh` → `powershell` → `cmd`)을 파이프로 실행합니다(`pty: false`) |
| GET/POST | `/terminals` | 열린 셸 목록(메모리에만 있어 재시작하면 끝남). `POST {cwd?, shell?, title?, cols?, rows?}`. id는 `term_`로 시작하며 그룹 레이아웃에 세션과 함께 들어갈 수 있습니다 |
| PATCH/DELETE | `/terminals/:id` | 이름 변경, 셸 종료(`terminal_closed`, 그룹에서도 빠짐) |
| WS | `/terminals/:id/ws` | 연결(토큰은 `?token=`): `hello`, 보관된 출력(binary), 이후 실시간 출력. `{type:"input",data}` / `{type:"resize",cols,rows}`를 보내고, 셸이 끝나면 `{type:"exit",code}` |
| GET | `/skills?cwd=` | `cwd`에서 보이는 스킬(기본: 서버 기본 디렉터리)과 전역/프로젝트 켜기·끄기 상태 |
| PUT | `/skills/:name` | `{scope:"global"\|"project",enabled,cwd?}`; 프로젝트 범위는 `enabled:null`로 재정의를 지울 수 있음 |
| GET | `/locales` | UI 언어팩: `[{tag,name,owner?,messages,updatedAt}]` (내장 `ko`/`en`은 목록에 없음) |
| GET | `/locales/:tag` | 팩 하나: `{tag,name,owner?,messages,updatedAt}`. `messages`는 한국어 원문 → 번역 |
| PUT | `/locales/:tag` | `{name,messages,owner?}`. `ko`와 `en`은 예약됨. 최대 20개 팩, 팩당 3000개 문장. 한 확장이 소유한 팩을 다른 확장이 덮어쓰면 `409`. 같은 내용을 저장하면 변경 없음(이벤트 없음, `updatedAt` 동일). `locales_updated` 발행 |
| DELETE | `/locales/:tag?owner=` | 팩 삭제(멱등). `owner`를 주면 그 확장이 게시한 경우에만 삭제 |
| GET | `/extensions/settings` | 모든 클라이언트 확장 설정(확장 ID별) |
| PUT | `/extensions/:id/settings` | `{settings}`: 확장이 소유하는 JSON 객체(최대 16,000자) |
| DELETE | `/extensions/:id` | 확장의 저장된 설정 삭제 |
| GET | `/notifications/status` | `{pushConfigured,providers}` |
| GET | `/notifications/devices` | 이 토큰으로 접속한 기기 목록(`id`, `platform`, `name`, `os`, `app`, `live`, `push`, `lastSeen`). 푸시 토큰은 돌려주지 않음 |
| PUT/DELETE | `/notifications/devices/:id` | 기기 접속 상태(`platform`, `focused`, `enabled`, `visibleSessionIds`, 선택적 `name`, 선택적 모바일 `push` 토큰) 전송 / 기기 해지(`device_revoked` 이벤트로 알리고 해당 기기는 보고를 멈춤) |
| POST | `/notifications/:id/received` | 기기가 알림을 표시했음을 확인하여 지연된 모바일 푸시를 건너뜀 |
| POST | `/notifications` | `{source,notification:{title,body?,kind?,sessionId?,key?}}`. source당 10초에 5회로 제한. `source: "pipaya"`는 내장 알림용으로 예약됨 |
| PUT/DELETE | `/notifications/rules/:owner/:id` | `run_finished` / `approval_requested`의 기본 알림을 대체하는 확장별 규칙(소유자당 최대 5개). `DELETE /notifications/rules/:owner`는 전부 삭제 |
| GET | `/approvals?sessionId=` | 대기 중인 승인 |
| POST | `/sessions/:id/approvals/:toolCallId` | `{approved,reason?}` |
| GET | `/events/history?sessionId=&after=&limit=` | 저장된 이벤트와 최신 커서 |
| GET | `/events/types` | 기계가 읽을 수 있는 이벤트 페이로드 스키마 |

메시지 모드: `prompt`는 대기 중인 세션을 시작하고, `steer`는 실행 중인 작업에 끼워 넣고, `follow_up`은 끝난 뒤로 대기열에 넣습니다.
상태가 맞지 않으면 `409`를 반환합니다. `systemPrompt`와 `tools`는 첫 메시지 이후 고정됩니다.
추론 강도: `minimal`, `low`, `medium`(기본), `high`, `xhigh`, `max`.
`off`로 추론을 끄는 기능은 지원하지 않으며, 기존 `off` 세션은 `medium`으로 이전됩니다.
추론을 지원하지 않는 모델은 선택한 강도를 무시합니다.

## Skills

스킬은 [Agent Skills](https://agentskills.io/specification) 구조(`<name>/SKILL.md`, `name` + `description` frontmatter)를 따릅니다.

| 출처 | 위치 |
|---|---|
| Global | 서버 사용자의 `~/.agents/skills/` |
| Project | 세션 디렉터리에서 git 루트(저장소가 없으면 `/`)까지의 `.pi/skills/`와 `.agents/skills/` |
| Built-in | `server/builtin-skills/`(scope `builtin`). 모든 프로젝트에서 켜져 있고 우선순위가 가장 낮으며, 다른 스킬처럼 끌 수 있음 |

이름이 겹치면 더 가까운 디렉터리가 이기고, 프로젝트 스킬은 전역 스킬을, 둘 다 내장 스킬을 이깁니다(이름으로 내장 스킬을 대체해도 알림은 없습니다). 잘못된 파일은 경고와 함께 건너뜁니다(`GET /skills` → `warnings`).
`disable-model-invocation: true`인 스킬은 목록에는 보이지만 모델에게는 제공되지 않습니다.

켜기/끄기 상태는 스킬 폴더가 아니라 SQLite(`settings.skills`)에 저장됩니다. **전역** 기본값과, git 루트별 선택적 **프로젝트** 재정의가 있습니다.
실제 상태 = 프로젝트 재정의, 없으면 전역 기본값. 기본은 모두 켜짐입니다.

켜진 스킬은 `<available_skills>` 블록(이름, 설명, 경로)으로 시스템 프롬프트에 추가되고, 모델은 `SKILL.md`를 읽어 스킬을 불러옵니다.
`AGENTS.md`(첫 실행의 **컨텍스트 스냅샷**에 고정)와 달리 스킬은 항상 *현재* 설정을 따릅니다: 전환하면 실행 중인 세션에도 다음 메시지부터 적용됩니다
(`GET /sessions/:id/context` → `skills` / `effectiveSystemPrompt`가 현재 상태를 보여 줍니다). 켜진 목록이 실제로 바뀐 경우에만 맨 앞의 시스템 메시지를 다시 쓰므로
그 외에는 프로바이더 프롬프트 캐시가 유지됩니다. `read` 도구가 없으면 아무것도 안내하지 않습니다. `read` 도구는 작업 디렉터리 밖이라도 현재 켜진 스킬 폴더 안의 파일은 열 수 있지만, 그 외에는 읽을 수 없습니다. 변경은 `skills_updated`를 발행합니다.

## Model configuration API

모든 변경은 서버 쪽에 저장되며 그 서버에 연결된 모든 클라이언트가 공유합니다.

| Method | Path | 용도 |
|---|---|---|
| GET | `/configuration` | 커스텀 프로바이더, 저장된/실제 기본값. 비밀 값은 반환하지 않음 |
| PUT | `/configuration/providers/:id` | 커스텀 엔드포인트 생성/수정 |
| DELETE | `/configuration/providers/:id` | 엔드포인트와 저장된 키 삭제 |
| PUT | `/configuration/defaults` | `{provider,model}`. JSON `null`은 시작 기본값(`PIPAYA_PROVIDER`/`PIPAYA_MODEL`) 또는 처음 구성된 모델로 되돌림 |
| POST | `/configuration/test` | `{provider,model}`; `{ok,durationMs,text?,error?}` |

커스텀 프로바이더 본문:

```json
{
  "name": "Local Ollama",
  "baseUrl": "http://model-host:11434/v1",
  "api": "openai-completions",
  "authRequired": false,
  "models": [
    {
      "id": "qwen3:8b",
      "name": "Qwen 3 8B",
      "contextWindow": 32768,
      "maxTokens": 4096,
      "reasoning": false,
      "vision": false
    }
  ]
}
```

- API 형식: `openai-completions`, `openai-responses`, `anthropic-messages`.
- 프로바이더 ID: 소문자로 시작하고 소문자/숫자/`_`/`-`, 최대 64자.
- 모델 ID는 직접 입력합니다. 컨텍스트 윈도우: 128–10,000,000, 출력 한도: 1–컨텍스트 윈도우.
- 커스텀 엔드포인트 URL은 HTTP(S)여야 하며 자격 증명, 쿼리, 프래그먼트를 포함할 수 없습니다.
- 연결 테스트는 실제 모델 요청을 보냅니다: 출력 토큰 최대 32개, 제한 시간 30초. 요금이 발생할 수 있습니다.
- 엔드포인트 수정은 다음 요청부터 적용됩니다. 기본값 변경은 새 세션에만 영향을 줍니다.
- 기본값이나 세션이 참조하는 프로바이더/모델을 삭제하면 `409`를 반환합니다.
- 커스텀 가격은 설정하지 않으므로 기록되는 비용은 0이며, 반드시 무료라는 뜻은 아닙니다.

## Events

SSE: `GET /events` 또는 `GET /sessions/:id/events`. `?types=a,b`로 거릅니다.
`Last-Event-ID` 또는 `?after=<id>`로 재생한 뒤 실시간으로 이어집니다. 커서가 없으면 실시간 구독만 합니다.

봉투: `{id,sessionId,type,ts,data}`. 저장되는 이벤트는 전역 커서를 쓰고, `id: 0` 이벤트는 일시적입니다.
페이로드 스키마는 `GET /events/types`를 사용하세요. 이벤트 로그는 7일 후 만료되며 대화 기록은 따로 보관됩니다.

| 유형 | 저장 여부 |
|---|---|
| `session_created`, `session_updated`, `session_deleted`, `session_forked` | 예 |
| `run_started`, `run_finished` | 예 |
| `agent_start`, `agent_end`, `turn_start`, `turn_end` | 예 |
| `message_start`, `message_end` | 예 |
| `message_update` | 아니오. 어시스턴트 델타 |
| `tool_execution_start`, `tool_execution_end` | 예 |
| `tool_execution_update` | 아니오. 도구 출력 중간값 |
| `approval_requested`, `approval_resolved`, `message_queued`, `message_dequeued` | 예 |
| `provider_updated`, `configuration_updated`, `locales_updated`, `extension_settings_updated`, `group_*` | 예 |
| `notification` | 아니오. 기기 한 대에 보내며 재생되지 않음 |

`message_end`에는 `{seq,message}`가 들어 있습니다. `run_finished`에는 `{status,error,durationMs,usage}`가 들어 있고 유휴 상태를 알립니다.
프롬프트를 보내기 전에 구독하세요. 재생으로는 일시적인 델타를 복구할 수 없습니다.

WebSocket `/ws`: `{id?,op,...args}`를 보내고 `{type:"ack",id,ok,result|error}`와 `{type:"event",event}`를 받습니다.
작업: `subscribe {sessionId?,after?,types?}`, `unsubscribe {sessionId?}`, `prompt {sessionId,text,mode?,images?}`,
`abort {sessionId}`, `approve {sessionId,toolCallId,approved,reason?}`, `ping`.

## Storage and safety

```text
~/.pipaya/
├── pipaya.db       # 세션, 메시지, 이벤트, 모델 설정, 기본값, 자격 증명
├── pipaya.db-wal   # SQLite가 관리
├── pipaya.db-shm
├── token            # 0600
├── locales/         # 언어팩 (0700)
└── workspace/
```

SQLite는 인덱스 조회와 트랜잭션 기반 설정 갱신을 제공합니다. API 키는 **암호화되지 않습니다**.
기본 디렉터리는 `0700`, 새 데이터베이스는 `0600`으로 만들어집니다.
백업은 SQLite를 인식하는 방식을 쓰거나 중지/체크포인트 후 복사하세요. 실행 중에 데이터베이스 파일만 복사하지 마세요.
기존 `server/data`는 자동으로 가져오지 않습니다. 계속 쓰려면 `PIPAYA_DATA_DIR=./data`로 지정하세요.

인증 토큰과 데이터 디렉터리는 로그에 출력되지 않으며 `?token=`은 가려집니다. `bash` 자식 프로세스와 터미널은 `PIPAYA_*` 변수를 하나도 상속하지 않습니다.

커스텀 URL은 LAN/Tailscale에 대한 서버 측 요청을 의도적으로 허용합니다. 신뢰하는 엔드포인트만 설정하세요.
`bash`는 **샌드박스되지 않으며** 서버 사용자 권한으로 실행됩니다. 승인 정책을 `ask`로 두거나 컨테이너/VM에서 서버를 격리하세요.
변경성 도구(`write`, `edit`, `bash`)는 승인 정책을 따릅니다.

### Built-in skills

`pipaya-client-extensions`는 클라이언트를 수정하는 에이전트를 위해 클라이언트의 확장 시스템을 설명합니다. `references/`에 확장 문서가 들어 있습니다. 다른 내장 스킬은 `builtin-skills/<name>/SKILL.md`를 만들어 추가합니다.

## 클라이언트 호환성과 자동 업데이트

`protocol`(`src/version.ts`)은 REST/WebSocket/SSE 형식이 바뀌어 이전 상대가 처리하지 못할 때만 올리는 정수입니다. 필드나 라우트를 추가하는 것만으로는 올리지 않습니다. 클라이언트는 `X-Pipaya-Protocol` 헤더(EventSource/WebSocket은 `?protocol=`)로 자기 값을 보내고, `minClientProtocol`보다 낮으면 `/health`를 뺀 모든 경로에서 `426 client_too_old`로 거절되어 앱이 사용자에게 업데이트를 안내할 수 있습니다. WebSocket `hello` 프레임에도 같은 세 값이 들어 있습니다.

`POST /server/update`는 프로세스를 다시 띄워 줄 주체가 있을 때만 동작합니다. `install.sh`가 만든 systemd/launchd 서비스(자동 감지)이거나, `PIPAYA_SELF_UPDATE=1`을 지정한 다른 감독 프로세스여야 합니다. `PIPAYA_SELF_UPDATE=0`이면 꺼집니다. Docker 이미지, 컴파일된 바이너리, detached HEAD(고정한 태그나 커밋)는 불가능한 이유를 응답합니다.
