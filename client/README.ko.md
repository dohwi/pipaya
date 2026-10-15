# pipaya client

[English](README.md) · **한국어** · [프로젝트 README](../README.ko.md)

harness 서버(REST + SSE)용 Svelte 5 + Vite + Tauri 2 채팅 클라이언트.

```bash
cd client && bun install
bun run dev          # http://0.0.0.0:1420 (Tailscale IP로 접속)
bun run check        # svelte-check
bun run build        # dist/에 정적 번들 생성
bun run tauri dev    # 데스크톱. Linux에서는 webkit2gtk-4.1과 빌드 의존성이 필요
bun run tauri android init   # 모바일. Android SDK/NDK를 준비한 뒤 한 번만 실행
```

처음 실행하면 서버 URL과 `~/.pipaya/token`의 토큰을 입력합니다.

## 네이티브 빌드와 다운로드

모든 플랫폼의 다운로드와 체크섬을 검증하는 설치 스크립트는 프로젝트 README의 [클라이언트](../README.ko.md#클라이언트) 절에 있습니다.
`main`에 푸시된 클라이언트 변경은 네 플랫폼을 자동으로 빌드하고, 모든 검증이 성공하면 하나뿐인 `latest` 릴리스의 파일을 교체합니다. 설치된 Windows·macOS 앱은 스스로 업데이트하고, Android는 새 빌드를 알려 줍니다([자세히](docs/releases.md#in-app-updates)).

툴체인, GitHub Secrets, 로컬 빌드 명령, 서버 연결은 [빌드·서명·릴리스 안내](docs/releases.md)를 참고하세요.

## 언어

UI는 **영어와 한국어**로 제공되며 기기 언어를 따릅니다(설정 → 일반 → 언어에서 직접 고르거나 시스템을 따를 수 있습니다). 한국어가 원문입니다: `t("설정")`처럼 한국어 문장이 조회 키이고, `src/lib/locales/en.ts`가 이를 영어로 대응시킵니다. 번역이 없으면 한국어 원문으로 나오므로 빈 칸이 생기지 않습니다.

- 누락 점검: `node scripts/extract-i18n.cjs`가 코드에서 쓰지만 `en.ts`에 없는 문장과, 더 이상 쓰이지 않는 항목을 보여 줍니다(누락이 있으면 종료 코드 1).
- 다른 언어는 언어팩 확장으로 추가합니다([docs/extensions.md](docs/extensions.md) 참고). 팩은 서버를 통해 기기 간에 공유됩니다.
- `docs/` 아래 문서는 한국어로 작성되어 있습니다.

## 모델 연결 (custom only)

서버에는 프로바이더도 모델도 들어 있지 않으므로 모델 목록은 **처음에 비어 있습니다**.
설정 → Models → "연결 추가"에서 연결 이름, 엔드포인트(Base URL), 모델 ID를 하나 이상 직접 입력하고 API 형식(OpenAI Chat Completions, OpenAI Responses, Anthropic Messages)을 고릅니다.
프리셋이나 기본 엔드포인트 목록은 없습니다. 엔드포인트에 키가 필요하면 같은 화면에서 나중에 추가하세요. 키는 이 기기가 아니라 서버에 저장됩니다.
사용할 수 있는 연결이 하나 생기기 전까지는 채팅할 수 없습니다. 연결은 서버별로 저장됩니다.

## 컨텍스트 토큰 최적화 (pi compact)

- 압축은 `/compact [instructions]`로만 실행합니다. `/` 자동완성에서 확인할 수 있으며, footer에는 실행 버튼을 표시하지 않습니다.
- 모든 기본 명령은 `/name` 형식의 단일 영어 이름을 사용합니다. 한국어·중복 별칭은 지원하지 않습니다.
- `/sidebar`, `/model`, `/thinking`, `/help`는 기본 명령에 포함하지 않습니다. 사이드바와 모델·추론 설정은 기존 UI에서 조작합니다.
- 오래된 대화는 요약하고 최근 대화와 원본 기록은 유지합니다. 요약 모델 호출 비용이 발생하며 세부 내용이 생략될 수 있습니다.
- 진행 중 메시지 전송/모델 변경을 차단하고, 중지 버튼으로 압축 취소를 요청합니다. 서버의 자동 압축 진행 상태도 표시합니다.
- 현재 컨텍스트와 누적 과금 토큰을 구분합니다. 구버전 서버의 추정치는 `~`, 압축 직후 미측정 사용량은 `—`로 표시합니다.
- **BE 연동 필요:** 현재 서버는 저수준 `pi-agent-core`를 사용하므로 이 FE 작업만으로 실제 토큰이 감소하지 않습니다. [BE 구현 요청과 REST/SSE 계약](docs/compaction-backend.md)을 구현해야 합니다. 미지원 서버에는 안내를 표시합니다.

검증: `bun run test` (REST 계약 및 실제 Svelte rune 상태 모듈 테스트), `bun run check`, `bun run build`.

## Motion

Material 프로필을 따릅니다. 수치는 `src/app.css`의 `:root` 토큰 한 곳에서 정하고, `src/lib/motion.ts`의 Svelte 전환이 같은 토큰을 읽어 CSS와 JS 모션이 어긋나지 않습니다.

- **시간·이징**: 등장은 `--motion-normal`(360ms)과 `--ease`(감속), 퇴장은 `--motion-fast`(180ms)와 `--ease-exit`(가속)입니다. 퇴장은 등장보다 이동·축소 폭이 작습니다.
- **Dialog**: 위로 18px, scale .94에서 시작해 중앙에 안착하고, 퇴장은 8px, .96입니다. 전화 폭(640px 이하)에서는 아래에서 올라오는 시트입니다. Settings는 당겨 내린 위치에서 이어서 내려갑니다.
- **큰 부유 면**(Palette, 모델 선택, 슬래시 메뉴, 토스트): 이동과 페이드만 쓰고 scale은 쓰지 않습니다.
- **네이티브 `<dialog>`**(Skills, 세션 컨텍스트, 확장 화면): `::backdrop`은 자식이 아니라서 `dialog[data-closing]`으로 퇴장을 CSS가 그립니다. `holdClosing`과 `closeAnimated`가 퇴장이 끝날 때까지 닫기를 미룹니다.
- **버튼**: 눌림은 `.btn` .94, `.iconbtn` .88로 제자리에서 줄어들고, `lib/ripple.ts`가 `.btn`과 `.iconbtn`에 Material 리플을 위임 방식으로 붙입니다.
- **선택 표시 이동**: 선택 표시는 마커 하나가 Tabs처럼 다음 항목으로 미끄러져 이동합니다(`lib/sliding-indicator.ts`). 사이드바 목록·접힌 레일, 설정과 서버 설정의 탭 밑줄, 테마·도구 승인 카드, Skills 범위 토글, 추론 강도(레벨 색 따라감), 그룹 칩, 확장 화면 탭이 같은 액션을 씁니다. 다른 항목으로 바뀔 때만 슬라이드하고 첫 배치나 레이아웃 변화는 즉시 따라갑니다. 테마 전환 중에도 마커 이동만은 유지됩니다. 탭 아래 내용은 탭이 이동한 방향에서 살짝 밀려 들어오고, 탭과 라디오 묶음은 ←/→/Home/End로 이동합니다(`lib/roving.ts`).
- **테마 전환**: `.theme-switching` 동안 모든 transition을 끄므로 색은 한 프레임에 함께 바뀝니다. 새 transition을 추가할 때는 하드코딩 대신 `--motion-*`와 `--ease*` 토큰을 쓰세요.
- **접근성**: `prefers-reduced-motion`에서는 `ms()`가 0을 돌려주고 리플은 숨겨지며 전역 규칙이 나머지 애니메이션을 끕니다.

## Layout

- `src/lib/store.svelte.ts`: 연결, 세션, SSE 동기화와 재연결, 명령
- `src/lib/chat.svelte.ts`: REST 기록과 SSE 이벤트를 하나의 대화로 합침
- `src/lib/api.ts`: 타입이 있는 REST 클라이언트와 EventSource 구독
- `src/lib/i18n.ts`, `src/lib/locales/`: UI 언어, 영어 사전, 언어팩
- `src/components/`: Sidebar, Header, MessageList, Message, ToolCard(승인), Composer, ModelPicker, Settings
