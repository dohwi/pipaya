# Pi 컨텍스트 압축 — BE 구현 요청 / FE 계약

## 현재 상태

FE의 `/compact [instructions]` 명령, 입력창의 진행/취소 표시, 오류 안내, REST/SSE 상태 복구를 구현했다. 압축 실행은 슬래시 명령으로만 제공하며 footer에는 실행 버튼을 두지 않는다. **실제 컨텍스트 감소는 BE 구현 이후에 동작한다.** 이 작업에서 `server/` 코드는 수정하지 않았다.

현재 `server/src/sessions.ts`는 `@earendil-works/pi-agent-core`의 저수준 `Agent`를 사용한다. pi CLI의 `/compact`를 일반 사용자 메시지로 보내거나 FE 기록만 제거하는 방식은 실제 모델 컨텍스트를 압축하지 않는다.

## 필수 REST 계약

기존 Bearer 인증과 세션 접근 검증을 그대로 적용한다.

### `POST /sessions/:id/compact`

요청:

```json
{ "customInstructions": "결정한 API 계약과 수정 파일을 보존" }
```

`customInstructions`는 선택 사항이다. 인자가 없으면 `{}`를 전송한다. 다른 메시지/실행/모델 변경/동시 압축과 원자적으로 배타 처리한다. 수동 압축은 idle 세션에서만 허용한다.

**압축 실행과 영속화가 완료된 뒤** `200`으로 응답한다. 현재 FE는 `202` 작업 시작 응답을 지원하지 않는다.

```json
{
  "tokensBefore": 82000,
  "context": { "tokens": 24000, "contextWindow": 128000 }
}
```

압축 직후 사용량을 측정할 수 없으면 `context.tokens`는 `null`을 반환한다. 누적 `usage.totalTokens`나 압축 이전 마지막 응답의 토큰을 현재 컨텍스트로 재사용하지 않는다. SDK 결과를 사용해 실제 감소량을 계산하며 감소를 보장하지 않는다.

오류는 기존 `{ "error": { "code": "...", "message": "..." } }` 형식을 사용한다.

- 미지원: `501`, `compaction_not_supported` (미구현 라우트의 `404`도 FE가 안내)
- 실행/압축/승인 대기/닫힌 세션: `409`, 이해 가능한 오류 메시지
- 압축할 기록 부족: 명시적인 오류; 성공 또는 가짜 토큰 감소를 반환하지 않음
- 제공자 오류/취소: terminal 실패 이벤트를 발행하고 압축 이전 유효 컨텍스트를 유지

요약 요청은 재시도 시 추가 비용이 발생할 수 있다. FE는 네트워크 오류 시 POST를 자동 재시도하지 않고 세션 상태만 재조회한다. 장기 요청에 대한 서버/프록시 timeout도 고려한다.

### `GET /sessions/:id` 확장

기존 필드를 보존하고 아래 항목을 추가한다.

```json
{
  "context": { "tokens": 24000, "contextWindow": 128000 },
  "compaction": { "supported": true, "autoEnabled": true },
  "status": { "compacting": false }
}
```

- `context`는 현재 모델에 보낼 **활성 projection**의 토큰이다. 미측정은 `null`이다.
- 압축 성공 직후 미측정 상태에서도 `context` 객체를 반환해야 한다. 객체 생략은 구버전 서버로 취급되어 마지막 응답 기반 추정치가 표시된다.
- `status.compacting`은 수동/자동 압축 모두 포함한다. 새로고침 및 다른 클라이언트 접속 시 복구할 수 있어야 한다.
- `status.running`은 기존 에이전트 실행 상태를 유지한다. 자동 압축 중 둘 다 `true`일 수 있다.
- `compaction.supported`는 capability, `autoEnabled`는 서버의 실제 설정이다. FE에 자동 압축 설정을 저장하는 기능은 없다.
- 모델 변경 시 `contextWindow`도 현재 모델 기준으로 갱신한다.

### `POST /sessions/:id/abort` 확장

기존 run abort 외에 진행 중인 압축의 AbortSignal을 취소한다. `compaction_failed`를 `aborted: true`로 발행하고 상태를 해제한다. **SDK의 `session.abortCompaction(): void`를 사용한다.** 에이전트 실행도 취소하려면 기존 실행 취소 경로를 함께 적용한다.

## 필수 SSE 계약

기존 event envelope `{ id, sessionId, type, ts, data }`를 유지한다. pi SDK 이벤트를 그대로 보내지 말고 다음 harness 이벤트로 정규화한다.

| 이벤트 | `data` | 시점 |
|---|---|---|
| `compaction_started` | `{ reason: "manual" \| "threshold" \| "overflow" }` | 상태 잠금 후, 요약 시작 전 |
| `compaction_finished` | `{ tokensBefore, context, usage? }` | 압축 영속화/활성 projection 재구성 후 |
| `compaction_failed` | `{ errorMessage?: string, aborted: boolean }` | 오류/취소 시 반드시 한 번 |
| `context_updated` | `{ context: { tokens: number \| null, contextWindow: number } }` | 메시지/도구 결과/모델 변경 후 최신 추정이 준비됐을 때 |

`usage`가 있다면 기존 harness `Usage` 모양의 **누적** 사용량으로 반환한다. `GET /sessions/:id/usage`도 요약 호출 비용/토큰을 포함하도록 확장한다. 원본 assistant 호출의 비용이 사라져서는 안 된다.

SSE 완료/실패는 HTTP 완료보다 먼저 올 수 있다. FE는 최신 이벤트를 우선하며 원본 transcript를 지우지 않는다. 재접속은 REST snapshot과 replay로 복구한다. 실행 중 자동 압축을 수동 압축처럼 `run_finished`로 처리하지 않는다.

## Pi 통합 요구사항

권장 방향은 `@earendil-works/pi-coding-agent`의 `AgentSession`과 `SessionManager`를 사용해 `session.compact(customInstructions)` 및 자동 압축을 활용하는 것이다. 저수준 `Agent`에 동일 메서드가 존재한다고 가정하지 않는다.

- 기존 제공자 registry/stream 함수, custom tools, cwd, 모델/추론 설정, 승인 정책을 유지한다. SDK 기본 discovery가 현재 서버의 승인 경계를 우회하지 않도록 한다.
- 기존 SQLite transcript에서 SDK session entry/활성 leaf를 복구하는 변환 또는 별도 durable SDK session 저장소와 매핑이 필요하다. `agent.state.messages`만 교체하는 것은 SDK 영속 컨텍스트 교체가 아니다.
- `CompactionEntry`의 요약과 kept boundary를 영속화한다. 서버 재시작/idle eviction 뒤 원본 전체를 재주입해 압축을 되돌리지 않는다.
- 원본 `/messages` 조회/복사/분기 기록은 유지하고 모델 projection과 분리한다. 분기 지점에 맞는 압축 상태를 복구해야 한다.
- 도구 호출과 결과는 분리해서 잘라내지 않는다. 연속 압축은 이전 요약과 보존 구간을 반영한다. pi 기본 구현을 재사용한다.
- 자동 압축 설정은 서버가 관리한다. 기본값: `enabled: true`, `reserveTokens: 16384`, `keepRecentTokens: 20000`; 모델별 context/max output에 맞는 예산도 검증한다. 단순 FE 사용률 70% 경고와 실제 pi threshold는 다르다.
- 자동 압축은 새 프롬프트/다음 모델 턴 전에 검사하고 overflow recovery도 포함한다. multi-client 동시 전송, 승인 대기, steer/follow-up 큐, 취소 및 종료 순서를 유지한다.
- 설치된 SDK는 수동/자동 공통 `compaction_start` (`reason`) 및 `compaction_end` (`reason`, `result`, `aborted`, `willRetry`, `errorMessage?`)를 발행한다. 이를 harness `compaction_started`/`compaction_finished`/`compaction_failed`로 변환한다. 별도의 시작/종료 이벤트를 중복 발행하지 않는다.
- `session.getContextUsage()`는 `{ tokens: number | null, contextWindow, percent: number | null } | undefined`다. FE는 `percent`를 계산하므로 `tokens`와 `contextWindow`만 필요하다. `CompactionResult`에는 `tokensBefore`, `estimatedTokensAfter?`, `usage?` 등이 있지만 FE 응답은 SDK 결과를 그대로 반환하지 않고 위 REST 모양으로 정규화한다.

참고: 설치된 pi 문서 `docs/sdk.md`, `docs/compaction.md`, `docs/session-format.md`, 그리고 SDK의 `dist/core/agent-session.d.ts`.

## BE 완료 기준

1. 수동 압축 후 **다음 실제 모델 요청**에 요약 + retained messages만 전달되는지 확인.
2. 원본 transcript와 누적 요약 비용이 보존되는지 확인.
3. 재시작/idle eviction/분기/연속 압축에도 projection이 올바른지 확인.
4. 동시 POST, send/retry/configure 경쟁, 승인 대기, steer/follow-up에서 안전성 확인.
5. 제공자 실패/취소에서 terminal 이벤트, 상태 잠금 해제, 컨텍스트 보존 확인.
6. 자동 threshold/overflow와 재접속/다른 클라이언트 진행 상태 확인.
7. FE 계약대로 REST `200` 결과와 SSE snapshot을 통합 테스트.
