서버는 진행 상황을 **이벤트**로 알립니다. 클라이언트는 SSE 또는 WebSocket으로 구독합니다.

## 봉투

모든 이벤트는 같은 모양입니다.

```json
{ "id": 1042, "sessionId": "…", "type": "message_end", "ts": 1760000000000, "data": { … } }
```

| 필드 | 설명 |
|---|---|
| `id` | **전역 커서.** 저장되는 이벤트는 단조 증가하는 정수, 저장되지 않는(일시적) 이벤트는 `0` |
| `sessionId` | 이벤트가 속한 세션. 전역 이벤트는 `null` |
| `type` | 이벤트 종류 |
| `ts` | 발생 시각 (Unix ms) |
| `data` | `type`마다 다른 페이로드. 스키마는 `GET /events/types` |

이벤트 로그는 **7일** 뒤 만료됩니다(6시간마다 정리). 대화 기록(메시지)은 따로 보관되어 영향이 없습니다.

## 이벤트 종류

### 세션과 실행

| 종류 | 저장 | 설명 |
|---|---|---|
| `session_created` `session_updated` | 예 | 세션 생성·설정 변경 (페이로드는 세션 레코드) |
| `session_deleted` | 예 | 세션 삭제 (`sessionId: null`, `data.id`) |
| `session_forked` | 예 | 복사가 끝난 새 세션에 발행 |
| `run_started` | 예 | 에이전트가 일을 시작 (`data.mode`) |
| `run_finished` | 예 | **실행이 끝남.** 이 세션을 유휴로 봐도 되는 안전한 지점. `{status, error, durationMs, usage}` |
| `agent_start` `agent_end` | 예 | 에이전트 루프 수명 주기 |
| `turn_start` `turn_end` | 예 | 모델 호출 한 번 + 도구 실행 한 묶음 |

### 메시지

| 종류 | 저장 | 설명 |
|---|---|---|
| `message_start` | 예 | 메시지 시작 (사용자·어시스턴트·도구 결과) |
| `message_update` | **아니오** | 어시스턴트 스트리밍 조각 (델타) |
| `message_end` | 예 | 메시지 완성·저장. `{seq, message}`. `seq`가 `GET /sessions/:id/messages`와 일치 |
| `message_queued` | 예 | 실행 중에 `steer`/`follow_up` 메시지가 접수됨 |
| `message_dequeued` | 예 | 대기 중이던 메시지가 전달되기 전에 취소됨 |

### 도구와 승인

| 종류 | 저장 | 설명 |
|---|---|---|
| `tool_execution_start` | 예 | 도구 시작 (승인이 필요했다면 승인 이후). `{toolCallId, toolName, args}` |
| `tool_execution_update` | **아니오** | 도구 출력 중간값 (예: bash 출력 스트리밍) |
| `tool_execution_end` | 예 | 도구 종료 또는 차단 |
| `approval_requested` | 예 | 도구 호출이 `POST /sessions/:id/approvals/:toolCallId`를 기다림 |
| `approval_resolved` | 예 | 승인 결정·시간 초과·중단 (`source`: `user` / `timeout` / `abort`) |
| `question_requested` | 예 | 에이전트가 `ask_user`로 질문함 |
| `question_resolved` | 예 | 질문에 답했거나 실행이 중단됨 |

### 컨텍스트

| 종류 | 저장 | 설명 |
|---|---|---|
| `context_updated` | 예 | 모델이 볼 내용의 크기가 바뀜 |
| `compaction_started` | 예 | 압축이 요약 작성을 시작 (`reason`: `manual` / `threshold`) |
| `compaction_finished` | 예 | 요약 저장 완료. 모델은 이제 요약을 봄 |
| `compaction_failed` | 예 | 압축 실패·취소. **컨텍스트는 그대로** |

### 설정과 구성 (전역, `sessionId: null`)

| 종류 | 저장 | 설명 |
|---|---|---|
| `configuration_updated` | 예 | 커스텀 프로바이더·기본값·압축·정리 정책 등이 바뀜. `GET /configuration`을 다시 읽기 |
| `provider_updated` | 예 | 프로바이더 자격 증명이 설정·삭제됨 |
| `skills_updated` | 예 | 스킬이 켜지고 꺼지거나 스킬·템플릿·AGENTS.md 파일이 바뀜 |
| `extension_settings_updated` | 예 | 확장 설정이 저장·삭제됨 |
| `client_settings_updated` | 예 | 서버에 묶인 클라이언트 설정이 바뀜. `origin`은 쓴 기기라 자기 에코를 건너뛸 수 있음 |
| `locales_updated` | 예 | 언어팩이 저장·삭제됨 |
| `group_created` `group_updated` `group_deleted` | 예 | 분할 화면 그룹 변경 |

### 터미널과 확장 (일시적)

| 종류 | 저장 | 설명 |
|---|---|---|
| `terminal_created` `terminal_updated` `terminal_closed` | 아니오 | 터미널 열림·이름 변경·종료 |
| `extensions_updated` | 아니오 | 서버 확장을 (다시) 불러옴 |
| `extension_error` | 아니오 | 서버 확장이 훅·명령·메서드에서 예외를 던짐 |
| `extension_event` | 예 (`ephemeral`이면 아니오) | 확장이 클라이언트에 발행한 사용자 정의 이벤트 |
| `extension_entry` | 예 | 확장이 세션에 기록을 남김 |

### 기기

| 종류 | 저장 | 설명 |
|---|---|---|
| `notification` | 아니오 | 기기 한 대에 보내는 OS 알림. **재생되지 않음** |
| `device_revoked` | 아니오 | 기기가 목록에서 지워짐. 그 기기는 보고를 멈춰야 함 |

## SSE

`GET /events`(전체) 또는 `GET /sessions/:id/events`(세션 하나).

| 항목 | 설명 |
|---|---|
| 필터 | `?types=a,b` 쉼표 구분 |
| 재생 | `Last-Event-ID` 헤더(브라우저 EventSource가 자동으로 보냄) 또는 `?after=<id>`. 그 커서 뒤의 **저장된** 이벤트를 먼저 재생한 뒤 실시간으로 이어짐 |
| 커서 없음 | 실시간 구독만 시작 |
| 중복·누락 | 재생 전에 먼저 구독하고 `id`로 중복을 걸러서 틈과 중복이 없음 |
| 인증 | `Authorization` 헤더 또는 `?token=` |
| 하트비트 | 15초마다 `: ping` 주석 |
| 재접속 | `retry: 2000` (2초) |
| 프레임 | `id: <n>` · `event: <type>` · `data: <봉투 JSON>` |

저장되지 않는 이벤트(`id: 0`)는 `id:` 줄이 없어 커서가 앞서지 않습니다.

```bash
curl -N -H "Authorization: Bearer $TOKEN" "http://<서버 주소>:8787/events?after=1000&types=run_finished"
```

## WebSocket (`/ws`)

REST + SSE의 양방향 대안입니다. JSON 텍스트 프레임을 씁니다.

### 클라이언트 → 서버

```json
{ "id": "1", "op": "subscribe", "sessionId": "…", "after": 1000, "types": ["run_finished"] }
```

| `op` | 인자 | 설명 |
|---|---|---|
| `subscribe` | `sessionId?`, `after?`, `types?` | 구독. `sessionId`를 생략하면 전체. 같은 대상의 이전 구독은 교체됨 |
| `unsubscribe` | `sessionId?` | 구독 해제 |
| `prompt` | `sessionId`, `text`, `mode?`, `images?` | 메시지 전송 |
| `abort` | `sessionId` | 중단 → `{aborted}` |
| `approve` | `sessionId`, `toolCallId`, `approved`, `reason?` | 승인 결정 |
| `ping` | | `{pong: <ms>}` |

`id`는 선택이며 응답에 그대로 돌아옵니다.

### 서버 → 클라이언트

| 프레임 | 설명 |
|---|---|
| `{type: "hello", subscriptions, version, protocol, minClientProtocol}` | 접속 직후 한 번. 호환성 판단용 |
| `{type: "ack", id, ok: true, result}` | 성공 |
| `{type: "ack", id, ok: false, error: {code, message}}` | 실패. `invalid_request`(프레임이 객체가 아님), `unknown_op`(모르는 `op`) 등 |
| `{type: "event", event}` | 구독한 이벤트 |

`subscribe`의 결과는 `{subscribed, latestId}`입니다. `after`를 주면 그 뒤의 저장된 이벤트를 500개씩 끊어서 재생한 뒤 실시간으로 넘어갑니다.

### 연결 관리

| 항목 | 값 |
|---|---|
| 최대 프레임 | 25MB |
| 서버 ping | 30초마다 프로토콜 ping. 직전 ping에 응답하지 않은 소켓은 끊음 (브라우저는 자동으로 응답) |
| 느린 클라이언트 | 8MB 넘게 밀리면 `1013`으로 닫음. 다시 접속해 `subscribe`의 `after`로 재생 |
| 인증 | `?token=` 허용 |
| 호환성 | `?protocol=` |

## 올바르게 구독하는 법

1. **프롬프트를 보내기 전에 먼저 구독합니다.** 스트리밍 조각은 재생되지 않습니다.
2. 끊겼다면 마지막으로 받은 `id`를 `after`로 다시 구독해 저장된 이벤트를 따라잡습니다.
3. 조각이 필요하면 놓친 구간은 `GET /sessions/:id/messages`나 `GET /sessions/:id/status`(스트리밍 중인 부분 메시지 포함)로 채웁니다.
4. `run_finished`가 오면 그 세션은 유휴입니다. 대기열 메시지가 이어서 시작되면 곧바로 `run_started`가 다시 옵니다.
5. 전역 설정 이벤트(`configuration_updated`, `skills_updated` 등)는 **무엇이 바뀌었는지가 아니라 "다시 읽으라"는 신호**입니다. 해당 `GET`을 다시 호출하세요.

## 과거 이벤트 조회

`GET /events/history?sessionId=&after=&limit=` → `{events, latestId}`. `limit`은 1~1,000(기본 200). 앱을 껐다 켠 사이의 변화를 한꺼번에 가져올 때 씁니다.

## 이벤트 스키마

`GET /events/types`는 이벤트마다 `{type, persisted, description, data}`(JSON Schema)를 돌려줍니다. 클라이언트와 확장이 페이로드 형식을 확인하는 기준입니다.
