설치는 **클라이언트**(앱)와 **서버**(필수) 두 부분입니다. 먼저 클라이언트 앱을 설치하고, 이어서 서버를 설치해 앱에서 연결하세요.

## 준비물

| 항목 | 설명 |
|---|---|
| 서버 OS | Linux 또는 macOS (설치 스크립트 기준) |
| 도구 | `git`, `curl`. Bun은 스크립트가 설치 여부를 묻고 설치 (버전 고정, 체크섬 검증) |
| 네트워크 | 다른 기기에서 접속하려면 [Tailscale](https://tailscale.com) 권장 |

## 클라이언트 설치

| 플랫폼 | 방법 | 파일 |
|---|---|---|
| Windows x64 | PowerShell에서 `irm https://raw.githubusercontent.com/dohwi/pipaya/main/install.ps1 \| iex` | `pipaya-windows-x64-setup.exe` |
| macOS Apple Silicon | `install.sh client`로 받고 Applications로 드래그 | `pipaya-macos-arm64.dmg` |
| Android arm64 | 릴리스에서 APK를 받아 설치 | `pipaya-android-arm64.apk` |
| iOS | CI가 서명 없는 IPA를 빌드. 설치에는 별도 서명 필요 | `pipaya-ios-arm64-unsigned.ipa` |
| Linux / 웹 | 미리 빌드된 앱 없음. 웹 클라이언트 사용 | |

릴리스: `https://github.com/dohwi/pipaya/releases/tag/latest`. 모든 파일의 체크섬은 `SHA256SUMS.txt`에 있고, 스크립트는 받은 뒤 이를 검증합니다.

> [!NOTE]
> Windows 설치 파일은 Authenticode 서명이 없어 SmartScreen 경고가 나올 수 있습니다. macOS 앱은 ad-hoc 서명이고 공증되지 않았습니다. 첫 실행이 막히면 **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 누르세요.

### 웹 클라이언트 (Linux 포함)

```bash
cd client
bun install
bun run dev -- --host 0.0.0.0     # 기본 포트 1420
```

정적 파일은 `bun run build`로 `client/dist/`에 만듭니다. 서버와 다른 주소에서 클라이언트를 열면 서버의 `PIPAYA_CORS_ORIGINS`에 그 주소를 추가해야 합니다. 루프백, Tailscale(`100.64.0.0/10`, `*.ts.net`), 사설망(RFC1918), Tauri 출처는 기본 허용입니다.

### 데스크톱 앱 직접 빌드

```bash
cd client
bun run tauri dev       # Linux는 webkit2gtk-4.1 등 빌드 의존성 필요
```

## 서버 설치

### 방법 A. 설치 스크립트 (권장)

```bash
curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh | bash
```

스크립트가 하는 일:

1. Bun을 확인하고 없으면 체크섬을 검증해 설치
2. 코드를 `~/.local/share/pipaya`에 받음
3. 사용자 서비스로 등록하고 시작 (Linux: systemd `--user`, macOS: launchd). 죽거나 종료돼도 자동 재시작
4. 접속 주소와 토큰 위치를 안내

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--host ADDR` | Tailscale IPv4, 없으면 `127.0.0.1` | 수신 주소. `0.0.0.0`은 방화벽·사설망 뒤에서만 |
| `--port N` | `8787` | 포트 |
| `--approval MODE` | `ask` | `ask` / `readonly` / `auto` |
| `--ref REF` | `main` | 설치할 브랜치 또는 태그 |
| `--dir PATH` | `~/.local/share/pipaya` | 설치 위치 |
| `--no-service` | | 서비스 등록 없이 설치만 |
| `-y`, `--yes` | | Bun 설치 확인 생략 |

```bash
# Tailscale 주소로 열기
curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh | bash -s -- --host "$(tailscale ip -4)"
```

| 관리 명령 | 설명 |
|---|---|
| `install.sh status` | 실행 여부 확인 (`/health` 호출) |
| `install.sh update` | 최신 코드를 받고 서비스 재시작 |
| `install.sh client` | 이 OS용 클라이언트를 받고 체크섬 검증 |
| `install.sh uninstall` | 서비스와 코드 제거. **데이터는 유지** |

서비스 이름은 Linux `pipaya`(systemd 사용자 유닛), macOS `app.pipaya.server`(launchd)입니다. 설정 파일은 `~/.config/pipaya/server.env`입니다.

토큰은 설치 후 이렇게 확인합니다.

```bash
cat ~/.pipaya/token
```

### 방법 B. 수동 실행

```bash
git clone https://github.com/dohwi/pipaya.git
cd pipaya/server
bun install
bun run start        # 개발 중에는 bun run dev
```

저장소의 `mise.toml`이 Bun 1.3과 Rust stable을 지정합니다. 직접 실행하면 기본 수신 주소가 `0.0.0.0:8787`이므로 사설망 뒤에서만 쓰세요.

### 방법 C. Docker (격리 실행)

에이전트의 `bash`와 파일 작업이 호스트가 아닌 **컨테이너 안에서** 실행됩니다.

```bash
docker compose up -d --build
docker compose exec pipaya cat /data/token     # 토큰 확인
```

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PIPAYA_BIND` | `127.0.0.1` | 열 주소. 다른 기기에서 쓰려면 Tailscale IP |
| `PIPAYA_PORT` | `8787` | 호스트 포트 |
| `PIPAYA_WORKSPACE_DIR` | Docker 볼륨 | 에이전트에게 줄 호스트 폴더. 그 안의 파일은 변경·삭제될 수 있음 |
| `PIPAYA_APPROVAL` | `ask` | 승인 정책 |
| `PIPAYA_TOKEN` | 자동 생성 | 비우면 `/data/token` 생성 |
| `PIPAYA_CORS_ORIGINS` | 없음 | 추가 허용 출처 |
| `PIPAYA_MEM_LIMIT` / `PIPAYA_CPUS` | `2g` / `2` | 자원 제한 |

변수는 `compose.yaml` 옆 `.env` 파일에 둡니다. 컨테이너는 비루트(`10001`), 읽기 전용 루트 파일시스템, `cap_drop: ALL`, `no-new-privileges`, `pids_limit: 512`로 실행되고 `/tmp`(512MB)와 홈(256MB)만 tmpfs로 쓰기 가능합니다.

호스트의 Ollama를 쓰려면 `compose.yaml`의 `extra_hosts` 주석을 풀고 연결 주소를 `http://host.docker.internal:11434/v1`로 등록하세요.

## 설치 확인

```bash
curl http://<서버 주소>:8787/health
```

`ok`, `version`, `protocol`이 담긴 JSON이 오면 서버가 정상입니다(토큰 없이 부르면 부하 수치는 빠집니다). 이어서 [[quick-start]]로 진행하세요.
