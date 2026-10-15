# 설정 레퍼런스

서버는 `server/.env`(Bun이 작업 디렉터리의 `.env`를 읽음) 또는 환경변수로 설정합니다. 예시는 `server/.env.example`에 있습니다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HARNESS_HOST` / `HARNESS_PORT` | `0.0.0.0` / `8787` | 수신 주소 |
| `HARNESS_TOKEN` | 자동 생성 | 관리자 Bearer 토큰. 24자 이상이어야 하며 짧으면 서버가 시작을 거부합니다 |
| `HARNESS_DATA_DIR` | `~/.pipaya` | DB, 토큰, 기본 작업 공간 |
| `HARNESS_DB` | `<data>/harness.db` | SQLite 경로 |
| `HARNESS_WORKSPACE` | `<data>/workspace` | 시작 시 기본 작업 디렉터리. 실행 중에는 `PUT /configuration/workdir`로 바꾸며(SQLite 저장) 그 값이 우선합니다 |
| `HARNESS_RESTRICT_WORKSPACE` | `0` | `1`이면 세션·폴더 선택기·기본 작업 디렉터리를 `HARNESS_WORKSPACE` 안으로 제한 |
| `HARNESS_PROVIDER` / `HARNESS_MODEL` | 처음 설정된 모델 | 시작 기본값. 등록된 사용자 정의 제공자·모델이어야 하며 저장된 기본값이 우선합니다 |
| `HARNESS_APPROVAL` | `ask` | `auto` / `ask` / `readonly` |
| `HARNESS_APPROVAL_TIMEOUT_MS` | `600000` | 승인 자동 거부까지 시간. `0`이면 무제한 |
| `HARNESS_BASH_ENV` | 비어 있음 | `bash`가 물려받을 추가 환경변수 **이름** (쉼표 구분) |
| `HARNESS_LOG_LEVEL` | `info` | Fastify 로그 레벨. `silent`면 로그 없음 |
| `HARNESS_PUSH_FCM` | 켜짐(자격 증명이 있을 때만 동작) | `0`이면 Android FCM 푸시를 끕니다. Google ADC 자격 증명이 없으면 자동으로 꺼집니다 |
| `HARNESS_CORS_ORIGINS` | 비어 있음 | 허용할 추가 브라우저 출처(쉼표 구분, 정확히 일치). `*`는 전부 허용 |

CORS는 루프백, Tailscale `100.64.0.0/10`, 사설 LAN, `*.ts.net`, Tauri 출처를 항상 허용합니다.

### Docker 전용 (`compose.yaml`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HARNESS_BIND` | `127.0.0.1` | 호스트에서 게시할 주소. 폰에서 쓰려면 Tailscale 주소 |
| `HARNESS_PORT` | `8787` | 게시 포트 |
| `HARNESS_WORKSPACE_DIR` | 볼륨 `workspace` | 에이전트가 일할 호스트 폴더 |
| `HARNESS_MEM_LIMIT` / `HARNESS_CPUS` | 2 GB / 2 | 자원 제한 |

컨테이너 보안 설정: 비특권 사용자(uid 10001), 읽기 전용 루트 파일시스템, 모든 Linux capability 제거, `no-new-privileges`, 프로세스 512개 제한. 컨테이너에는 `git`, `ripgrep`, `bash`만 들어 있으므로 node나 python이 필요하면 `server/Dockerfile`에 추가하세요. 호스트의 로컬 모델 서버(`localhost`)는 컨테이너에서 보이지 않으므로 `extra_hosts`를 켜고 `http://host.docker.internal:11434/v1` 같은 주소로 등록합니다.

## 모델 연결

서버는 비어 있는 카탈로그로 시작합니다. 설정 → 모델(또는 API)에서 등록합니다.

1. `PUT /configuration/providers/:id`로 엔드포인트와 모델을 등록합니다.
2. `PUT /providers/:id/credential`에 `{key}`를 보내 키를 저장합니다. `DELETE`로 지웁니다.
3. 기본 모델은 설정에서 고르거나 `HARNESS_PROVIDER` / `HARNESS_MODEL`로 시작 기본값을 줍니다.

지원하는 API 형식은 OpenAI Chat Completions, OpenAI Responses, Anthropic Messages입니다. 모델이 추론(reasoning)을 지원하지 않으면 선택한 사고 강도는 무시됩니다.

## 서버에 저장되는 설정 API

| 경로 | 내용 |
|---|---|
| `GET/PUT /compaction` | `{auto, model}` 압축 자동 실행 여부와 요약 모델 |
| `GET/PUT /subagents` | 서브에이전트 정의 |
| `GET/PUT /retention` | 오래된 세션 자동 정리 정책 |
| `GET/PUT /client-settings/:key` | 서버 범위 클라이언트 설정 (`favModels`, `extensions`, `notificationPolicy`만 허용) |
| `PUT /skills/:name` | 스킬 켜기/끄기 |
| `PUT /locales/:tag` | 언어팩 |

`client-settings`는 키당 마지막 쓰기 승리 방식이며, 서버가 허용한 키 외의 값은 거부합니다. 어떤 설정이 서버에 있고 어떤 설정이 기기에 있는지는 [설정은 어디에 저장되나](settings-scope.md)를 보세요.

## 개발용 명령

```bash
cd server && bun run typecheck && bun test
cd client && bun run check && bun test tests
```

서버 테스트는 응답 계약까지 검증합니다 (운영 환경에서는 응답마다 검증하지 않아 오버헤드가 없습니다).
