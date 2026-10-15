# 세션 컨텍스트와 AGENTS.md

대화 헤더의 **파일 아이콘 → 세션 컨텍스트 보기**에서 서버가 이 세션에 적용한 지침과 파일 읽기 기록을 확인합니다. 새 대화를 실제로 만들기 전에는 아이콘이 표시되지 않습니다.

## 표시하는 정보

- 세션의 작업 디렉터리
- `AGENTS.md`의 절대 경로, 범위(전역 / 상위 디렉터리 / 작업 디렉터리), 적용 순서, 저장된 내용과 바이트 크기
- 지침을 읽거나 적용하지 못한 경우의 경고
- 기본 시스템 프롬프트와 `AGENTS.md`가 포함된 전체 프롬프트
- 활성 도구 목록
- 성공한 `read` 호출에서 읽은 파일 경로, 횟수, 줄 범위, 마지막 읽기 시점

지침과 프롬프트는 접어서 표시하며, 내용은 HTML이나 Markdown으로 실행하지 않는 일반 텍스트입니다. 읽은 파일은 경로로 검색할 수 있습니다. 패널이 열려 있을 때 대화 진행에 따라 갱신하며 수동 새로고침도 지원합니다.

## 지침 적용 시점

첫 실행 전 조회는 **적용 전 미리보기**입니다. 조회만으로 지침을 고정하지 않습니다.

첫 모델 실행 시 서버가 지침을 저장하고 실제 시스템 프롬프트에 포함합니다. 업데이트 전에 생성되어 스냅샷이 없는 기존 세션은 다음 모델 실행 시 저장합니다. 과거 호출에 소급 적용되지는 않습니다. 이후 **적용된 스냅샷**은 파일의 현재 내용이 아니라 이 세션에 저장된 내용입니다. 서버 재시작이나 유휴 세션 재로드 시에도 같은 지침을 사용하며, 포크는 원본의 지침 스냅샷을 이어받습니다.

탐색 순서는 다음과 같습니다.

1. 서버 사용자 홈의 `~/.agents/AGENTS.md`
2. 파일시스템 루트부터 작업 디렉터리의 상위 디렉터리까지 각 `AGENTS.md`
3. 작업 디렉터리의 `AGENTS.md`

같은 실제 파일은 한 번만 포함합니다. 빈 파일은 포함하지 않습니다. 하위 폴더를 재귀 탐색하거나 다른 지침 파일 이름을 자동으로 읽지는 않습니다. 지침 크기는 파일당 **64 KiB**, 전체 **256 KiB**로 제한하며, 초과 파일은 부분 적용하지 않고 건너뜁니다. 크기 제한 및 읽기 오류로 누락된 지침은 경고로 표시합니다.

## 읽은 파일 기록의 한계

파일 목록은 **대화 이력의 읽기 추적**이지, 지금 모델 컨텍스트에 남아 있는 파일의 확정 목록이 아닙니다.

- 성공한 `read` 도구 결과만 집계합니다. 실패하거나 거부된 호출은 제외합니다.
- 줄 범위는 도구가 보고한 읽기 범위이며, 전체 파일을 읽었다는 뜻이 아닙니다.
- `bash`, `grep` 등으로 본 파일은 명령이나 출력을 추측해서 추가하지 않습니다.
- 출력의 바이트 제한이나 이후 컨텍스트 압축으로 모델에 실제 전달되거나 남은 내용은 달라질 수 있습니다.

## API

인증된 `GET /sessions/:id/context`가 정보를 반환합니다.

```ts
interface SessionContext {
  cwd: string;
  state: "preview" | "applied";
  capturedAt: number | null;
  systemPrompt: string;
  effectiveSystemPrompt: string;
  instructions: {
    path: string;
    scope: "global" | "ancestor" | "cwd";
    content: string;
    bytes: number;
  }[];
  warnings: { path: string; message: string }[];
  tools: string[];
  readFiles: {
    path: string;
    reads: number;
    lastReadAt: number;
    ranges: { from: number; to: number }[];
  }[];
}
```

이 경로가 없는 구버전 서버에서는 지원 여부를 안내합니다. 클라이언트가 로컬 파일을 대신 읽어 서버에 적용된 것처럼 표시하지 않습니다.

## 검증

```sh
bun test tests/session-context.test.ts
bun run check
bun run build

# 선택적 브라우저 검증: Playwright 설치 경로에 맞게 NODE_PATH 지정
NODE_PATH=/tmp/harness-extension-browser/node_modules \
  node scripts/check-session-context.cjs
```

브라우저 검증은 개발 서버(기본 `http://localhost:1420`)에서 모의 서버 응답을 이용해 적용/미리보기 상태, 일반 텍스트 렌더링, 검색, 오류/재시도, 세션 전환, 키보드 포커스와 모바일 레이아웃을 확인합니다. 실제 모델 지침 주입과 영속성은 서버 테스트로 검증합니다.
