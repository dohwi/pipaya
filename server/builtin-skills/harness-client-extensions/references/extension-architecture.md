# 확장 구조와 변경 가이드

> 이 문서와 `extensions.md`·`extension-ui.md`·`extension-screen-design.md`는 서버에 **내장 스킬**(`harness-client-extensions`)로 묶여 에이전트에게 제공됩니다. 고친 뒤에는 `cd server && bun scripts/sync-builtin-skills.ts`로 사본을 갱신하세요(서버 테스트가 어긋남을 잡습니다).

클라이언트 확장(SDK v1)이 코드 어디에 있고 어떻게 움직이는지, 기능을 추가할 때 무엇을 함께 고쳐야 하는지 정리합니다. 사용자 관점의 규칙은 [extensions.md](extensions.md), UI 노드는 [extension-ui.md](extension-ui.md), 화면 디자인은 [extension-screen-design.md](extension-screen-design.md)입니다. 서버의 에이전트 도구·모델 확장과는 **별개**입니다.

## 1. 한눈에 보기

```
확장 JSON 패키지 ──parsePackage──▶ ExtensionHost (host.svelte.ts, 싱글턴 `extensions`)
                                      │ enable()
                                      ▼
                         ExtensionRuntime (runtime.ts)
     앱 realm            ┌─────────────────────────────────────────┐
                         │ <iframe sandbox="allow-scripts"> (opaque)│
                         │   └ blob Worker: `sdk` 주입, 코드 실행   │
                         └───────────── MessagePort ───────────────┘
 Worker ─rpc(method,args)─▶ runtime.receive ─▶ host.request()  (권한 검사는 여기서)
 host ─execute(token,arg)─▶ Worker 핸들러 (명령·액션·패널 이벤트)
```

- 확장 코드는 앱 realm에서 **절대** 실행되지 않습니다. 네트워크·DOM·토큰·Tauri API가 없습니다.
- 확장이 화면에 영향을 주는 방법은 **검증된 데이터**(manifest, theme, commands, UI view tree)뿐입니다. 호스트가 신뢰된 컴포넌트로 그립니다.
- 모든 SDK 호출의 권한은 Worker가 아니라 **호스트(`host.request`)에서** 검사합니다.

## 2. 확장점: 무엇이 어디에 나타나나

| 기여 | 만드는 방법 | 화면 위치 | 한도 | 소스 |
|---|---|---|---|---|
| 템플릿 명령 | 패키지 `commands[]` | `/` 슬래시 메뉴 | 20개 | `host.registerCommand`, `lib/commands.ts`(병합) |
| 코드 명령 | `sdk.commands.register` | 같음 | 확장당 20개 | 같음 |
| 입력창 액션 | `sdk.composer.registerAction` | 입력창 아래 버튼 줄 | 10개 | `Composer.svelte` |
| 확장 화면(패널) | `sdk.ui.registerPanel` | 우상단 런처 → 모달 `<dialog>` | 확장당 5개 | `extensions/ExtensionPanels.svelte` |
| 입력창 위젯 | 패널 `placement:'composer'` | 입력창 위 접이식 박스 | (패널 5개에 포함) | `ExtensionPanels placement="composer"` |
| 헤더 항목 | `sdk.navbar.set` | 헤더 우측 슬롯 | 3개, 비대화형 노드만 | `extensions/NavbarUsage.svelte`, `Header.svelte` |
| 상태 칩 | `sdk.status.set` | 입력창 아래 `StatusLine` | 10개, 120자 | `StatusLine.svelte` |
| 테마 | 패키지 `theme` | `:root` CSS 변수 | 토큰 화이트리스트 | `host.applyThemes` |
| 알림 | `sdk.notifications.show` | 토스트 | 10초에 5개, 300자 | `Toasts`(`HostAdapter.notify`) |
| 시스템 알림 | `sdk.notifications.send/status/register/remove` | OS·FCM/APNs 어댑터 | 별도 `system-notifications` 권한, 서버 규칙 5개 | [알림 구조](notifications.md), `notifications.ts`, `notification-rules.ts`, `HostAdapter.systemNotifications` |
| 설정 폼 | manifest `settings` | 설정 → 확장 → 행 펼침 → 확장 설정 | 20필드 | `extensions/SettingsForm.svelte` |
| 승인창 | `sdk.configuration.*` | 모달 | 한 번에 하나 | `extensions/ExtensionApproval.svelte`, `store.confirmExtension` |

전역 한도: 확장 50개, 패키지 256KiB, 코드 128KiB, 설정 JSON 16,000자, 확장 저장소 32,000자, 로그 100개.

## 3. 코드 지도

`client/src/lib/extensions/`

| 파일 | 역할 |
|---|---|
| `schema.ts` | `parsePackage`(엄격한 JSON 검증), `PERMISSIONS`, `THEME_TOKENS`, 설정 스키마 `resolveSettings`·`fillSettingDefaults` |
| `ui.ts` | UI 노드 타입·`UI_LIMITS`·`NODE_KEYS`, `parseView`, `parsePanelSpec`, `validateUIEvent`, `findNode`, `fieldsIn` |
| `navbar.ts` | navbar 항목 검증과 한도, 허용 노드(`NAVBAR_NODE_TYPES`) |
| `sdk.ts` | 확장 작성자에게 공개하는 타입(`ExtensionSDK` 등) |
| `runtime.ts` | 샌드박스 iframe + Worker 소스(문자열), heartbeat, 메시지·시간 제한 |
| `host.svelte.ts` | `ExtensionHost`: 설치·활성화·정리, 설정 동기화, `request()` 디스패처(SDK 메서드 ↔ 권한), 패널·navbar·상태 상태값 |
| `http.ts` / `transport.ts` | `http`(GET JSON) / `http-write`(JSON 읽기·쓰기) |
| `configuration.ts` / `fingerprint.ts` | 설정 내보내기·가져오기·백업·승인, 정규화 JSON과 SHA-256 |

`client/src/components/`

| 파일 | 역할 |
|---|---|
| `Extensions.svelte` | 설정 → 확장 탭: 목록, 가져오기 미리보기·결과 모달, 삭제 확인, 안전 모드 |
| `extensions/ExtensionPanels.svelte` | 런처, 패널 모달(레일·본문), 입력창 위젯 |
| `extensions/ExtensionSurface.svelte` | 패널 하나의 draft 값, 이벤트 큐(최대 20), 오류 표시 |
| `extensions/ExtensionView.svelte` | UI 노드 재귀 렌더러 + 검증·포커스·오류 처리 |
| `extensions/ExtensionGauge.svelte`, `ExtensionIcon.svelte` | 게이지(+상세 팝오버), 벡터 아이콘 |
| `extensions/SettingsForm.svelte` | 설정 스키마 폼 + JSON 직접 편집 |

앱에 끼워 넣는 지점: `App.svelte`(`extensions.init(adapter)`, 런처 배치, `<ExtensionApproval/>`), `Header.svelte`, `Composer.svelte`, `StatusLine.svelte`, `lib/commands.ts`(명령 병합), `lib/store.svelte.ts`(`extensions.emit` 이벤트 전달, `applyThemes`, `confirmExtension`), `Settings.svelte`(탭), `Backup.svelte`, `lib/api.ts`(서버 설정 API).

서버: `server/src/extension-settings.ts`(저장소), `extension-settings-routes.ts`(라우트), `schemas.ts`·`app.ts`(등록). 확장 ID 규칙은 클라이언트 `schema.ts`의 `ID`와 서버 `EXTENSION_ID_PATTERN` 두 곳에 있으니 **함께** 바꿉니다(서버 테스트가 비교).

테스트: `client/tests/extensions-*.test.ts`(schema, ui, ui-host, host, settings, generic, configuration, fingerprint, transport), `server/test/extension-settings.test.ts`.

## 4. 수명주기

1. `install(pkg, scope)`: `parsePackage` → `installed`에 **비활성**으로 추가. `scope`는 `"server"`(기본, 열린 서버의 목록) 또는 `"device"`(이 기기 전용). 서버 목록 동기화(`packages()`/`applyPackages`)와 서버 전환(`switchServer`)은 `server` 확장만 다루고 기기 확장은 건드리지 않습니다. 같은 ID가 둘 다 있으면 기기 확장이 남습니다(같은 ID면 교체하고 `disable`). 설정 스키마가 있으면 기본값을 채우고 새 설치는 `configured=false`.
2. `enable(id)`: 안전 모드·`configRequired`·`settingsProblem` 확인 → `markBooting`(새로고침 도중 중단 감지) → `start`.
3. `start(id)`: `cleanup` → generation 증가 → 템플릿 명령 등록 → 코드가 있으면 `ExtensionRuntime.start`(5초 제한) → `state:'active'` → 테마 적용. 모든 비동기 단계는 `current()`로 generation을 확인해 **오래된 응답이 새 인스턴스를 오염시키지 않게** 합니다.
4. 실패하면 `failure()`: `enabled=false`, `state:'error'`, 전부 `cleanup`, 토스트로 알림.
5. 시스템 알림 규칙은 앱 종료에도 유지되어야 하므로 일반 `cleanup()`에서는 지우지 않습니다. `disable`·실패·안전 모드·패키지 교체에서 별도로 revoke하고, `notification-rules.ts`가 오프라인 재시도·등록/해제 직렬화를 처리합니다. 네이티브 토큰은 호스트만 다룹니다([알림 구조](notifications.md)).
6. `cleanup(id)`: 명령·액션·상태·패널·navbar·이벤트 구독·HTTP·configuration 승인 작업을 **owner ID 기준으로** 모두 제거합니다. 새 기여 종류를 만들면 여기에 반드시 추가하세요.
6. `disable`/`remove`/`setSafeMode`는 모두 `cleanup`을 거칩니다. 다른 확장은 건드리지 않습니다.

### localStorage 키

| 키 | 내용 |
|---|---|
| `pipaya.extensions.v1.<serverId>` | **서버 확장** 목록(패키지·활성·설정·configured) + 읽을 수 없는 항목 원본. 서버마다 따로이고 서버와 동기화 |
| `pipaya.extensions.device.v1` (+ `.corrupt`) | **기기 확장** 목록. 이 기기에만 있고 서버를 바꿔도 유지, 서버로 올라가지 않음 |
| `pipaya.extensions.safe` / `.booting` / `.kept` / `.v1.corrupt` | 안전 모드, 시작 중 ID, 삭제 때 유지한 설정, 손상 백업 |
| `pipaya.extension.storage.<id>` | `sdk.storage` 데이터 |
| `pipaya.extensions.settings-source` | `local`이면 서버 설정 미러링 중단 |
| `pipaya.extensions.configuration-backup(-at)` / `.background-grant.<id>` | 가져오기 백업, 지속 접근 승인 |

## 5. 서버 API

| 요청 | 용도 |
|---|---|
| `GET /extensions/settings` | 전체 설정 `{settings:{[id]:object}}` |
| `PUT /extensions/:id/settings` | 저장(JSON 16,000자 이내, 최대 100개 확장) |
| `DELETE /extensions/:id` | 설정 삭제 |

저장 위치는 `<dataDir>/extensions/<id>/settings.json`이고, 저장하면 SSE `extension_settings_updated`가 발행됩니다. 클라이언트는 시작 때 3초 제한으로 읽고, 실패하면 localStorage 캐시로 계속 동작합니다.

## 6. "무엇을 고치면 되는가" 체크리스트

각 항목은 **같은 변경 안에서** 테스트와 문서까지 끝냅니다.

**A. 새 SDK 메서드**
1. `sdk.ts` 타입 → `runtime.ts`의 `sdk` 객체(Worker 소스) → `host.svelte.ts` `request()`에 `case` 추가(맨 앞에서 `this.require(id, permission)`, 인자 개수·타입 검증).
2. 등록형이면 `cleanup()`에 해제 추가, 한도를 상수로 두고 초과 시 명확한 오류.
3. 큰 페이로드가 필요하면 `runtime.ts`의 요청 크기 제한 예외 목록을 확인(기본 70,000바이트).
4. `extensions-host.test.ts`(권한 거부, 인자 오류, 정리) + `extensions.md` 권한 표.

**B. 새 권한**
1. `schema.ts`의 `PERMISSIONS` → `Extensions.svelte`의 `permissionLabels`(타입이 강제함, 사용자에게 보이는 승인 문구) → 테스트 → `extensions.md`.
2. 기존 권한의 의미를 **묵시적으로 넓히지 마세요.** 새 능력은 새 권한 + 승인 문구입니다.
3. 새 권한을 아는 패키지가 옛 클라이언트에서는 `unreadable`로 보관됩니다(삭제되지 않음). 이 호환성을 깨지 마세요.

**C. 새 UI 노드**
1. `ui.ts`: 인터페이스, `UINode` 유니온, `NODE_KEYS`, `parseNode`의 `case`(모든 문자열에 길이 상한), 필요하면 `UI_LIMITS`.
2. `ExtensionView.svelte`: 렌더 분기와 스타일(토큰만 사용, 임의 CSS 금지). 대화형이면 `validateUIEvent`와 이벤트 타입도 확장.
3. 비대화형이고 헤더에 둘 수 있으면 `navbar.ts`의 `NAVBAR_NODE_TYPES`에 추가할지 결정.
4. `extensions-ui.test.ts`(유효·무효·한도·ID 중복) + `extension-ui.md` 컴포넌트 표 + [screen-design §4](extension-screen-design.md#4-컴포넌트별-규격).

**D. 새 기여 종류**(navbar 같은 새 표시 위치)
host 상태(`$state.raw`) + `cleanup()` + 검증기와 한도 + 렌더 컴포넌트 + 앱 배치 + 권한 + [§2 표](#2-확장점-무엇이-어디에-나타나나)와 screen-design §1 갱신.

**E. 새 manifest·패키지 필드**
`parsePackage`의 허용 키 목록(모르는 필드는 거부)과 타입 → 설정 내보내기(`configuration.ts`의 공개 범위) → 같은 ID 교체 동작 확인 → `extensions.md`.

**F. 설정 화면(`Extensions.svelte`) 변경**
안전 모드와 읽을 수 없는 항목 카드는 복구 경로입니다. 어떤 변경에도 계속 접근 가능해야 합니다. QA 스크립트 셀렉터도 함께 점검하세요([§8](#8-검증)).

### 지켜야 할 불변 규칙

1. **데이터만 받는다**: HTML, CSS, URL, 함수, 클래스 이름, 이벤트 속성을 확장에서 받지 않습니다.
2. **호스트에서 검증한다**: Worker의 입력은 항상 신뢰하지 않습니다. 새 필드는 엄격 검증(알 수 없는 키 거부, 길이·개수 상한, 새 객체로 복사)을 거칩니다.
3. **권한은 호스트에서 확인한다**, 승인 문구는 사용자에게 무엇이 가능한지 그대로 말합니다.
4. **다른 확장을 자동으로 끄거나 건드리지 않는다.** 재설치는 비활성으로 시작하고 사용자가 다시 켭니다(권한이 늘지 않은 같은 ID 교체의 즉시 재실행 예외만 존재).
5. **자격 증명은 확장에 주지 않는다**: 서버 토큰, 앱 localStorage, 대화 원문, 도구 인자·결과.
6. **복구 경로를 막지 않는다**: 안전 모드, `?extensions=off`, 시작 중단 감지, 읽을 수 없는 항목 보관.
7. **사용자 문구는 한국어**이고 확장이 앱의 승인창을 흉내 낼 수 없도록 출처(확장 이름)를 앱이 표시합니다.

## 7. 알려진 문제

2026-10-13에 확인했고, 아래 3개는 같은 날 고쳤습니다.

| # | 문제 | 상태 |
|---|---|---|
| 1 | 서버 확장 ID 규칙이 클라이언트보다 좁았음(`sync` 같은 한 단어 ID 저장 거부) | **수정**: 서버 `EXTENSION_ID_PATTERN`을 클라이언트와 같게(`*`) 하고 예약어(`constructor`, `prototype`)도 거부. `server/test/extension-settings.test.ts`가 두 검증기를 같은 입력으로 비교해 어긋나면 실패 |
| 2 | 게이지 상세 팝오버가 확장 화면(모달) 안에서 가려짐 | **수정**: `ExtensionGauge`가 팝오버를 가장 가까운 `<dialog>`에 붙임(없으면 `<body>`). 1280·390에서 호버·포커스·Esc 확인 |
| 3 | QA 스크립트 셀렉터가 낡음 | **수정**: 스위치(`role="switch"`, 이름 `<확장 이름> 사용`), 가져오기 결과 모달 닫기, "고급" 접이식, 확장 로그(`extensions.logs`)에 맞춤. 두 스크립트 모두 PASS |
| 4 | 라이트 테마에서 톤 색 글자 대비 부족 | 미수정. 톤 글자색 on 자기 tint: info 3.44 / ok 2.91 / warn 3.53 / danger 4.22 (AA 4.5 미만). 다크는 4.9 이상. [screen-design §8](extension-screen-design.md#8-현재-구현-리뷰-2026-10-13) |
| 5 | `Extensions.svelte`의 `stateLabels`·`stateTone`은 정의만 있고 쓰이지 않음 | 미수정(죽은 코드) |
| 6 | `ExtensionApproval.svelte`가 앱의 다른 모달과 모양이 다를 가능성 | 미수정. 코드 검토만(화면 미확인): 알약 `.btn` 대신 일반 버튼, `--scrim` 대신 `#0008`, 모션 없음 |

## 8. 검증

```sh
cd client
bun run check          # svelte-check (작성 시점 0 errors, 0 warnings)
bun test tests         # 확장 관련 9개 파일 226 pass
bun run build
cd ../server && bun test test/extension-settings.test.ts   # 12 pass
```

브라우저 QA(격리·관리·입력창·heartbeat)는 [extensions.md 검증](extensions.md#검증)을 따릅니다. 설정 화면의 구조(스위치, 결과 모달, 고급 접이식, 탭)를 바꾸면 `scripts/check-extension*.cjs` 셀렉터도 같이 고치세요. 화면을 바꿨다면 개발 서버(`bun run dev`, `0.0.0.0:1420`)에서 데스크톱(1280)·모바일(390)·라이트·다크 네 조합을 직접 눈으로 확인합니다.
