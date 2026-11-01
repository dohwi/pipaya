# 도우미 위임 (`delegate`)

에이전트가 검색·테스트·큰 로그 읽기 같은 일을 짧게 사는 도우미(하위 에이전트)에게 맡기고 최종 답 텍스트만 받는 도구. 도우미가 읽은 내용은 부모 컨텍스트에 쌓이지 않는다.

## 역할 정의 (`server/src/subagents.ts`)

- 위치: `~/.agents/subagents/*.md`(전역), `<세션 cwd>/.agents/subagents/*.md`(프로젝트, 같은 이름이면 프로젝트가 이긴다). 호출마다 다시 읽는다.
- 파일 이름(`.md` 제외)이 역할 이름. frontmatter: `description`, `model`(`provider/model`, 생략 = 부모 모델), `thinking`(생략 = off), `tools`(생략 = read·grep·ls), `maxTurns`(생략 12, 상한 30). 본문 = 도우미 시스템 프롬프트.
- `delegate`·`ask_user`·`peer`는 `tools`에 적어도 도우미에게 주지 않는다(깊이 1, 사용자·다른 세션 접근 없음). 설정에서 끈 도구도 제외.

## 도구 (`server/src/tools.ts`, `SessionManager.delegate`)

- 인자: `role`, `task`, 선택 `model`. 도우미는 부모 대화를 보지 못하므로 `task`에 목표·경로·질문·답 형식을 다 적는다.
- 저장되지 않는 임시 Agent로 돈다: 세션 목록에 나타나지 않고, 부모에는 진행 줄(`role: 도구`)과 최종 텍스트만 남는다. 지속 대화는 `peer`(action create).
- 서버 확장의 `tool_call`/`tool_result` 훅이 도우미에게도 적용된다.
- 도우미의 토큰·비용은 `delegate` 결과의 `details.usage`에 저장되어 부모 세션 합계(`SessionStore.usage`)에 더해진다.

## 제한 (코어에서 강제, 초과는 409 conflict)

| 항목 | 기본 | 설정 |
| --- | --- | --- |
| 동시 도우미 | 4 | 1–8 |
| 실행(run)당 호출 | 12 | 1–50 |
| 도우미 모델 호출 | 역할 파일 값, 상한 30 | 1–50 (역할 파일 값을 이 값으로 자른다) |

`maxTurns`에 닿으면 중단하고 "불완전할 수 있음"을 붙여 반환한다. 부모를 중단하면 도우미도 중단된다. 모르는 역할·모델은 사유와 선택지를 에러로 알린다.

## 모델 정책 (설정 > 서버 > 에이전트 > 도우미 위임)

- 정의된 모델만(기본): 역할 파일의 `model`만. `model` 인자는 거절.
- 허용 목록: 켠 모델 안에서만 `model` 인자 허용.
- 자유: 연결된 모델 아무거나.
- 저장: `settings.delegate_policy`, API `PUT /configuration/delegate`, 조회는 `GET /configuration`의 `tools.delegate`.
- 도구 스위치(`delegate`)로 기능 전체를 끌 수 있다(`TOGGLEABLE_TOOLS`).
