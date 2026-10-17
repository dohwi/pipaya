클라이언트 확장은 앱 안에서 **격리된 Worker로 실행되는 코드**입니다. 화면 패널, 상태 항목, 설정 폼, 테마, 언어팩, `/명령`을 추가합니다. 확장은 **검증된 데이터만** 보낼 수 있고, 화면은 앱이 직접 그립니다.

## 서버 확장과의 차이

| | 클라이언트 확장 | [[server-extensions]] |
|---|---|---|
| 실행 위치 | 앱 안의 **격리된 Worker** | 서버 프로세스 (전체 권한) |
| 하는 일 | 화면·테마·언어팩·입력창·알림 | 도구, 훅, 서버 명령, 프로바이더 |
| 권한 | 패키지가 **선언한 권한만** | 전체 |
| 설치 | 앱의 **설정 → 확장**에서 JSON 패키지 가져오기 | 서버의 `extensions/` 폴더에 파일 |
| 서로 연결 | `server` 권한으로 서버 확장 메서드 호출 | `pi.emit`·`registerMethod`로 노출 |

## 격리 방식

확장 코드는 앱의 실행 환경에서 **절대 실행되지 않습니다.**

- 출처가 없는(opaque origin) 프레임이 Worker를 소유하고, 그 Worker 안에서만 코드가 돕니다.
- 프레임의 CSP는 **네트워크, 이미지, 스타일, 프레임, 폼 제출을 모두 막습니다.** (`connect-src 'none'`, `default-src 'none'`)
- Worker와 앱은 **전용 MessagePort 하나**로만 통신하며, 앱이 모든 요청을 **권한 검사**한 뒤 처리합니다.
- CSP가 적용되지 않는 WebView에서는 샌드박스 검사가 실패해 **확장이 시작되지 않습니다**(fail closed).
- SDK 요청은 5초 안에 응답이 없으면 실패하고, 한 번에 걸어 둘 수 있는 요청은 100개까지입니다.
- 확장이 보낸 **HTML·CSS·URL·함수·이벤트 속성은 받지 않습니다.** 화면은 정해진 노드 종류의 데이터로만 표현합니다.

> [!WARNING]
> 확장 코드는 격리된 환경에서 실행되지만 **안전성을 보증하지 않습니다.** CPU·메모리 같은 자원 사용 제한은 보장되지 않으므로 신뢰하는 확장만 설치하세요.

## 설치와 관리

**설정 → 확장** 화면에서 합니다.

| 동작 | 설명 |
|---|---|
| 확장 추가 | JSON 패키지 파일을 가져옴. **최대 256KB** |
| 권한 확인 | 가져오기 전에 요청한 권한이 목록으로 보이고, 승인해야 설치됨 |
| 켜기·끄기 | 설치해도 켜기 전에는 실행되지 않음 |
| 교체·업데이트 | 같은 `id`의 패키지를 다시 가져오면 교체(권한이 늘면 다시 확인) |
| 내보내기 | 패키지만 포함. 개인 설정과 확장 저장 데이터는 제외 |
| 삭제 | 확장과 그 저장 데이터를 지움 |
| 설정 | 확장이 선언한 설정 폼. 또는 JSON 객체(최대 16KB)로 직접 편집 |

### 저장 위치

- 패키지는 **이 기기**(localStorage)에 설치되며, 서버에 묶인 클라이언트 설정 `extensions`로도 동기화됩니다(최대 13,500,000자).
- 확장의 설정은 `settingsScope`에 따라 이 기기(`local`) 또는 서버(`server`)에 저장됩니다. 서버 설정은 `PUT /extensions/:id/settings` JSON 객체(최대 16,000자)입니다.
- 확장의 자체 저장소(`sdk.storage`)는 **확장당 32KB**입니다.
- 설정·저장소의 비밀값(`secret` 필드)은 내보내기에서 빠집니다.

### 복구 장치

- **안전 모드**: 앱 주소에 `?extensions=off`를 붙이거나 설정 → 확장에서 안전 모드를 켜면 **모든 확장의 실행이 중지**됩니다. 해제한 뒤에는 각 확장을 직접 다시 켜야 합니다.
- 앱이 확장을 시작하다 중단된 흔적(부팅 중 표시)을 감지하면 해당 확장을 자동으로 켜지 않습니다.
- 읽을 수 없는 항목은 별도 카드로 보여 주어 지울 수 있게 합니다.
- 한 확장이 실패하거나 교체돼도 **다른 확장은 건드리지 않습니다.**
- 앱은 확장 화면마다 **누가 제공하는지**를 표시합니다.

## 패키지 형식

패키지는 JSON 객체입니다. 모르는 필드는 거부되고 최대 크기는 256KB입니다. `theme`, `commands`, `locales`, `code` 중 **하나 이상**이 있어야 합니다.

```json
{
  "manifest": {
    "id": "example.focus",
    "name": "Focus · 테마와 리뷰 초안",
    "version": "1.0.0",
    "sdkVersion": 1,
    "description": "차분한 블루 테마와 /review 프롬프트 초안.",
    "permissions": ["commands", "composer"]
  },
  "theme": {
    "dark":  { "--accent": "#93c5fd", "--accent-fg": "#172033", "--radius": "8px" },
    "light": { "--accent": "#2563eb", "--accent-fg": "#ffffff", "--radius": "8px" }
  },
  "commands": [
    { "name": "review", "description": "코드 리뷰 초안 넣기", "template": "현재 변경사항을 리뷰해 주세요.\n특히 확인할 내용: {{args}}" }
  ]
}
```

### manifest

| 필드 | 규칙 |
|---|---|
| `id` | 필수. 소문자로 시작, 소문자·숫자와 `.` `-` 구분, 최대 80자 (`example.focus`) |
| `name` | 필수. 1~80자 |
| `version` | 필수. 숫자 SemVer `x.y.z` (+ 선택 prerelease), 최대 80자 |
| `sdkVersion` | 필수. 현재 `1` |
| `description` | 선택. 최대 2,000자 |
| `permissions` | 필수. 아래 23가지 중 중복 없이 |
| `settingsScope` | 선택. `"local"` 또는 `"server"` |
| `settings` | 선택. 설정 필드 최대 20개 |

### 설정 필드 (`settings`)

| 속성 | 규칙 |
|---|---|
| `key` | 필수. `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`. 확장 안에서 고유 |
| `type` | `string` `number` `boolean` `select` |
| `label` | 필수. 1~60자 |
| `description` / `placeholder` | 선택. 200자 / 80자 |
| `required` | 선택 |
| `secret` | 문자열에만. 기본값을 가질 수 없음. 내보내기에서 제외 |
| `format` | 문자열에만. `"origin"` = 올바른 http/https 출처여야 함 |
| `min` / `max` | 숫자에만. `min <= max` |
| `options` | `select`에 필수. `{value, label}` 2~20개 |
| `default` | 문자열(최대 2,000자) · 숫자 · 불리언 · select의 옵션 값 |

### theme

`dark` / `light`별로 허용된 토큰만 바꿀 수 있습니다(전체 23개). 색은 `#rgb` `#rgba` `#rrggbb` `#rrggbbaa` 16진수, 크기는 정수 `px`여야 합니다.

| 토큰 | 범위 |
|---|---|
| `--content-w` | 480~1200px |
| `--radius*` | 0~32px |
| 색상 토큰 | 16진수 색 |

### commands

| 필드 | 규칙 |
|---|---|
| `name` | `^[a-z][a-z0-9-]{0,39}$` |
| `description` | 최대 500자 |
| `template` | 최대 16,000자. `{{args}}`에 입력한 인자가 들어감 |
| 개수 | 최대 20개 |
| 필요 권한 | `commands`, `composer` |

템플릿 명령은 **입력창을 채우기만 하고 전송하지 않습니다.** 사용자가 확인한 뒤 보냅니다.

### locales

| 필드 | 규칙 |
|---|---|
| 개수 | 팩 최대 5개 |
| `tag` | 언어 태그(`ja`, `pt-br` 등). 최대 35자. `ko`, `en`은 예약어 |
| `name` | 최대 60자 |
| `messages` | 최대 3,000개. 키 1,000자, 값 2,000자 이내. **한국어 원문 → 번역** |
| 필요 권한 | `locales` |

언어팩은 서버(`PUT /locales/:tag`)에 올라가 같은 서버의 다른 기기에서도 쓸 수 있습니다. 한 확장이 소유한 팩을 다른 확장이 덮어쓰면 `409`입니다. 번역이 없는 문장은 한국어 원문으로 나옵니다.

### code

`code`는 `sdk`를 인자로 받는 **비동기 함수 본문**(최대 128KB)입니다. 아래 SDK로 앱과 통신합니다.

```js
await sdk.commands.register({ name: "hello", description: "인사" }, async () => {
  await sdk.composer.setText("안녕하세요!");
});
await sdk.status.set("hello", "준비됨");
```

## 권한

선언한 권한이 있어야 해당 SDK를 쓸 수 있고, 앱이 호출마다 확인합니다. **권한을 몰래 넓히지 않습니다.**

| 권한 | 허용하는 것 |
|---|---|
| `commands` | 슬래시 명령 추가 (`sdk.commands.register`) |
| `composer` | 입력창에 글 채우기, 입력창 버튼 추가 |
| `status` | 상태 항목 표시 (`sdk.status`) |
| `context` | 세션 ID, 모델, 프로바이더, 실행·연결 상태 읽기 |
| `storage` | 확장 전용 저장소 (확장당 32KB) |
| `notifications` | 화면 안 알림(toast) 표시 |
| `events` | 대화·작업 상태 이벤트 구독 (`run_started` `run_finished` `session_*` `compaction_finished` `approval_*` `turn_end` `tool_execution_end`) |
| `ui` | 패널·폼·입력창 위젯 표시와 입력값 수신 |
| `navbar` | 상단에 읽기 전용 항목(게이지·아이콘·텍스트) 표시, 확장당 **3개** |
| `http` | 확장이 설정한 서버 주소로 **GET**해 JSON 읽기 (자격 증명 미전송) |
| `http-write` | `httpOrigin`으로 **POST·PUT·DELETE**, 선택적 `httpToken`을 Bearer로 사용 |
| `configuration` | 앱 승인 후 설정 내보내기·가져오기. 가져온 코드는 자동 실행하지 않음 |
| `configuration-background` | 최초 승인 후 비민감 설정 반복 읽기·자동 적용. 코드 변경은 추가 승인 필요 |
| `system-notifications` | OS·모바일 푸시 알림 보내기, 앱이 닫혀 있어도 이벤트 알림 규칙 등록. **문구가 OS와 푸시 제공자에 전달됨** |
| `locales` | 언어팩 등록 |
| `server` | 서버 확장 메서드 호출, 그 확장이 남긴 기록·이벤트 읽기 |
| `shortcuts` | `Ctrl/⌘` 또는 `Alt`가 들어간 단축키 추가. **앱의 기본 단축키는 못 바꿈**, 확장당 10개, 다른 확장과 겹치면 거부 |
| `dialogs` | 확인·선택·입력 창으로 사용자에게 묻기 |
| `session` | 열린 대화에 메시지 보내기·실행 중지. **10초에 5회** 제한. 보낸 메시지는 에이전트가 실행함 |
| `tools` | 도구 호출 결과를 확장이 만든 화면으로 대신 표시. 결과 내용을 읽음 |
| `messages` | 서버 확장이 남긴 기록을 대화 중간에 카드로 표시. 기록을 읽음 |
| `slots` | 헤더 아래(`header`)와 입력창 위(`footer`)에 읽기 전용 항목 표시, 확장당 **2개** |
| `composer-filter` | 보내기 전 메시지를 읽고 바꾸거나 전송 막기. **2초** 안에 응답해야 함. 입력 내용이 확장 코드에 전달됨 |

> [!NOTE]
> 알림 관련 SDK(`sdk.notifications.send`, `status`, `register`, `remove`)와 알림 규칙의 동작은 [[notifications]]를 보세요. `system-notifications`는 사용자가 의식하지 못하는 사이에 알림을 낼 수 있어 승인 화면에서 별도 경고가 나옵니다.

## SDK 한눈에 보기

모든 호출은 `await`로 기다립니다. 인자는 호스트가 검증하며 잘못된 값은 거부됩니다.

| 영역 | 메서드 |
|---|---|
| `sdk.commands` | `register(spec, handler)` |
| `sdk.composer` | `setText(text)`, `registerAction(spec, handler)` |
| `sdk.ui` | `registerPanel(spec, handler)`, `update(id, view, {tone?})`, `open(id)`, `close(id)`, `remove(id)` |
| `sdk.navbar` | `set(id, {label, view})`, `remove(id)` |
| `sdk.slots` | `set(slot, id, spec)`, `remove(slot, id)` |
| `sdk.status` | `set(id, text)`, `remove(id)` |
| `sdk.context` | `get()` → `{sessionId, model, provider, running, online}` |
| `sdk.storage` | `get(key)`, `set(key, value)` |
| `sdk.settings` | `get()` — 확장 자신의 설정 |
| `sdk.notifications` | `show(text)`, `send(spec)`, `status()`, `register(id, rule)`, `remove(id)` |
| `sdk.events` | `on(listener)` → 해제 함수 |
| `sdk.http` | `getJson(path)`, `requestJson(request)` |
| `sdk.configuration` | 설정 내보내기·가져오기·복원 |
| `sdk.server` | `call(확장, 메서드, params?, sessionId?)`, `entries(options?)`, `list()`, `on(listener)` |
| `sdk.shortcuts` | `register(spec, handler)`, `remove(id)` |
| `sdk.dialog` | `confirm(spec)`, `select(spec)`, `input(spec)` |
| `sdk.session` | `send(text, mode?)`, `abort()` |
| `sdk.tools` | `registerRenderer(toolName, fn)`, `removeRenderer(toolName)` |
| `sdk.messages` | `registerRenderer(entryType, fn)`, `removeRenderer(entryType)` |
| `sdk.composerFilter` | `set(fn)`, `clear()` |
| `sdk.log(...)` | 로그 |

## 화면 만들기 (선언형 UI)

확장은 화면을 **JSON 노드 트리**로 설명합니다. 앱이 각 노드를 자기 컴포넌트로 그리므로 HTML·CSS·URL은 쓸 수 없습니다. 노드 종류:

| 구분 | 노드 |
|---|---|
| 배치 | `stack`(수직·수평, 간격), `grid`(1~3열), `card`, `tabs`(최대 8개), `divider` |
| 표시 | `text`(tone·크기), `badge`, `alert`, `code`, `stat`, `progress`, `gauge`, `icon`, `table`, `list` |
| 입력 | `form`, `input`(text·email·number), `textarea`, `select`, `checkbox`, `button`(primary·secondary·danger) |

톤은 `neutral` `info` `success` `warning` `danger`입니다. 입력 값은 사용자가 폼을 제출할 때 핸들러가 이벤트로 받습니다.

주요 길이 한도(코드 상수): 라벨 120자, 제목 80자, 설명 500자, 텍스트 8,000자, 코드 16,000자, 표 셀 2,000자, 입력값 16,000자, 선택 값 200자, 목록 100개.

### 상단 항목(navbar)과 슬롯

| 항목 | 한도 |
|---|---|
| navbar 항목 | 확장당 3개, 라벨 40자, 노드 60개, 깊이 4, 크기 32KB |
| navbar에서 허용되는 노드 | 읽기 전용만: `stack` `grid` `text` `badge` `divider` `progress` `stat` `gauge` `icon` (버튼·폼·표·목록·코드·알림은 거부) |
| 슬롯 | `header`(헤더 아래), `footer`(입력창 위). 확장당 2개 |
| 입력창 위젯 | 패널의 `placement: "composer"` |

### 게이지

`gauge`는 사용량 표시에 쓰는 링 게이지입니다. 링은 최대 3개, 표시 문구 16자, 호버·포커스 때 열리는 상세 행은 최대 12개(라벨 48자, 설명 80자, 그룹 40자)입니다. `value: null`은 **알 수 없음**이며 0으로 그리지 않고, 마지막 갱신 시각을 "N초 전 업데이트됨"으로 보여 줍니다.

## 예제

저장소의 `client/examples/extensions/`에 있습니다.

| 파일 | 내용 | 권한 |
|---|---|---|
| `focus.json` | 파란 테마 + `/review` 프롬프트 초안 | `commands` `composer` |
| `lang-ja.json` | 일본어 언어팩 | `locales` |
| `session-tools.json` | 대화 도구 모음 | `commands` `composer` `status` `context` `storage` `events` `notifications` |
| `todo-view.json` | 서버 확장 `todo`의 화면 | `server` `messages` `slots` `composer-filter` `events` `context` |
| `ui-workbench.*` | UI 노드 모음 | |

서버 확장 `todo.ts`와 `todo-view.json`을 함께 설치하면 서버 확장과 클라이언트 확장이 어떻게 이어지는지 볼 수 있습니다.

## 에이전트에게 맡기기

내장 스킬 `pipaya-client-extensions`에 확장 시스템의 상세 문서(아키텍처, 확장 UI, 화면 설계 원칙, 알림)가 들어 있습니다. 확장을 만들거나 앱의 확장 시스템을 고치게 할 때 에이전트가 이 문서를 먼저 읽습니다.
