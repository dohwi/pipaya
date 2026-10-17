서버가 읽는 환경 변수 전부와 기본값입니다. 목록은 소스(`config.ts` 외)에서 직접 찾은 것이며 이 밖의 `PIPAYA_*` 변수는 없습니다.

## 설정하는 곳

| 설치 방식 | 위치 |
|---|---|
| 설치 스크립트 | `~/.config/pipaya/server.env` (서비스가 읽음). 바꾼 뒤 서비스 재시작 |
| 수동 실행 | 서버 작업 디렉터리의 `.env` (Bun이 읽음) |
| Docker | `compose.yaml` 옆 `.env` |
| 직접 | 프로세스 환경 변수 |

## 서버

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_HOST` | `0.0.0.0` | 수신 주소. 설치 스크립트는 Tailscale IPv4(없으면 `127.0.0.1`)를 지정 |
| `PIPAYA_PORT` | `8787` | 수신 포트 |
| `PIPAYA_TOKEN` | 자동 생성 | 관리자 토큰. **24자 이상**이어야 함(짧으면 서버가 시작하지 않음). 없으면 `<data>/token`을 만들고 0600으로 보관. 권장: `openssl rand -base64url 32` |
| `PIPAYA_DATA_DIR` | `~/.pipaya` | 데이터 디렉터리 (0700) |
| `PIPAYA_DB` | `<data>/pipaya.db` | SQLite 경로 |
| `PIPAYA_LOG_LEVEL` | `info` | Fastify 로그 수준. `silent`면 끔. `?token=`은 로그에서 가려짐 |

## 작업 폴더

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_WORKSPACE` | `<data>/workspace` | 시작 시 기본 작업 디렉터리. 실행 중에는 설정 → 기본 폴더(`PUT /configuration/workdir`)로 바꾸며 저장된 값이 이 값을 덮어씀 |
| `PIPAYA_RESTRICT_WORKSPACE` | 꺼짐 | `1`이면 세션 `cwd`, 폴더 선택기, 기본 폴더, 터미널 시작 폴더가 워크스페이스 안으로 제한됨. **에이전트 도구의 파일 접근은 막지 않음** → [[security]] |

## 모델

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_PROVIDER` / `PIPAYA_MODEL` | 처음 구성된 모델 | 시작 기본 모델. 등록된 프로바이더·모델이어야 하며 **저장된 기본값이 우선** |

## 에이전트와 도구

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_APPROVAL` | `ask` | 승인 정책 기본값. `ask` / `auto` / `readonly`. 그 밖의 값이면 서버가 시작하지 않음. `readonly`는 앱에서 고르지 않고 API 전용 |
| `PIPAYA_APPROVAL_TIMEOUT_MS` | `600000` | 승인 자동 거부 시간(ms). `0`이면 무제한 |
| `PIPAYA_MAX_RUN_TURNS` | `200` | 한 실행의 최대 모델 호출 수. 0 이하이거나 숫자가 아니면 200 |
| `PIPAYA_BASH_ENV` | 없음 | `bash` 자식 프로세스에 추가로 넘길 환경 변수 **이름** 목록(쉼표 구분). `PIPAYA_`로 시작하는 이름은 무시 |
| `PIPAYA_TERMINAL` | 켜짐 | `0`이면 서버 터미널 기능을 끔 (`403 terminals_disabled`) |

`bash`와 터미널의 자식 프로세스에는 `PIPAYA_*` 변수가 전달되지 않습니다.

## 네트워크

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_CORS_ORIGINS` | 없음 | 추가로 허용할 브라우저 출처(쉼표 구분, 정확히 일치, `*`는 전체). 루프백, Tailscale, 사설망(RFC1918), `*.ts.net`, Tauri 출처는 항상 허용 |

## 알림

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_PUSH_FCM` | 켜짐 | `0`이면 모바일 푸시를 끔. 켜져 있어도 Firebase 자격 증명이 **있어야** 동작 |
| `GOOGLE_APPLICATION_CREDENTIALS` | 없음 | FCM 서비스 계정 파일 경로. 없으면 `~/.secrets/pipaya/firebase-adminsdk.json` |

## 업데이트와 확장

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_SELF_UPDATE` | 자동 감지 | `1`이면 감독 프로세스가 있다고 보고 강제로 켬, `0`이면 끔. 자동 감지는 systemd(`INVOCATION_ID`)나 launchd(`XPC_SERVICE_NAME`) 여부 → [[updates]] |
| `PIPAYA_FLAG_<이름>` | | 서버 확장의 플래그 값. 확장이 `pi.getFlag("이름")`으로 읽음 → [[server-extensions]] |
| `PIPAYA_BUILTIN_SKILLS` | 서버의 `builtin-skills/` | 내장 스킬 폴더 위치 재지정 |

## 설치 스크립트 (`install.sh`)

서버 프로세스가 아니라 `install.sh`가 읽는 변수입니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_REPO` | `https://github.com/dohwi/pipaya.git` | 받을 저장소 |
| `PIPAYA_RELEASE_URL` | `https://github.com/dohwi/pipaya/releases/download/latest` | 클라이언트 릴리스 위치 |
| `PIPAYA_BUN_VERSION` | `1.3.14` | 설치할 Bun 버전 |
| `PIPAYA_APP_DIR` | `~/.local/share/pipaya` | 설치 위치 |
| `PIPAYA_DATA_DIR` | `~/.pipaya` | 데이터 디렉터리 |

옵션(`--host`, `--port`, `--approval`, `--ref`, `--dir`, `--no-service`, `-y`)은 [[installation]]에 있습니다. `install.sh`가 쓰는 설정 파일 `server.env`에는 `PIPAYA_HOST`, `PIPAYA_PORT`, `PIPAYA_APPROVAL` 등 선택한 값이 기록됩니다.

## Docker (`compose.yaml`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_BIND` | `127.0.0.1` | 호스트에서 열 주소 |
| `PIPAYA_PORT` | `8787` | 호스트 포트 (컨테이너 안은 8787) |
| `PIPAYA_WORKSPACE_DIR` | Docker 볼륨 | 에이전트에게 줄 호스트 폴더 |
| `PIPAYA_APPROVAL` | `ask` | 승인 정책 |
| `PIPAYA_TOKEN` | 비움(자동 생성) | 토큰 |
| `PIPAYA_CORS_ORIGINS` | 비움 | 추가 출처 |
| `PIPAYA_MEM_LIMIT` | `2g` | 메모리 제한 |
| `PIPAYA_CPUS` | `2` | CPU 제한 |

이미지 안의 고정값: `PIPAYA_HOST=0.0.0.0`, `PIPAYA_PORT=8787`, `PIPAYA_DATA_DIR=/data`, `PIPAYA_WORKSPACE=/workspace`.

## 클라이언트 (개발)

| 명령 | 설명 |
|---|---|
| `bun run dev` | 개발 서버 (기본 포트 1420) |
| 앱 주소의 `?extensions=off` | 모든 클라이언트 확장 실행 중지 (안전 모드) |

## 읽는 방법 요약

```ini
# ~/.config/pipaya/server.env 예
PIPAYA_HOST=100.x.y.z
PIPAYA_PORT=8787
PIPAYA_APPROVAL=ask
PIPAYA_APPROVAL_TIMEOUT_MS=600000
PIPAYA_CORS_ORIGINS=https://my-client.example
PIPAYA_RESTRICT_WORKSPACE=1
PIPAYA_TERMINAL=0
```
