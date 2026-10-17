서버를 띄운 뒤의 관리 작업을 정리합니다: 서비스 관리, 데이터 위치, 백업, 정리, 모니터링.

## 서비스 관리

### Linux (systemd 사용자 서비스)

`install.sh`가 `~/.config/systemd/user/pipaya.service`를 만듭니다.

```bash
systemctl --user status pipaya
systemctl --user restart pipaya
systemctl --user stop pipaya        # 명시적으로 멈추면 그대로 멈춤
journalctl --user -u pipaya -f      # 로그 보기
```

- `Restart=always`, `RestartSec=3`: 죽거나 종료돼도 3초 뒤에 다시 시작합니다. `systemctl stop`만 멈춰 둡니다.
- 설정 파일은 `~/.config/pipaya/server.env`이고 서비스가 `EnvironmentFile`로 읽습니다. 값을 바꾼 뒤 `systemctl --user restart pipaya`.
- 사용자 서비스는 로그아웃하면 멈추고 부팅 때 시작되지 않는 것이 기본입니다. 스크립트가 `loginctl enable-linger`를 시도하고, 실패하면 `sudo loginctl enable-linger $USER`를 안내합니다.

### macOS (launchd)

서비스 이름은 `app.pipaya.server`입니다. `launchctl kickstart -k gui/$(id -u)/app.pipaya.server`로 재시작합니다.

### 공통

```bash
install.sh status      # /health를 불러 실행 여부 확인
```

### 직접 실행

```bash
cd ~/.local/share/pipaya/server
set -a && . ~/.config/pipaya/server.env && set +a
bun src/index.ts
```

서버는 `SIGINT`/`SIGTERM`을 받으면 정리하고 종료하며, 10초 안에 끝나지 않으면 강제 종료합니다.

## 시작할 때 일어나는 일

1. 데이터 디렉터리(`0700`)와 SQLite DB(새로 만들면 `0600`)를 준비하고 마이그레이션을 적용
2. 토큰 파일 확인 또는 생성(`0600`)
3. 서버 확장 불러오기
4. 모델 연결의 모델 목록을 백그라운드에서 업스트림과 동기화
5. 파일 감시 시작(`~/.agents`, 각 작업 디렉터리의 `.agents`·`.pi`)
6. 자동 정리 예약 (시작 30초 뒤 한 번, 이후 1시간마다), 이벤트 로그 정리(6시간마다 7일 지난 것 삭제)
7. 시스템 모델이 설정돼 있으면 제목·역할이 없는 기존 세션에 백그라운드로 채움

## 데이터 위치

```text
~/.pipaya/                      # PIPAYA_DATA_DIR (0700)
├── pipaya.db                   # 세션, 메시지, 이벤트, 설정, 자격 증명 (새 DB는 0600)
├── pipaya.db-wal               # SQLite가 관리
├── pipaya.db-shm
├── token                       # 관리자 토큰 (0600)
├── locales/                    # 언어팩 (0700)
├── extensions/                 # 서버 확장
└── workspace/                  # 기본 작업 폴더 (PIPAYA_WORKSPACE)
```

| 위치 | 내용 |
|---|---|
| `~/.agents/` | 전역 `AGENTS.md`, `skills/`, `templates/`, `subagents/`, `extensions/` (서버 사용자의 홈) |
| `<프로젝트>/.agents/`, `.pi/` | 프로젝트 스킬·템플릿·하위 에이전트 |
| `<작업 폴더>/.pipaya/uploads/` | 사용자가 올린 첨부 파일 |
| `~/.config/pipaya/server.env` | 설치 스크립트가 만든 환경 변수 파일 |
| `~/.local/share/pipaya/` | 설치된 서버 코드(`install.sh`) |
| `~/.secrets/pipaya/firebase-adminsdk.json` | 모바일 푸시용 Firebase 자격 증명(선택) |

Docker에서는 `/data`(데이터)와 `/workspace`(작업 폴더)가 볼륨입니다.

> [!NOTE]
> 옛 `server/data` 폴더는 자동으로 가져오지 않습니다. 계속 쓰려면 `PIPAYA_DATA_DIR=./data`로 지정하세요.

## 백업과 복원

| 대상 | 방법 |
|---|---|
| 데이터 전체 | `~/.pipaya/` 폴더 |
| 코드 | 필요 없음. 설치 스크립트로 다시 받음 |
| 설정(`server.env`) | `~/.config/pipaya/server.env` |
| 사용자 지침 | `~/.agents/` |

> [!WARNING]
> **실행 중에 `pipaya.db`만 복사하지 마세요.** SQLite는 WAL 모드라 `-wal`·`-shm` 파일에 아직 반영되지 않은 내용이 있을 수 있습니다. 서비스를 멈춘 뒤 복사하거나 SQLite의 백업 기능을 쓰세요. 백업에는 **API 키와 토큰이 포함**되므로 보관에 주의하세요.

```bash
systemctl --user stop pipaya
tar czf pipaya-backup-$(date +%F).tgz -C ~ .pipaya .agents
systemctl --user start pipaya
```

복원은 서비스를 멈추고 파일을 되돌린 뒤 시작합니다. 앱 쪽 백업(서버 연결, 확장, 단축키)은 [[settings]]의 **백업** 탭입니다.

## 정리하기

| 대상 | 방법 |
|---|---|
| 오래된 대화 | 설정 → 서버 → 대화의 **자동 삭제** 또는 일괄 삭제 → [[sessions]] |
| 이벤트 로그 | 자동 (7일) |
| 올린 파일 | 자동으로 지우지 않음. 작업 폴더의 `.pipaya/uploads/`를 직접 정리 |
| 대화 기록 | 세션을 삭제하면 메시지·이벤트·압축 기록이 함께 삭제됨 |

## 모니터링

| 확인 | 방법 |
|---|---|
| 살아 있나 | `GET /health` — 토큰 없이도 `ok`, `version`, `protocol`, `minClientProtocol` |
| 부하 | 토큰을 붙인 `GET /health`는 추가로 가동 시간, 실행 중 세션 수, 구독자 수 |
| 실행 중 작업 | `GET /activity` — 세션별 실행 중·승인 대기 |
| 이벤트 흐름 | `GET /events` (SSE) → [[events]] |
| 확장 오류 | `GET /server-extensions/errors` |
| 로그 수준 | `PIPAYA_LOG_LEVEL` (`silent`면 끔). `?token=`은 로그에서 가려짐 |

Docker 컨테이너는 30초마다 `/health`를 확인하는 헬스체크가 들어 있습니다(시작 유예 15초, 재시도 3회).

## 환경 변수

전체 목록은 [[env]]에 있습니다. 설정 파일은 설치 방식에 따라 다릅니다.

| 설치 | 설정 위치 |
|---|---|
| 스크립트 | `~/.config/pipaya/server.env` |
| 수동 실행 | 서버 작업 디렉터리의 `.env` (Bun이 읽음) |
| Docker | `compose.yaml` 옆 `.env` |

## 제거

```bash
install.sh uninstall     # 서비스와 코드 제거 (데이터는 유지)
rm -rf ~/.pipaya         # 데이터까지 지우려면. 되돌릴 수 없음
```

Docker는 `docker compose down`, 볼륨까지 지우려면 `docker compose down -v`입니다.
