# 빠른 시작

서버를 먼저 띄우고, 클라이언트로 접속한 뒤, 모델을 하나 등록하면 끝입니다.

## 1. 서버 실행 방식 고르기

| 방식 | 추천 상황 | 격리 |
|---|---|---|
| **호스트 설치** | 내 머신·서버에서 매일 쓸 때 | 없음. 도구가 내 사용자 권한으로 실행됩니다 |
| **Docker 샌드박스** | 에이전트 명령이 호스트에 닿지 않게 하고 싶을 때 | 컨테이너, 비특권 사용자, 읽기 전용 루트 |
| **소스 실행** | 개발 | 없음 |

### 호스트 설치 (Linux, macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/pipaya/main/install.sh | bash
```

설치 스크립트는 `git`과 `curl`이 필요합니다. Bun을 (확인 후) 설치하고 서버를 `~/.local/share/pipaya`에 받아 **사용자 서비스**(systemd 또는 launchd)로 띄웁니다. 비정상 종료 시 자동으로 재시작하고 부팅 때 시작합니다. root로는 아무것도 실행하지 않습니다.

- **주소**: Tailscale이 있으면 Tailscale 주소, 없으면 `127.0.0.1`만 사용합니다.
- **토큰**: `~/.pipaya/token` (권한 `0600`)
- **승인 정책**: 기본 `ask`

```bash
bash ~/.local/share/pipaya/install.sh update      # 최신 코드로 갱신하고 재시작
bash ~/.local/share/pipaya/install.sh status
bash ~/.local/share/pipaya/install.sh uninstall   # ~/.pipaya 는 유지
```

### Docker 샌드박스

```bash
git clone https://github.com/dohwi/pipaya.git && cd pipaya
docker compose up -d --build
docker compose exec harness cat /data/token      # 인증 토큰
```

서버는 `http://127.0.0.1:8787`에서 열립니다. 호스트의 프로젝트 폴더에서 작업시키려면 `compose.yaml` 옆 `.env`에 `HARNESS_WORKSPACE_DIR=/path/to/project`를 적습니다. 그 폴더는 에이전트가 수정·삭제할 수 있다는 점에 유의하세요.

> [!WARNING]
> 샌드박스는 피해를 줄여 줄 뿐 완전한 보안 경계가 아닙니다. 컨테이너는 LAN을 포함한 네트워크에 접근할 수 있고 마운트한 작업 폴더를 마음대로 바꿀 수 있습니다. `/var/run/docker.sock`이나 민감한 폴더를 마운트하지 마세요.

### 소스에서 실행

```bash
mise trust && mise install            # bun 1.3, rust stable
cd server && bun install && bun run dev      # http://0.0.0.0:8787
cd client && bun install && bun run dev      # http://0.0.0.0:1420
```

## 2. 클라이언트 설치

| 플랫폼 | 설치 |
|---|---|
| Windows x64 | `irm https://raw.githubusercontent.com/pipaya/main/install.ps1 \| iex` |
| macOS (Apple Silicon) | `curl -fsSL https://raw.githubusercontent.com/pipaya/main/install.sh \| bash -s -- client` |
| Android ARM64 | 릴리스의 서명된 APK |
| iOS ARM64 | 릴리스의 미서명 IPA (Apple 서명이 필요해 그대로는 설치되지 않습니다) |

웹으로도 쓸 수 있습니다. 개발 모드에서는 `client`의 `bun run dev`가 `1420` 포트를 엽니다.

## 3. 접속하고 모델 등록

1. 클라이언트를 열고 **서버 주소**와 **토큰**을 입력합니다.
2. **설정 → 모델**에서 연결을 추가합니다. 엔드포인트 종류(OpenAI Chat Completions / Responses / Anthropic Messages), URL, 모델 목록, API 키를 넣습니다.
3. 새 대화를 만들고 작업 디렉터리를 고른 뒤 메시지를 보냅니다.

> [!NOTE]
> 서버를 처음 띄우면 모델 카탈로그가 비어 있습니다. 모델을 등록하기 전에는 대화를 시작할 수 없습니다.

## 4. 폰 연결 (QR 페어링)

폰에 토큰을 직접 입력하는 대신 **페어링 코드**를 씁니다. 코드는 2분 동안, 한 번만 쓸 수 있고, 쓰고 나면 아무 가치가 없습니다. 코드를 사용하면 **그 기기만의 토큰**이 발급되므로, 폰을 잃어버렸을 때 그 기기 토큰만 폐기하면 됩니다. 자세한 내용은 [인증과 기기 토큰](auth-devices.md)을 보세요.

## 접속 주소 정하기

서버는 개인 네트워크에서만 여는 것을 전제로 합니다. 토큰은 관리자 권한이기 때문입니다.

- 같은 PC에서만 쓴다면 `127.0.0.1`
- 폰·다른 PC에서 쓴다면 **Tailscale** 주소를 권장합니다
- 공용 주소에 그대로 열지 마세요. 꼭 필요하면 HTTPS 뒤에 두세요
