# 클라이언트 확장 · SDK v1

> 관련 문서: [구조와 변경 가이드](extension-architecture.md) · [화면 디자인 규격](extension-screen-design.md)

소스 코드를 고치거나 앱을 다시 빌드하지 않고 테마, 프롬프트 명령, 입력창 액션, 상태 항목을 추가합니다. 선언형 패널·폼·표·탭·위젯을 만드는 [Frontend SDK](extension-ui.md)도 제공합니다. 웹과 Tauri 클라이언트에 공통으로 적용됩니다. **서버 안에서 실행되는 확장(에이전트 도구·훅·모델 제공자)과는 별개**이며, 두 가지는 `server` 권한으로 이어집니다. 서버 확장은 `pipaya-server-extensions` 스킬을 보세요.

## 사용하기

1. 설정 → **확장**에서 `.json` 패키지를 가져옵니다.
2. 패키지 정보와 요청 권한을 확인합니다. 가져온 패키지는 **비활성 상태**입니다.
3. 활성화합니다. 명령은 기존 앱처럼 `/review` 형태로 실행합니다.
4. 비활성화하면 해당 확장의 명령·액션·상태·navbar·이벤트 구독·테마가 해제되고 진행 중인 `http` 요청도 취소됩니다.

**다른 확장은 절대 자동으로 비활성화되지 않습니다.** 한 패키지를 가져오거나 교체해도 다른 확장의 활성 상태·실행은 그대로입니다.

같은 ID의 패키지를 다시 가져오면 기존 실행을 중지합니다. 버전이나 권한이 같아도 새 코드는 자동 실행하지 않으며, 다시 활성화해야 합니다. 다른 확장 및 앱 기본 명령과 이름이 충돌하면 활성화에 실패합니다.

패키지와 활성 상태는 이 클라이언트의 `localStorage`에 저장됩니다(클라이언트 설치/브라우저 origin별). 사이트 데이터를 지우면 설치된 패키지도 지워집니다. **확장 설정은 서버가 원본**입니다 — 아래 [설정 저장과 서버 동기화](#설정-저장과-서버-동기화)를 참고하세요. 패키지 내보내기에는 **사용자 설정과 확장 저장소 데이터는 포함되지 않습니다**.

## 패키지 형식

`examples/extensions/focus.json`은 선언형 예제, `examples/extensions/session-tools.json`은 코드 예제입니다. JSON 파일 하나에 manifest와 기능을 담습니다.

```json
{
  "manifest": {
    "id": "my.review",
    "name": "나의 리뷰 도우미",
    "version": "1.0.0",
    "sdkVersion": 1,
    "description": "리뷰 초안을 입력창에 추가합니다",
    "permissions": ["commands", "composer"]
  },
  "commands": [
    {
      "name": "review",
      "description": "코드 리뷰 초안",
      "template": "다음 변경을 리뷰해 주세요.\n{{args}}"
    }
  ]
}
```

- `id`: 소문자 ID (`sync`, `my.review`, `team-session-tools` 등), 최대 80자.
- `version`: `1.0.0`, `1.0.0-beta.1` 등. 원격 자동 업데이트/다운그레이드 정책은 아직 없습니다. 같은 `id`의 파일을 다시 가져오면 그 확장만 교체합니다(아래 **가져오기** 참고).
- `sdkVersion`: 정확히 `1`. 호환되지 않으면 설치를 거부합니다.
- `permissions`: 아래 권한만 허용합니다. 선언형 명령에도 `commands`와 `composer`가 필요합니다.
- 명령 이름: 영문 소문자로 시작, 소문자·숫자·하이픈, 최대 40자.
- 패키지 최대 256KiB, 코드 최대 128KiB (UTF-8). 확장 최대 50개.
- 모르는 필드, 중복 권한/명령, 잘못된 타입은 거부합니다. 패키지 타입은 `src/lib/extensions/schema.ts`, 공개 SDK 타입은 `src/lib/extensions/sdk.ts`에 있습니다.
- JSON의 `code` 문자열은 **비동기 함수 본문**입니다. 외부 모듈 가져오기·npm 의존성은 지원하지 않습니다. `sdk` 변수가 주입됩니다.

### 설정 스키마 (`manifest.settings`)

manifest에 선택 필드 `settings`(최대 20개)를 선언하면 설정 화면이 입력 폼을 자동으로 만들고 값을 검증합니다. 선언하지 않은 확장은 기존처럼 JSON 객체 텍스트 영역을 사용하며 동작이 바뀌지 않습니다.

```json
"settings": [
  { "key": "httpOrigin", "type": "string", "label": "서버 주소", "format": "origin",
    "required": true, "placeholder": "http://localhost:8317", "description": "사용량을 읽을 서버" },
  { "key": "interval", "type": "number", "label": "갱신 간격(초)", "min": 10, "max": 600, "default": 60 },
  { "key": "compact", "type": "boolean", "label": "간단히 표시", "default": false },
  { "key": "mode", "type": "select", "label": "표시 방식", "default": "ring",
    "options": [{ "value": "ring", "label": "원형" }, { "value": "text", "label": "텍스트" }] }
]
```

| 필드 | 설명 |
|---|---|
| `key` | `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`, 확장 안에서 고유 |
| `type` | `string` · `number` · `boolean` · `select` |
| `label` | 필수, 최대 60자 |
| `description` / `placeholder` | 선택, 최대 200자 / 80자. 설명은 입력칸 아래 힌트로 표시 |
| `default` | 선택, `type`과 일치해야 함 (`select`는 옵션 중 하나, `number`는 `min`/`max` 범위 안) |
| `required` | `true`면 값이 없거나(기본값 포함) 비어 있을 때 오류 |
| `secret` | 문자열 전용. password 입력으로 표시하고 configuration 내보내기에서 제외. 기본값 금지 |
| `format` | `string` 전용, `"origin"`: 경로·query·자격 증명이 없는 http(s) origin (`httpOrigin`과 같은 검증) |
| `min` / `max` | `number` 전용 |
| `options` | `select` 전용, `{value(≤60자), label(≤60자)}` 2~20개 |

모르는 필드, 잘못된 키, 중복 키, 타입이 맞지 않는 `default`, 21개 이상의 필드는 패키지 가져오기에서 거부합니다.

값 검증(`resolveSettings(fields, raw)` → `{ values, errors, ok }`)은 **엄격**합니다: 기본값을 채우고 선언하지 않은 키는 버리지만, `"5"`를 숫자로, `"true"`를 불리언으로 바꾸는 식의 묵시적 변환은 하지 않고 오류로 보고합니다(`필수 항목입니다`, `올바른 주소(origin)가 아닙니다`, `최소 10 이상` 등).

동작:

- **같은 ID 업데이트**: 같은 `id`의 JSON을 다시 가져오면 해당 확장만 교체하고 설정은 유지합니다. 교체 전에 **실행 중**이었고 새 버전이 **기존에 없던 권한을 요청하지 않으며** 안전 모드가 아니면, 버튼이 `교체하고 바로 실행`으로 바뀌어 교체 직후 같은 확장을 다시 시작합니다. 새 권한이 추가되었거나 비활성 상태였다면 지금처럼 비활성으로 교체하며 다시 활성화(동의)해야 합니다. 시작에 실패하면 비활성 상태로 남고 오류를 표시합니다. 다른 ID의 확장은 건드리지 않습니다.
- **가져오기**: 기본값이 즉시 채워지므로 새로 설치한 확장도 기본값이 보입니다. 같은 ID로 교체하면 기존 값을 유지하고 새 필드의 기본값만 채웁니다.
- **설정 확인 게이트(`configured`)**: 설정 스키마가 있는 패키지를 **새로** 설치하면(같은 ID의 기존 항목이 없을 때) 사용자가 설정을 명시적으로 저장하기 전까지 활성화할 수 없습니다. 호스트는 `먼저 설정을 저장해야 활성화할 수 있습니다`로 거부하고, **활성화** 버튼은 이 이유와 함께 비활성화되며, **확장 설정**이 자동으로 열립니다. 기본값이 미리 채워져 있으므로 값이 바뀌지 않았어도 **설정 저장**으로 확인할 수 있습니다. 저장(폼 또는 JSON)하면 `configured`가 영구히 `true`가 됩니다. 시작 때도 설정되지 않은 확장은 시작하지 않습니다. 예외: 서버(또는 삭제 때 남긴 로컬 사본)에 이미 해당 ID의 설정이 있으면 처음부터 `true`이고, `configured` 필드가 없는 기존 저장 항목도 `true`로 간주하며, 같은 ID를 교체할 때는 기존 값을 유지합니다. 스키마가 없는 확장은 게이트가 없습니다. 값 자체는 아래 규칙대로 계속 스키마 검증을 받습니다.
- **활성화 차단**: 필수 설정이 비었거나 유효하지 않으면 호스트가 활성화를 거부하고(`필수 설정을 확인하세요 — …`) 상태는 비활성으로 남습니다. 설정 화면의 **활성화** 버튼도 이유 문구와 함께 비활성화됩니다. 앱을 시작할 때 이전에 활성이던 확장이 이 조건에 걸리면 시작하지 않고 같은 사유를 표시합니다.
- **`sdk.settings.get()`**: 스키마가 있으면 기본값이 적용된 검증 결과(선언된 키만)를 반환하고, 없으면 저장된 객체 그대로 반환합니다. `sdk.http.getJson`의 origin(`httpOrigin`)도 같은 검증 결과에서 읽습니다.
- **UI**: 문자열은 텍스트 입력, 숫자는 숫자 입력, 불리언은 체크박스, `select`는 선택 상자로 표시되며 필수 표시(`*`), 필드별 오류 문구(`aria-invalid`/`aria-describedby`)를 보여 줍니다. 값이 유효하지 않으면 **설정 저장**이 비활성화됩니다. 접힌 **고급: JSON 직접 편집**에서 JSON으로도 수정할 수 있으며 저장 시 같은 스키마로 검증합니다.

## 설정 저장과 서버 동기화

manifest의 `settingsScope: "local"`은 해당 확장 설정을 기기에만 저장하며 작업 서버에서 읽거나 쓰지 않습니다. 기본값은 `"server"`입니다. 인증 정보를 사용하는 확장은 로컬 scope를 권장합니다. 가져온 configuration은 공통 로컬 설정을 사용하며 작업 서버의 설정 미러링을 중단합니다.

기본 scope의 확장 설정은 연결한 pipaya 서버에 **인증된 요청**으로 저장되며, 서버 쪽 파일은 `<dataDir>/extensions/<id>/settings.json`입니다. 브라우저의 `localStorage`는 캐시/오프라인 대체용입니다.

| 요청 | 용도 |
|---|---|
| `GET /extensions/settings` → `{ settings: { [id]: object } }` | 시작 시 전체 설정 읽기 |
| `PUT /extensions/:id/settings` 본문 `{ settings }` → `{ settings }` | 설정 저장 |
| `DELETE /extensions/:id` → `{ ok: true }` | 확장 삭제 시 서버 설정 삭제 (실패해도 로컬 삭제는 진행) |

- **시작**: 설치된 패키지를 읽은 뒤, 활성 확장을 시작하기 *전에* `GET /extensions/settings`를 3초 제한으로 호출합니다. 서버에 값이 있는 ID는 **서버 값이 우선**이며 로컬 캐시도 갱신합니다.
- **서버에 연결할 수 없을 때**: 오류·시간 초과·잘못된 응답이면 로컬에 캐시된 설정으로 확장을 그대로 시작합니다(충돌·미처리 예외 없음). 설정 화면에는 비차단 안내가 표시됩니다.
- **저장**: 설정을 저장하면 로컬 상태를 즉시 갱신한 뒤 서버에 `PUT`합니다. 실패하면 `서버에 저장하지 못해 이 브라우저에만 저장됨`을 표시하고 다음 저장 때 다시 시도합니다.
- **이전(migration)**: 서버에 해당 ID의 값이 없는데 로컬에 비어 있지 않은 설정이 있으면 한 번 `PUT`해서 서버로 옮깁니다.
- **삭제**: 삭제 때 **설정값을 어떻게 할지 묻습니다**(`설정 유지하고 삭제` / `설정까지 삭제` / `취소`; 확인 영역으로 포커스가 이동하고 Esc로 취소). 두 경우 모두 패키지와 확장 전용 저장소(`pipaya.extension.storage.<id>`)는 지우고 확장은 중지합니다.
  - `설정까지 삭제`: `DELETE /extensions/:id`를 보냅니다(best effort). 로컬 보관 사본과 캐시도 지웁니다.
  - `설정 유지하고 삭제`: 서버에 `DELETE`를 보내지 않으며, 오프라인에서도 남도록 `localStorage`의 `pipaya.extensions.kept`(id → 설정 객체, 최대 50개)에 사본을 둡니다. 같은 ID를 다시 설치하면 서버 값 → 보관 사본 순으로 복원하고(`configured=true`) 보관 사본은 소비됩니다.
- 서버 연결이 없으면(연결 전) 네트워크 요청 없이 로컬에서만 동작합니다. 내보낸 패키지에는 설정이 포함되지 않습니다.

### 읽을 수 없는 저장 항목

이전 버전이 저장한 패키지가 현재 버전의 검증을 통과하지 못하면(예: 이후 제거된 권한) 조용히 버리지 않고 `unreadable` 목록에 **원본 그대로** 보관하며, 저장할 때 원래 요소를 그대로 다시 씁니다(나중 버전이 읽을 수 있도록). 설정 화면의 **설치된 확장**에 `읽을 수 없음` 카드로 표시되고(`이 버전에서 지원하지 않는 형식입니다: <사유>`), **원본 내보내기**(원본 JSON 다운로드)와 **삭제**(ID를 알면 같은 설정 유지/삭제 질문)를 제공합니다. 같은 ID의 패키지를 가져오면 이 항목을 대체하며 저장돼 있던 설정을 이어받습니다. 읽을 수 없는 항목도 최대 50개 한도에 포함됩니다. 목록 전체가 손상된 경우(`확장 설정을 읽지 못했습니다`)에는 원본 값을 덮어쓰기 전에 한 번 `pipaya.extensions.v1.corrupt`로 백업합니다.

### 테마

```json
{
  "manifest": { "id": "my.blue", "name": "Blue", "version": "1.0.0", "sdkVersion": 1, "permissions": [] },
  "theme": {
    "dark": { "--accent": "#60a5fa", "--accent-fg": "#101820", "--radius": "8px" },
    "light": { "--accent": "#2563eb", "--accent-fg": "#ffffff" }
  }
}
```

라이트/다크 전환에 맞춰 재적용합니다. 여러 테마 확장이 활성화되면 **설치 목록 순서상 뒤의 확장**이 동일 토큰을 덮습니다. 비활성화하면 남아 있는 테마 또는 기본값으로 돌아갑니다.

색은 hex(`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`)만, radius는 0–32 정수 px, content width는 480–1200 정수 px만 가능합니다. 임의 CSS, `url()`, 외부 폰트, 선택자, HTML은 받지 않습니다. 허용 토큰:

```
--bg --bg-side --bg-elev --bg-hover --bg-active --bg-code
--border --border-strong --text --text-dim --text-faint --user-bg
--accent --accent-hover --accent-fg --accent-soft --ok --warn --danger
--radius --radius-panel --radius-sm --content-w
```

### 언어팩

패키지에 선택 필드 `locales`를 넣으면 설정 → 일반 → **언어** 목록에 언어가 추가됩니다. `locales` 권한이 필요하고, 코드 없이 선언만으로 쓸 수 있습니다. 예제는 `examples/extensions/lang-ja.json`입니다.

```json
{
  "manifest": { "id": "lang.ja", "name": "日本語", "version": "1.0.0", "sdkVersion": 1, "permissions": ["locales"] },
  "locales": [
    { "tag": "ja", "name": "日本語", "messages": { "설정": "設定", "모델 {n}개": "{n}個のモデル" } }
  ]
}
```

- `tag`: 소문자 BCP 47 (`ja`, `pt-br`, `zh-hant-tw`). `ko`와 `en`은 앱에 내장돼 있어 쓸 수 없습니다.
- `name`: 그 언어로 쓴 이름. 언어 목록에 그대로 표시됩니다.
- `messages`: **한국어 원문 → 번역**. 키는 `src/lib/locales/en.ts`의 키와 같고, `{n}` 같은 자리표시자와 `{n#단수|복수}` 복수형 표기를 원문과 똑같이 둡니다. 같은 한국어가 문맥별로 다른 뜻이면 `"선택\u0004optional"`처럼 `\u0004`로 문맥을 붙인 항목이 우선합니다. 번역이 없는 문장은 영어, 영어에도 없으면 한국어 원문으로 나옵니다.
- 한도: 확장당 언어 5개, 언어당 문장 3000개, 키 1000자·번역 2000자, 이름 60자.
- 확장을 **활성화**하면 이 기기에서 바로 쓸 수 있고, 연결한 서버에 `PUT /locales/:tag`로 올려(`owner`는 확장 ID) 같은 서버에 연결한 다른 기기에도 나타납니다. 서버에 올리지 못해도(오프라인, 이전 버전 서버) 이 기기에서는 동작하고 로그에만 남습니다. 비활성화하면 이 기기의 언어가 사라지지만 서버 사본은 남습니다. **삭제**하면 서버에서도 자신이 올린 팩만 지웁니다.
- 선택한 언어의 팩이 사라지면(확장 비활성화 등) 시스템 언어로 보이고, 팩이 돌아오면 다시 그 언어가 됩니다.
- 같은 태그를 여러 곳이 제공하면 활성 확장의 팩이 서버 사본보다 먼저, 확장끼리는 설치 목록에서 뒤의 것이 먼저 쓰입니다.

서버 API: `GET /locales`(목록, `updatedAt`으로 변경 확인), `GET /locales/:tag`, `PUT /locales/:tag`, `DELETE /locales/:tag?owner=`, 이벤트 `locales_updated`. 자세한 내용은 [server/README.md](../../server/README.md)를 보세요. 클라이언트는 접속할 때와 `locales_updated`를 받을 때 바뀐 팩만 내려받아 `localStorage`(`pipaya.locales`)에 보관하므로, 서버에 연결하지 못해도 마지막으로 받은 언어를 씁니다.

## 권한과 SDK

SDK의 모든 메서드는 Promise입니다. 등록과 설정 변경을 `await`하고 시작 코드에서 오류를 전파하세요. 시작이 실패하면 등록된 항목 전체를 정리합니다.

| 권한 | 메서드 | 범위 |
| --- | --- | --- |
| `commands` | `sdk.commands.register(spec, handler)` | 앱 명령 목록에 추가, 확장당 최대 20개 |
| `composer` | `sdk.composer.setText(text)`, `registerAction(spec, handler)` | 초안 변경, 입력창 아래 버튼 최대 10개 |
| `ui` | `sdk.ui.registerPanel(spec, handler)`, `update(id, view, {tone}?)`, `open`, `close`, `remove` | 자신의 선언형 패널·폼·입력창 위젯. `update`에 `{tone: 'danger'}`를 주면 '확장 화면' 배지가 빨갛게 표시됩니다(다음 update에서 해제). [FE SDK 안내](extension-ui.md) |
| `status` | `sdk.status.set(id, text)`, `remove(id)` | 상태 표시줄 텍스트 최대 10개 |
| `navbar` | `sdk.navbar.set(id, {label, view})`, `remove(id)` | 헤더에 읽기 전용 항목 확장당 최대 3개 (게이지·아이콘·텍스트 등) |
| `http` | `sdk.http.getJson(path)` | 사용자 설정 `httpOrigin`으로 GET 요청을 보내 JSON만 읽기 (자격 증명 미전송) |
| `http-write` | `sdk.http.requestJson(request)` | 사용자 설정 origin에 JSON 읽기·쓰기, 자신의 `httpToken`만 선택적으로 Bearer 인증 |
| `configuration-background` | `sdk.configuration.authorize/revoke/access/read/applyBackground` | 최초 승인 후 비민감 설정 지속 읽기·일반 설정 자동 적용. 코드·설치·활성 상태 변경 차단 |
| `configuration` | `sdk.configuration.export()`, `apply(document)`, `restore()`, `status()` | 앱 승인형 설정 내보내기·가져오기. 네트워크/동기화 프로토콜과 독립 |
| `context` | `sdk.context.get()` | 현재 세션 ID·모델 ID·provider·실행/연결 상태만 |
| `events` | `sdk.events.on(handler)` | 허용된 세션/실행 이벤트의 메타데이터만 |
| `storage` | `sdk.storage.get(key)`, `set(key, value)` | 확장 ID별 JSON 저장소, 직렬화 문자열 최대 32K자 |
| `notifications` | `sdk.notifications.show(text)` | 앱 내 토스트, 최대 300자 |
| `locales` | (SDK 메서드 없음) | 패키지의 `locales`로 UI 언어팩을 제공. [언어팩](#언어팩) |
| `system-notifications` | `sdk.notifications.send(spec)`, `status()`, `register(id, rule)`, `remove(id)` | OS·모바일 푸시, 기기 간 포커스 억제, 서버 이벤트 규칙. [알림 설정·플랫폼 지원](notifications.md) |
| `server` | `sdk.server.call(extension, method, params?, sessionId?)`, `entries({sessionId?, extension?, type?})`, `list()`, `on(handler)` | 서버 확장의 메서드 호출, 확장이 대화에 저장한 기록 읽기, 확장이 보낸 이벤트 받기. 호출 15초 제한 |
| `shortcuts` | `sdk.shortcuts.register({id, label, combo}, handler)`, `remove(id)` | 확장당 최대 10개. `combo`는 `Mod`(Ctrl/⌘) 또는 `Alt`에 키 하나(예: `Mod+Shift+K`). 앱의 단축키가 항상 우선하고, 다른 확장이 쓰는 조합은 등록할 수 없음 |
| `dialogs` | `sdk.dialog.confirm/select/input(spec)` | 모달 질문. 창에 확장 이름이 표시되고, 취소하면 `confirm`은 `false`, 나머지는 `null`. 한 번에 하나씩 순서대로 표시 |
| `session` | `sdk.session.send(text, mode?)`, `abort()` | 열려 있는 대화에 메시지 전송·실행 중지. 10초에 5번. 보낸 메시지는 에이전트가 실행하므로 승인 문구에 명시 |
| `tools` | `sdk.tools.registerRenderer(toolName, render)`, `removeRenderer(toolName)` | 끝난 도구 호출을 확장이 만든 화면으로 표시(읽기 전용 노드 80개·깊이 5·24KiB). 실패하거나 `null`이면 기본 모양. 같은 도구는 마지막 등록이 이김. 확장당 20개 |
| `messages` | `sdk.messages.registerRenderer(entryType, render)`, `removeRenderer(entryType)` | 서버 확장이 `ctx.appendEntry(type, data)`로 대화에 남긴 기록을, 만들어진 시각 순서로 대화 중간에 카드로 표시. 렌더러가 없거나 `null`이면 보이지 않음. 읽기 전용 노드(navbar와 같은 종류) 80개·깊이 5·24KiB. 확장당 20개 |
| `slots` | `sdk.slots.set('header'\|'footer', id, {label, view})`, `remove(slot, id)` | 헤더 아래·입력창 위의 읽기 전용 영역. navbar와 같은 노드·한도, 확장당 2개 |
| `composer-filter` | `sdk.composerFilter.set(fn)`, `clear()` | 보내기 직전 텍스트를 바꾸거나 막음(`string`, `{text}`, `{cancel: '사유'}`, `null`=그대로). 2초 제한, 오류·시간 초과면 원문 그대로 전송. 슬래시 명령은 거치지 않음 |
| 별도 권한 없음 | `sdk.settings.get()`, `sdk.log(text)` | 자신의 사용자 설정 읽기, 확장 로그 |

```js
const settings = await sdk.settings.get();

await sdk.commands.register(
  { name: 'review', description: '리뷰 초안 추가', args: '[대상]' },
  async (arg) => {
    await sdk.composer.setText(`${settings.prefix || '변경사항을 리뷰해 주세요.'}\n${arg}`);
  }
);

await sdk.composer.registerAction(
  { id: 'review-button', label: '리뷰 초안' },
  async () => { await sdk.composer.setText('현재 변경사항을 리뷰해 주세요.'); }
);

await sdk.status.set('mode', '리뷰 도우미');
const unsubscribe = await sdk.events.on(async event => {
  if (event.type === 'run_finished') {
    await sdk.status.set('mode', `작업 ${event.status || '완료'}`);
  }
});
```

`commands.register`의 spec은 `{name, description, args?}`입니다. handler에 문자열 인자가 전달됩니다. `composer.registerAction`의 spec은 `{id, label}`이며 handler는 인자 없이 호출됩니다. 명령 실행은 메시지를 전송하지 않습니다. 초안은 기존 입력을 **교체**하며 첨부 이미지를 읽거나 변경하지 않습니다.

`context.get()` 결과:

```ts
{ sessionId: string | null, model: string, provider: string,
  running: boolean, online: boolean }
```

이벤트는 `{type, sessionId?, at, status?, toolName?, isError?}` 형태입니다. 허용 목록은 `run_started`, `run_finished`, `session_created`, `session_updated`, `session_deleted`, `compaction_finished`, `approval_requested`, `approval_resolved`, `turn_end`, `tool_execution_end`. `at`은 밀리초 타임스탬프, `status`는 `run_finished`에만, `toolName`과 `isError`는 `tool_execution_end`에만 전달됩니다(도구 인자와 결과 내용은 전달하지 않습니다). 재연결 중 기존 이벤트를 다시 받을 수 있으므로 정확히 한 번 실행되는 보장으로 쓰지 마세요. 해제 함수는 Worker 내부 listener를 제거하며, 전체 비활성화는 Worker와 호스트 구독도 제거합니다.

설정 화면에서 확장별 JSON 객체를 편집합니다. 활성화된 확장에는 다시 불러오기로 반영합니다. 저장소의 없는 키는 `null`입니다. `__proto__`, `constructor`, `prototype` 키는 쓸 수 없습니다. 확장 삭제 시 자신의 저장소도 삭제됩니다. console 출력은 SDK 로그로 연결되며 로그는 클라이언트 실행 중 최신 100개만 유지합니다.

### Navbar

```ts
await sdk.navbar.set('usage', {
  label: '사용 현황',
  view: {
    type: 'stack', id: 'root', direction: 'horizontal', children: [
      { type: 'gauge', id: 'main', label: '사용률', rings: [{ value: 42 }], display: '42%', size: 'small' }
    ]
  }
});
await sdk.navbar.remove('usage');
```

`navbar.set(id, {label, view})`: ID는 소문자·숫자·하이픈 최대 40자(패널 ID와 같은 규칙), `label`은 최대 40자이며 항목의 접근 가능한 이름입니다. 확장당 최대 3개이고 같은 ID는 교체합니다. 호스트는 항목 내용을 알지 못하며, 검증된 `view`를 신뢰된 렌더러로 표시하기만 합니다.

`view`는 패널과 같은 [UI 노드](extension-ui.md) 검증을 거치지만 **비대화형 노드만** 허용합니다: `stack`, `grid`, `text`, `badge`, `divider`, `progress`, `stat`, `gauge`, `icon`. 버튼·폼·입력·탭·표·목록·코드·알림·카드는 명확한 오류로 거부합니다. 제한: 노드 60개, 깊이 4, 직렬화 32KiB. 항목은 비활성화·다시 불러오기·실패·안전 모드·삭제 시 패널과 같은 경로로 사라집니다. 헤더는 항목을 가로로 나열하되 슬롯 폭을 `min(40%, 160px)`(좁은 화면 `min(36%, 132px)`)로 제한해 제목이 항상 우선하며, `min-width: 0`과 가로 스크롤로 320px 화면에서도 넘치지 않습니다. 작은 게이지는 26px(좁은 화면 22px)이고 키보드 포커스(`:focus-visible`)에서만 얇은 링을 표시합니다.

### `gauge`와 `icon` 노드 (패널·navbar 공통)

```ts
const icon = { viewBox: '0 0 24 24', paths: [{ d: 'M12 2 L22 22 H2 Z', fill: 'currentColor', fillRule: 'evenodd' }] };
{ type: 'icon', id: 'logo', icon, size: 'medium', label: '로고' }
{ type: 'gauge', id: 'g', label: '사용률', hint: '5시간 창', stale: false, size: 'small', display: '42%', icon,
  rings: [{ value: 42, color: 'accent' }, { value: null, max: 200, color: '#10a37f', label: '보조' }] }
```

**IconSpec** `{viewBox, paths}`: `viewBox`는 `'minx miny w h'` 형태의 유한한 숫자 4개이며 w·h는 1–512입니다. `paths`는 1–8개이며 각 `{d, fill?, fillRule?}`의 `d`는 8192자 이하이고 SVG path 문자(`MmLlHhVvCcSsQqTtAaZz`, 숫자, `eE+-.,` 및 공백)만 허용합니다. `fill`은 `#rrggbb` 또는 `currentColor`(기본), `fillRule`은 `nonzero|evenodd`입니다. 호스트는 이 값만으로 `<svg aria-hidden>`을 직접 구성하며 원시 SVG/HTML/URL/그라디언트/CSS는 받지 않습니다.

`icon` 노드: `{type, id, icon, size?: small|medium|large, label?}`. `label`이 있으면 접근 가능한 이름, 없으면 `aria-hidden`입니다.

`gauge` 노드: `{type, id, label, rings, display?, icon?, hint?, stale?, size?, details?}`.
- `rings`: 1–3개, 바깥쪽부터 동심원. 각 링은 `{value: number|null, max?: >0 (기본 100), color?: '#rrggbb'|'accent'|'ok'|'warn'|'danger', label?}`. `value`는 0–`max`이거나 `null`(알 수 없음)입니다. `null`은 호가 없이 점선 트랙과 `—`로 표시하며 **0으로 취급하지 않습니다**.
- `display`는 16자 이하의 보조 텍스트, `icon`은 가장 안쪽 링 중앙에 표시, `hint`는 500자 이하로 기본 tooltip과 접근성 설명이 됩니다. `stale`이면 흐리게 표시하고 배지·"오래된 데이터" 설명을 추가합니다. `size`는 `small`(약 32px, 320px에서 4개 가능) 또는 `medium`입니다.
- `details?: {title?, rows}`: 마우스 hover·키보드 포커스·터치 탭 시 표시되는 상세 팝오버(`role="tooltip"`, `position: fixed`로 navbar의 overflow에 잘리지 않으며 뷰포트 안으로 보정, 공간이 없으면 위로 전환, Escape·스크롤·리사이즈 시 닫힘, 한 번에 하나만 표시). `title`은 40자 이하, `rows`는 1–12개이며 각 행은 `{label (≤48자), value: number|null, max?: >0 (기본 100), color? (링과 같은 규칙), caption? (≤80자, 예: 리셋 시각), group? (≤40자)}`입니다. 같은 `group`이 연속되면 하나의 소제목 아래 묶입니다. `value`가 `null`이면 채움 없이 점선 트랙과 `확인 불가`로 표시하며 **0으로 취급하지 않습니다**. 알려진 값은 `value/max`의 백분율을 오른쪽에 표시합니다. 행도 노드 수·바이트 제한에 포함되고 알 수 없는 필드는 거부합니다. `details.updatedAt?`(epoch 밀리초 정수)를 주면 팝오버 하단에 `N초 전 업데이트됨`(60초 미만 초, 이후 분·시간·일)을 표시하며 팝오버가 열려 있는 동안 1초마다 갱신됩니다. 이 경우 `stale`이어도 "오래된 데이터" 줄 대신 이 문구가 경고색으로 표시되고, `updatedAt`이 없을 때만 기존 "오래된 데이터" 줄을 씁니다. `details`가 있으면 네이티브 `title`을 설정하지 않고(이중 tooltip 방지) `aria-description`에 hint와 행 요약을 담으며, `stale`이면(`updatedAt`이 없을 때) 팝오버에 "오래된 데이터" 줄을 추가합니다. `details`가 없으면 기존 동작(네이티브 `title`)을 유지합니다.
- 각 링은 `role="progressbar"`이며 값이 알려진 경우에만 `aria-valuenow`를 갖습니다. 이름은 `ring.label`, 없으면 gauge `label`입니다.

### HTTP JSON 읽기

```ts
// 사용자 설정: {"httpOrigin":"http://localhost:8317"}
const data = await sdk.http.getJson('/some/path?x=1'); // 인자는 정확히 1개
```

기본 origin은 없으며 설정 `httpOrigin`(스키마가 있으면 검증된 값)이 없으면 `설정에 httpOrigin이 필요합니다` 오류입니다. `httpOrigin`은 순수 http(s) origin(경로는 `/`만, 자격 증명·query·fragment 금지)이어야 합니다. `path`는 단일 `/`로 시작해야 하며 `//`, 백슬래시, 제어문자·공백, `..`/`.` 세그먼트, fragment, 스킴은 거부합니다. query는 허용합니다.

GET만 사용하며 `credentials: 'omit'`, `redirect: 'error'`, `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`, `Accept: application/json`입니다. Authorization·Cookie·pipaya 토큰은 전달하지 않습니다. 3.5초 timeout(SDK 5초 이내), 스트리밍 본문 최대 2MiB, JSON 파싱 오류는 안전한 메시지로 반환하고 오류에 요청 URL을 포함하지 않습니다. 결과는 깊이 32 이하의 일반 JSON으로 깊은 복사합니다. CORS는 대상 서버에서 허용해야 합니다. 서버 측 프록시는 없습니다.

확장별로 같은 `path`의 진행 중 요청은 하나로 병합하고, 이전 시작 후 2초 이내 같은 경로를 다시 요청하면 `너무 자주` 오류를 반환합니다(캐시 없음, 서로 다른 경로는 독립, 동시에 최대 4개). 비활성화·다시 불러오기·안전 모드에서 요청을 취소하며 이전 generation의 응답은 새 인스턴스로 전달되지 않습니다. 공개 타입(`NavbarItemSpec`, `IconSpec`, `UIGaugeNode` 등)은 `src/lib/extensions/sdk.ts`에서 재노출합니다.

### 범용 설정 내보내기·가져오기

`configuration` 권한은 `{schemaVersion:1, servers:[{name,baseUrl}], extensions:[{package,enabled,settings}], preferences:{theme?,sound?,volume?}}`를 다룹니다. 서버 토큰, 대화, 확장 전용 저장소 및 호출 확장 자체는 제외합니다. 설정 스키마에 선언된 비민감 값만 전달하고 `secret` 및 키 이름으로 식별되는 자격 증명은 제외합니다. 패키지 코드에 직접 넣은 비밀값은 제거할 수 없습니다.

`export()`, `apply(document)`, `restore()`는 즉시 `{id}`를 반환하고 앱이 확장 이름을 표시한 승인창을 엽니다. `status()`는 마지막 작업의 `{id,state,document?,error?}` 또는 `null`을 반환합니다. `state`는 `pending|done|cancelled|error`. 내보낸 document는 승인 후에만 반환합니다. 승인 대기 중 긴 SDK 호출을 유지하지 말고 별도 버튼/짧은 polling으로 결과를 읽으세요. 비활성화하면 미완료 승인은 무효화됩니다.

가져오기는 4MiB 한도와 패키지 형식을 검증하고 로컬 백업을 만든 뒤 서버 주소를 병합합니다. 기존 토큰은 유지하고 대상 확장은 비활성·설정 미확인으로 복원합니다. `restore()`도 승인이 필요하며 복원 코드를 자동 실행하지 않습니다. 백업은 앱 로컬 저장소에만 있습니다.

### 지속 설정 접근 (자동화 확장)

`configuration-background`를 별도로 요청해야 합니다. `authorize()`는 승인 작업 ID를 반환하며 `configuration.status()`로 완료를 확인합니다. 승인은 해당 확장의 **전체 패키지와 자신의 설정의 SHA-256**에 묶여 저장됩니다. 코드·manifest·설정·서버 주소·토큰 변경 시 재승인, 삭제 또는 `revoke()` 시 해제됩니다. 앱 승인 대기 중 비활성화/설정 변경은 유효 승인을 만들지 않습니다.

- `access()` → `{authorized:boolean}`.
- `read()` → `{document,fingerprint}`. 승인 없으면 거부. fingerprint는 서버 URL/확장 ID 순서를 정규화한 SHA-256입니다.
- `applyBackground(document, expectedFingerprint)` → `{document,fingerprint}`. 현재 로컬 fingerprint와 다르면 충돌로 거부합니다. 동일 패키지·동일 활성 상태의 확장 설정과 앱 설정/서버 목록만 적용합니다. 새 확장·코드·활성 상태 변경은 거부하며 수동 `apply()` 승인을 사용해야 합니다.
- 자동 적용은 서버 목록을 **교체**하며 삭제도 반영하고, 기존 URL의 ID·토큰은 보존합니다. 작업 중 서버가 삭제되면 연결을 닫습니다. 비민감 확장 설정은 교체하되 비밀값은 유지합니다. 승인된 기존 활성 확장은 설정 변경 때만 다시 시작합니다. 로컬 백업/실패 복원을 사용합니다.

네트워크·변경 감지·주기·충돌 정책은 확장이 관리합니다. 본체는 동기화 서버/프로토콜/타이머를 구현하지 않습니다. 앱이 열려 있고 확장 Worker가 실행 중일 때만 동작합니다.

### 범용 JSON HTTP 쓰기

```js
const response = await sdk.http.requestJson({
  path: '/resource', method: 'PUT', body: { data: 1 },
  headers: { 'If-Match': '"3"' }
});
// { status: number, body: JSON | null }; 비-2xx도 status로 반환
```

명시적인 `http-write` 권한이 필요합니다. 목적지는 사용자 설정 `httpOrigin`, 선택 인증은 자신의 `httpToken`뿐입니다. 요청마다 origin 또는 Authorization을 지정할 수 없고 추가 헤더는 `If-Match`만 허용합니다. `GET|PUT|POST|DELETE`, 4MiB 요청/응답, 깊이 32, 3.5초 timeout, 확장당 동시 요청 하나. Cookie/앱 서버 자격 증명은 전달하지 않고 redirect를 거부합니다. CORS 허용은 대상 서버의 책임입니다. 서버 경로·리비전·충돌 처리·동기화 UI는 확장이 구현하며 본체는 프로토콜을 알지 못합니다.

## 실행 격리와 제한

- 임의 JS는 앱 메인 윈도우가 아닌 **opaque-origin sandbox iframe 내부 Worker**에서 실행합니다. iframe에는 `allow-scripts`만 있고 `allow-same-origin`은 없습니다.
- 전용 `MessagePort`를 통해 고정된 SDK 메서드만 호출합니다. 각 호출의 권한을 **호스트에서** 확인합니다. Worker가 SDK를 우회해 메시지를 만들어도 추가 권한을 얻지 못합니다.
- sandbox CSP는 기본 차단, 스크립트/Worker 생성만 허용합니다. blob Worker는 생성 문서 CSP를 상속합니다. Worker의 직접 네트워크·외부 스크립트·이미지·하위 iframe·폼 전송은 차단합니다. 명시적 `http` 권한의 호스트 대행 GET은 위 제한 내에서만 허용합니다.
- 서버 토큰, API 키, 앱 localStorage, DOM, Tauri invoke API, 대화 원문, 도구 인자·결과를 전달하지 않습니다. 파일/셸 및 임의 origin·헤더 API는 제공하지 않습니다. HTTP는 명시적인 `http`/`http-write` 권한과 위 제한을 따릅니다.
- 시작 전에 네트워크·외부 스크립트 차단 canary를 확인하며 CSP가 적용되지 않는 WebView에서는 코드를 실행하지 않습니다. 시작 5초, 명령 실행 10초, SDK 응답 5초 제한. 실행 중 4초마다 heartbeat를 보내고 5초 내 응답이 없으면 중지합니다. 초과 시 실행을 중단하고 등록 항목을 제거합니다. 초당 메시지 200개, 대기 SDK 요청 100개, 동시 명령 20개 제한.
- 확장 알림에는 이름이 표시되며 10초에 5개로 제한합니다. 모든 실행 로그도 확장 ID에 귀속됩니다.
- JS 오류·권한 오류는 로그/명령 오류로 표시됩니다. 시작/Worker/시간 제한 오류는 확장 전체를 비활성화합니다.

**브라우저 샌드박스는 운영체제 프로세스 격리나 메모리/CPU 할당량 보장이 아닙니다.** 악의적인 대용량 메모리 할당, 브라우저/WebView 취약점까지 방어한다고 주장하지 않습니다. 검토하지 않은 확장은 실행하지 마세요. Tauri 플랫폼별 Worker/CSP 동작은 실제 배포 WebView에서 확인해야 합니다. 지원하지 않는 환경에서는 활성화 오류로 종료되며 앱 realm에서 실행하는 대체 경로는 없습니다.

호스트 전체 CSP는 별도 보안 과제입니다. 이 기능은 기존 Tauri 전역 CSP 설정을 완화하지 않습니다. 시스템 알림을 위해 신뢰된 앱 호스트에는 Tauri `notification` 및 `pipaya-push` 권한이 있지만, 확장 Worker에는 Tauri API나 OS 권한을 직접 전달하지 않습니다. 임의 코드를 앱에서 `import()`하는 방식도 쓰지 않습니다.

## 문제 복구

설정 → 확장 → **안전 모드**로 모든 확장을 중지합니다(사용자가 직접 켠 경우에만 모든 확장이 꺼집니다). 확장을 시작하는 동안에는 그 확장의 ID만 `localStorage`의 `pipaya.extensions.booting`(JSON 배열)에 기록하고 시작이 끝나면(성공이든 실패든) 지웁니다. 시작 도중 페이지가 새로고침되면(HMR 포함) 다음 시작에서 **그 기록에 남은 확장만** `시작이 완료되지 않아 비활성화했습니다` 오류와 함께 비활성화하고, 나머지는 정상적으로 시작하며 전역 안전 모드로 전환하지 않습니다. 부팅 자체가 어려우면 웹 URL에 `?extensions=off`를 추가하세요. 데스크톱에서는 앱 WebView의 개발자 도구/사이트 데이터 복구 기능으로 `localStorage.setItem('pipaya.extensions.safe', '1')`을 설정한 뒤 다시 실행할 수 있습니다. 안전 모드 해제 후 필요한 확장만 명시적으로 활성화하세요.

오류 표시, 확장 로그, 비활성화/삭제를 먼저 사용합니다. 패키지에 자격 증명을 넣지 마세요. 내보낸 JSON은 코드와 manifest를 그대로 포함합니다.

## 검증

```sh
bun run check
bun test tests
bun run build
```

실제 브라우저 격리/관리/입력창/heartbeat 검증은 개발 서버 실행 후 `scripts/check-extensions.cjs`를 사용합니다. Playwright는 선택적 QA 의존성이며 앱 의존성을 추가하지 않습니다.

```sh
npm install --prefix /tmp/pipaya-browser-qa playwright
/tmp/pipaya-browser-qa/node_modules/.bin/playwright install chromium
NODE_PATH=/tmp/pipaya-browser-qa/node_modules node scripts/check-extensions.cjs
```

기본 접속 주소는 `http://localhost:1420`입니다. 다른 환경에서는 `EXTENSION_TEST_URL`로 바꿉니다. 이 스크립트는 테스트 브라우저의 새 프로필에만 패키지를 설치하고 개발 서버 모듈을 사용합니다. Tauri WebView의 네이티브 QA를 대신하지 않습니다.

## 첫 버전의 범위

선언형 UI 패널·폼·표·탭·입력창 위젯을 지원합니다. [FE SDK와 UI 워크벤치 예제](extension-ui.md)를 참고하세요.

현재 지원하지 않는 것: 확장 마켓/원격 자동 다운로드·자동 업데이트, 서명/발행자 검증, npm 패키지, 임의 HTML/프레임워크 컴포넌트·CSS, 키보드 단축키 등록, 파일/셸/임의 네트워크 API, 서버 동작 변경, 대화 원문 접근. 이들을 추가할 때 기존 권한으로 묵시적으로 열지 말고 SDK/manifest의 명시적 새 권한과 승인을 추가해야 합니다.
