# 클라이언트 문서 지도

`client/`(Svelte 5 + Vite + Tauri 2)를 고치기 전에 읽는 문서 목록입니다. 사실의 원본은 **코드**이고, 문서는 코드를 가리키는 지도입니다. 둘이 다르면 코드를 믿고 문서를 고치세요.

| 문서 | 내용 | 언제 읽나 |
|---|---|---|
| [extension-architecture.md](extension-architecture.md) | 코드 지도, 수명주기, 확장점, "무엇을 고치면 되는가" 체크리스트, 알려진 문제 | 클라이언트에 기능을 추가·수정하기 전 (확장 관련이면 필수) |
| [extensions.md](extensions.md) | 패키지 형식, 권한, SDK v1 메서드, 설정 스키마·동기화, 격리·제한 | 확장 패키지 작성, SDK·권한·manifest 변경 |
| [extension-ui.md](extension-ui.md) | 선언형 UI(FE SDK) 노드, 이벤트, 폼 규칙 | 패널·폼·위젯 작성, UI 노드 추가 |
| [extension-screen-design.md](extension-screen-design.md) | 확장 화면 디자인 규격, 토큰, 상태·반응형·접근성, 현재 구현 리뷰와 개선안 | 확장 화면·설정 화면·위젯의 모양을 바꿀 때 |
| [skills.md](skills.md) | 스킬 창, 위치, 켜기/끄기 | 스킬 기능 |
| [session-context.md](session-context.md) | 세션 컨텍스트(AGENTS.md) 창 | 컨텍스트 표시 |
| [compaction-backend.md](compaction-backend.md) | `/compact` BE 계약 | 컨텍스트 압축 |
| [notifications.md](notifications.md) | OS 알림, Presence 억제, SDK, Android FCM, 추후 iOS/APNs | 시스템 알림·모바일 푸시 |
| [releases.md](releases.md) | 빌드·서명·릴리스 | Windows·Android 빌드 |

## 작업별 읽기 순서

| 하려는 일 | 순서 |
|---|---|
| 새 SDK 메서드·권한 추가 | architecture §6 → extensions.md(권한 표) |
| 새 UI 노드 추가 | architecture §6 → extension-ui.md → screen-design §4 |
| 확장 화면(패널·위젯·navbar) 모양 수정 | screen-design 전체 → architecture §2 |
| 설정 → 확장 관리 화면 수정 | screen-design §2·§4·§8 → extensions.md(설정 저장) |
| 확장 설정 저장·동기화 수정 | extensions.md(설정 저장) → architecture §4·§7(서버) |
| 확장을 새로 만들기(코드 변경 없음) | extensions.md → extension-ui.md → screen-design §7 |

## 에이전트용 내장 스킬

확장 문서 5개(`extension-architecture`, `extensions`, `extension-ui`, `extension-screen-design`, `notifications`)는 서버의 내장 스킬 `harness-client-extensions`(`server/builtin-skills/`)에도 사본으로 들어 있어, 모든 대화의 에이전트가 확장 작업 전에 읽습니다. 이 문서들을 고친 뒤에는 `cd server && bun scripts/sync-builtin-skills.ts`를 실행하세요. 사본이 다르면 서버 테스트가 실패합니다.

## 문서 규칙

- 한국어로 쓰고 타입·식별자·코드는 원문 그대로 둡니다.
- 한도·치수 같은 숫자는 코드에서 읽은 값만 적고, 바꾸면 같은 변경에서 문서도 고칩니다.
- 확인하지 못한 내용은 "미확인"으로 표시합니다.
