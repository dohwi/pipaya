# 서브에이전트 위임 (`delegate`)

에이전트가 검색·테스트·큰 로그 읽기 같은 일을 짧게 사는 서브에이전트에게 맡기고 최종 답 텍스트만 받는 도구. 서브에이전트가 읽은 내용은 부모 컨텍스트에 쌓이지 않는다.

## 역할 정의 (`server/src/subagents.ts`)

- 위치: `~/.agents/subagents/*.md`(전역), `<세션 cwd>/.agents/subagents/*.md`(프로젝트, 같은 이름이면 프로젝트가 이긴다). 호출마다 다시 읽는다. 설정 > 에이전트 도구 > 서브에이전트 역할에서 목록·추가·수정·삭제할 수 있다(`GET/POST /configuration/subagents`, `PUT/DELETE /configuration/subagents/:name`; 프로젝트 범위는 `cwd` 쿼리(없으면 서버 기본 작업 폴더)의 `.agents/subagents`에 쓴다. 역할마다 스위치로 끌 수 있고(`PUT /configuration/subagents/:name/enabled`, 키 `scope/name`을 `settings.disabled_subagents`에 저장) 끈 역할은 `delegate`가 없는 역할처럼 거절한다. 같은 이름의 프로젝트 역할을 끄면 전역 역할이 다시 보인다. 대화창 하단 푸터의 "서브에이전트 역할" 항목은 그 대화 폴더의 `cwd`로 연다. frontmatter의 모르는 키는 수정해도 보존).
- 파일 이름(`.md` 제외)이 역할 이름. frontmatter: `description`, `model`(`provider/model`, 생략 = 부모 모델), `thinking`(생략 = off), `tools`(생략 = read·grep·ls), `maxTurns`(생략 12, 상한 30). 본문 = 서브에이전트 시스템 프롬프트.
- `delegate`·`ask_user`·`peer`·`schedule`은 `tools`에 적어도 서브에이전트에게 주지 않는다(깊이 1, 사용자·다른 세션·예약 접근 없음). 설정에서 끈 도구도 제외.

## 도구 (`server/src/tools.ts`, `SessionManager.delegate`)

- 인자: `role`, `task`, 선택 `model`. 서브에이전트는 부모 대화를 보지 못하므로 `task`에 목표·경로·질문·답 형식을 다 적는다.
- 저장되지 않는 임시 Agent로 돈다: 세션 목록에 나타나지 않고, 부모에는 진행 줄(`role: 도구`)과 최종 텍스트만 남는다. 지속 대화는 `peer`(action create).
- 서버 확장의 `tool_call`/`tool_result` 훅이 서브에이전트에게도 적용된다.
- 서브에이전트의 토큰·비용은 `delegate` 결과의 `details.usage`에 저장되어 부모 세션 합계(`SessionStore.usage`)에 더해진다.

## 제한 (코어에서 강제, 초과는 409 conflict)

| 항목 | 기본 | 설정 |
| --- | --- | --- |
| 동시 서브에이전트 | 4 | 1–8 |
| 실행(run)당 호출 | 12 | 1–50 |
| 서브에이전트 모델 호출 | 역할 파일 값, 상한 30 | 1–50 (역할 파일 값을 이 값으로 자른다) |

`maxTurns`에 닿으면 중단하고 "불완전할 수 있음"을 붙여 반환한다. 부모를 중단하면 서브에이전트도 중단된다. 모르는 역할·모델은 사유와 선택지를 에러로 알린다.

## 역할 정책 (설정 > 서버 > 에이전트 > 서브에이전트 위임)

- 정의된 역할만(기본): `role`은 `~/.agents/subagents` 또는 프로젝트 `.agents/subagents`의 역할 파일 이름이어야 한다. 없는 이름은 거절.
- 자유: 파일이 없는 이름도 받는다. 그 서브에이전트는 읽기 전용 도구(read, grep, ls), 기본 모델 호출 수, 지침 없음이며 `task`가 곧 지침이다. 모델은 모델 정책을 따른다. 쓰기·bash·위임·질문·peer 도구는 주지 않는다. 같은 이름의 역할 파일이 꺼져 있으면 자유 모드로도 쓸 수 없다.
- 저장: `settings.delegate_policy.roles`. 필드가 없던 기존 설정은 `defined`로 읽힌다(하위 호환). `PUT /configuration/delegate`에서 `roles`를 생략하면 저장된 값을 유지한다.

## 모델 정책 (설정 > 서버 > 에이전트 > 서브에이전트 위임)

- 정의된 모델만(기본): 역할 파일의 `model`만. `model` 인자는 거절.
- 허용 목록: 켠 모델 안에서만 `model` 인자 허용.
- 자유: 연결된 모델 아무거나.
- 저장: `settings.delegate_policy`, API `PUT /configuration/delegate`, 조회는 `GET /configuration`의 `tools.delegate`.
- 도구 스위치(`delegate`)로 기능 전체를 끌 수 있다(`TOGGLEABLE_TOOLS`).

## 그래프 뷰 (`GET /delegates`, `client/src/components/graph/`)

- 사이드바 아래 "그래프 뷰" 또는 `Ctrl+G` / `⌘G`(설정 > 단축키 `openGraph`). 저장된 모든 서버를 서버 → 프로바이더 → 모델 → 대화 → 서브에이전트 역할 순서의 열로 그린다. 분기한 대화는 부모 오른쪽 열에 놓인다.
- `GET /delegates`: 열린 대화들의 `delegate` 도구 호출 한 번이 한 줄(`DelegateRun`). 역할, 역할 파일 없이 부른 것인지(`free`), 에이전트가 고른 모델(`asked`), 실제 모델, 시작·끝 시각, 진행 여부, 실패 여부, 턴·토큰 수가 들어 있다. 클라이언트는 delegate 도구 이벤트가 오면 다시 읽고, 그 밖에는 주기적으로 읽는다. 이 경로가 없는 옛 서버에서는 대화만 그린다.
- 마우스 휠은 확대·축소, 트랙패드는 두 손가락으로 이동하고 핀치로 확대한다. 배경을 끌면 이동한다.
- 대화 카드를 한 번 누르면 빠른 보기 창이 열린다. 데스크톱에서는 너비 최대 1080px(화면의 80%), 높이는 화면의 86%까지 크게 뜨고, 폰에서는 보통 창처럼 화면 90% 높이의 하단 시트로 뜬다. 창에는 최근 메시지, 작업 상자(도구 호출과 결과), 입력창이 있다. 작업 중일 때 Enter는 끼워 넣기(steer), Alt+Enter는 대기열(follow_up)이고, Esc를 누르면 닫힌다. 카드를 두 번 누르면 그 대화로 간다. 옮긴 카드 위치는 이 기기에만 저장되고, "다시 배치"를 누르면 제자리로 돌아간다.
