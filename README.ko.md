<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner.ko-dark.svg" />
    <img src=".github/assets/banner.ko.svg" alt="pipaya" width="100%" />
  </picture>

  <p><a href="README.md">English</a> · <b>한국어</b></p>

  <p>
    <a href="https://bun.sh" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Bun-1.3-000000?style=flat-square&logo=bun&logoColor=white" alt="Bun" /></a>
    <a href="https://fastify.dev" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white" alt="Fastify" /></a>
    <a href="https://svelte.dev" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Svelte-5-FF3E00?style=flat-square&logo=svelte&logoColor=white" alt="Svelte" /></a>
    <a href="https://tauri.app" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri" /></a>
    <a href="https://www.typescriptlang.org" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="https://www.sqlite.org" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite" /></a>
    <img src="https://img.shields.io/badge/Docker-Sandbox-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker Sandbox" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-5C5C5C?style=flat-square" alt="MIT" /></a>
    <a href="https://discord.gg/rn3uEghsjh" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
  </p>
</div>

pipaya는 **내 서버에서 돌리는 AI 에이전트 채팅 도구**입니다. 서버가 모델 호출과 도구 실행을 맡고, 앱은 어느 기기에서든 같은 서버에 접속합니다. 세션, 설정, API 키는 내 서버의 SQLite에만 저장되며 클라우드 계정이 필요 없습니다.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/preview-dark.png" />
    <img src=".github/assets/preview-light.png" alt="데스크톱과 모바일에서 실행 중인 pipaya" width="100%" />
  </picture>
</p>

## 주요 기능

- **내장 도구 6종**: read, write, edit, ls, grep, bash. 그 밖의 것(질문하기, 다른 대화에 메시지 보내기 등)은 확장이 제공합니다
- **어떤 모델이든**: 내장 제공자, 로컬 서버(Ollama, LM Studio, llama.cpp, vLLM), 직접 만든 엔드포인트
- **여러 기기, 하나의 대화**: Windows, macOS, Android, 웹. 알림과 모바일 푸시 지원
- **협업과 분할 화면**: 한 화면에 대화를 최대 8개까지 배치하고, 확장으로 대화끼리 일을 넘기게 할 수 있습니다
- **확장 가능**: AGENTS.md, 스킬, 템플릿, 하위 에이전트, 서버·클라이언트 확장

## 빠른 설치

클라이언트를 설치하세요. Windows와 macOS 앱은 **서버를 내장**하고 있어("이 PC", loopback 전용) 따로 설치할 것이 없습니다.

| 클라이언트 | 설치 방법 |
|---|---|
| Windows x64 | `irm https://raw.githubusercontent.com/dohwi/pipaya/main/install.ps1 \| iex` |
| macOS (Apple Silicon) | `curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh \| bash -s -- client` |
| Android | [최신 릴리스](https://github.com/dohwi/pipaya/releases/tag/latest)의 APK. 아래 headless 서버가 필요합니다 |
| Linux, 웹 | `cd client && bun install && bun run dev -- --host 0.0.0.0`. 아래 headless 서버가 필요합니다 |

앱을 열어 **설정 → 모델 연결**에서 모델을 연결하세요.

## Headless 서버

휴대폰, 웹, 여러 기기에서 쓰려면 서버를 따로 실행하세요. Linux 또는 macOS에서 `git`과 `curl`이 필요하고, Bun은 설치 전에 물어봅니다.

```bash
curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh | bash
```

`8787` 포트에 사용자 서비스로 등록하고 접속 토큰 위치(`~/.pipaya/token`)를 알려 줍니다. 기본 수신 주소는 Tailscale IP가 있으면 그 주소, 없으면 `127.0.0.1`입니다. 앱에서 `http://<서버 주소>:8787`과 토큰을 추가하세요.

그 밖의 명령: `install.sh update | status | uninstall`. 컨테이너로 실행하려면 아래를 보세요.

## Docker로 서버 실행 (Sandbox)

보안 설정을 강화한 컨테이너에서 서버를 실행해, 에이전트의 `bash`와 파일 도구가 컨테이너 안에 머물게 합니다.

```bash
docker compose up -d --build
docker compose exec pipaya cat /data/token    # 접속 토큰
```

`.env` 파일에 `PIPAYA_WORKSPACE_DIR`(에이전트가 작업할 호스트 폴더), `PIPAYA_BIND`, `PIPAYA_PORT`를 지정할 수 있습니다. 자세한 내용은 [`compose.yaml`](compose.yaml)을 보세요.

## 보안

- 토큰은 **관리자 권한**입니다. 서버는 Tailscale이나 HTTPS로만 접근하고, 공용 인터넷에 그대로 노출하지 마세요.
- API 키는 서버 DB에 **암호화 없이** 저장됩니다.
- 파일 도구는 작업 폴더 밖도 읽을 수 있고 `bash`는 **샌드박스가 아닙니다**. 정책은 `ask`로 두고 Docker나 VM에서 실행하세요.

취약점은 공개하지 말고 [SECURITY.md](SECURITY.md)에 따라 비공개로 제보하세요.

## 개발

```bash
cd server && bun install && bun run dev          # API 서버
cd client && bun install && bun run dev          # 웹 클라이언트 (포트 1420)
```

커밋 전 검증:

```bash
cd server && bun run typecheck && bun run lint && bun run test
cd client && bun run check && bun run test && bun run build
```

필요한 도구 버전은 [`mise.toml`](mise.toml)에 고정돼 있습니다(Bun 1.3, Rust stable). 서버는 [`server/README.ko.md`](server/README.ko.md), 로고는 [`logo/README.md`](logo/README.md)를 보세요. 커밋은 [Conventional Commits](https://www.conventionalcommits.org)를 따릅니다.

## 라이선스

[MIT](LICENSE)
