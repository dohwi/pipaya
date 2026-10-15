# SDK 레퍼런스 (v1)

모든 메서드는 Promise를 반환합니다. 등록과 설정 변경은 `await` 하세요.

## 패키지 구조

```json
{
  "manifest": {
    "id": "my.ext", "name": "이름", "version": "1.0.0", "sdkVersion": 1,
    "description": "선택",
    "permissions": [],
    "settings": [],
    "settingsScope": "server"
  },
  "commands": [],
  "theme": {},
  "locales": [],
  "code": "..."
}
```

- 패키지 최대 256 KiB, 코드 최대 128 KiB (UTF-8), 확장 최대 50개
- `settingsScope: "local"`이면 설정을 이 기기에만 저장하고 서버에서 읽거나 쓰지 않습니다. 기본은 `"server"`

## 권한과 메서드

| 권한 | 메서드 | 범위 |
|---|---|---|
| `commands` | `sdk.commands.register(spec, handler)` | 명령 목록에 추가, 확장당 20개 |
| `composer` | `sdk.composer.setText(text)`, `registerAction(spec, handler)` | 초안 변경, 입력창 아래 버튼 10개 |
| `ui` | `sdk.ui.registerPanel / update / open / close / remove` | 자신의 선언형 패널·폼·입력창 위젯 |
| `status` | `sdk.status.set(id, text)`, `remove(id)` | 상태 줄 텍스트 10개 |
| `navbar` | `sdk.navbar.set(id, {label, view})`, `remove(id)` | 헤더 읽기 전용 항목 3개 |
| `http` | `sdk.http.getJson(path)` | 설정 `httpOrigin`으로 GET, JSON만 |
| `http-write` | `sdk.http.requestJson(request)` | 설정 origin에 JSON 읽기·쓰기 |
| `context` | `sdk.context.get()` | 세션 ID·모델·provider·실행/연결 상태만 |
| `events` | `sdk.events.on(handler)` | 세션·실행 이벤트의 메타데이터만 |
| `storage` | `sdk.storage.get(key)`, `set(key, value)` | 확장별 JSON 저장소, 직렬화 32K자 |
| `notifications` | `sdk.notifications.show(text)` | 앱 안 토스트, 300자, 10초에 5개 |
| `system-notifications` | `sdk.notifications.send / status / register / remove` | OS·모바일 푸시, 서버 규칙 |
| `locales` | (메서드 없음) | 패키지 `locales`로 언어팩 제공 |
| `configuration` | `sdk.configuration.export / apply / restore / status` | 승인형 설정 내보내기·가져오기 |
| `configuration-background` | `authorize / revoke / access / read / applyBackground` | 최초 승인 뒤 비민감 설정 자동 적용 |
| (없음) | `sdk.settings.get()`, `sdk.log(text)` | 자기 설정 읽기, 로그 |

### commands / composer

```js
await sdk.commands.register(
  { name: 'review', description: '리뷰 초안 추가', args: '[대상]' },
  async (arg) => { await sdk.composer.setText('변경사항을 리뷰해 주세요.\n' + arg); }
);
await sdk.composer.registerAction(
  { id: 'review-button', label: '리뷰 초안' },
  async () => { await sdk.composer.setText('현재 변경사항을 리뷰해 주세요.'); }
);
```

초안은 기존 입력을 **교체**하고, 첨부 이미지는 읽지도 바꾸지도 않습니다. 명령 실행이 메시지를 전송하지는 않습니다.

### context / events

```ts
sdk.context.get() // { sessionId: string|null, model, provider, running: boolean, online: boolean }
```

이벤트는 `{ type, sessionId?, at, status? }`입니다. 허용 목록은 `run_started` `run_finished` `session_created` `session_updated` `session_deleted` `compaction_finished` `approval_requested` `approval_resolved`입니다. `status`는 `run_finished`에만 담깁니다. 재연결 중 같은 이벤트를 다시 받을 수 있으니 **정확히 한 번 실행되는 것으로 가정하지 마세요.**

```js
const off = await sdk.events.on(async (e) => {
  if (e.type === 'run_finished') await sdk.status.set('mode', `작업 ${e.status || '완료'}`);
});
```

### storage

없는 키는 `null`입니다. `__proto__` `constructor` `prototype` 키는 쓸 수 없고, 확장을 삭제하면 저장소도 함께 지워집니다.

### http

```js
// 사용자 설정: {"httpOrigin":"http://localhost:8317"}
const data = await sdk.http.getJson('/some/path?x=1');
```

- 목적지는 **사용자가 설정한 `httpOrigin` 하나뿐**입니다. 경로가 `//`, 백슬래시, `..`, fragment, 스킴을 포함하면 거부합니다.
- GET 전용, 쿠키·Authorization·harness 토큰을 보내지 않고, 리다이렉트는 오류, 3.5초 타임아웃, 응답 2 MiB 제한입니다.
- 같은 경로의 진행 중 요청은 하나로 합치고, 같은 경로를 2초 안에 다시 요청하면 `너무 자주` 오류입니다. 동시에 최대 4개.
- 대상 서버가 **CORS를 허용**해야 합니다. 서버 쪽 프록시는 없습니다.

`http-write`의 `sdk.http.requestJson({ path, method, body, headers })`는 `GET|PUT|POST|DELETE`, 요청·응답 4 MiB, 깊이 32, 확장당 동시 1개입니다. 추가 헤더는 `If-Match`만 허용하고 자신의 `httpToken` 설정이 있으면 Bearer로 붙입니다. 비-2xx도 `{ status, body }`로 돌려줍니다.

## 설정 스키마 (`manifest.settings`)

최대 20개를 선언하면 설정 화면이 폼과 검증을 자동으로 만듭니다.

```json
"settings": [
  { "key": "httpOrigin", "type": "string", "label": "서버 주소", "format": "origin", "required": true, "placeholder": "http://localhost:8317" },
  { "key": "interval", "type": "number", "label": "갱신 간격(초)", "min": 10, "max": 600, "default": 60 },
  { "key": "compact", "type": "boolean", "label": "간단히 표시", "default": false },
  { "key": "mode", "type": "select", "label": "표시 방식", "default": "ring",
    "options": [{ "value": "ring", "label": "원형" }, { "value": "text", "label": "텍스트" }] }
]
```

| 필드 | 설명 |
|---|---|
| `key` | `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`, 확장 안에서 고유 |
| `type` | `string` `number` `boolean` `select` |
| `label` | 필수, 60자 이하 |
| `description` / `placeholder` | 선택, 200자 / 80자 이하 |
| `default` | 선택. `type`과 일치해야 하고 `select`는 옵션 중 하나, `number`는 `min`/`max` 범위 안 |
| `required` | `true`면 비어 있을 때 오류 |
| `secret` | 문자열 전용. 비밀번호 입력으로 표시하고 설정 내보내기에서 제외. 기본값 금지 |
| `format` | 문자열 전용, `"origin"`: 경로·query·자격 증명이 없는 http(s) origin |
| `min` / `max` | 숫자 전용 |
| `options` | select 전용, `{value, label}` 2–20개 |

검증은 **엄격**합니다. `"5"`를 숫자로, `"true"`를 불리언으로 바꾸지 않고 오류로 보고합니다. 선언하지 않은 키는 버립니다. `sdk.settings.get()`은 스키마가 있으면 기본값이 채워진 검증 결과를, 없으면 저장된 객체 그대로를 돌려줍니다.

## 설정 저장과 동기화

기본 scope의 설정은 서버의 `<dataDir>/extensions/<id>/settings.json`에 저장됩니다. `localStorage`는 캐시이자 오프라인 대비입니다.

- **시작**: 활성 확장을 시작하기 전에 `GET /extensions/settings`를 3초 제한으로 읽습니다. 서버 값이 있으면 **서버가 우선**입니다.
- **서버에 못 닿으면** 로컬 캐시로 그대로 시작합니다. 오류로 멈추지 않습니다.
- **저장**: 로컬을 먼저 갱신하고 서버에 `PUT`합니다. 실패하면 "이 브라우저에만 저장됨"을 표시하고 다음 저장 때 다시 시도합니다.
- **삭제**: 설정을 남길지 물어봅니다. 남기면 같은 ID를 다시 설치할 때 복원됩니다.

## 알림 (`system-notifications`)

서버 이벤트에 반응하는 **규칙**을 등록하면 앱이 꺼져 있어도 서버가 알림을 보냅니다. 규칙은 `run_finished` 또는 `approval_requested`의 기본 알림을 대체하며 owner당 5개까지입니다. 확장을 비활성화·삭제하거나 안전 모드에 들어가면 회수됩니다. 직접 보내는 `send`는 source당 10초에 5개로 제한됩니다. 플랫폼 지원과 정책은 [알림](notifications.md)에 있습니다.

## 설정 내보내기·가져오기 (`configuration`)

`{ schemaVersion: 1, servers, extensions, preferences }` 문서를 다룹니다. 서버 토큰, 대화, 확장 저장소, 호출한 확장 자신은 포함하지 않습니다. `secret` 필드와 자격 증명처럼 보이는 키 이름도 제외하지만, **패키지 코드 안에 직접 넣은 비밀은 제거할 수 없습니다.**

`export()`, `apply(document)`, `restore()`는 즉시 `{id}`를 돌려주고 앱이 **확장 이름이 적힌 승인창**을 띄웁니다. 결과는 `status()`로 확인하세요. 상태는 `pending | done | cancelled | error`입니다. 가져오기는 4 MiB 한도로 검증하고 로컬 백업을 만든 뒤 서버 주소를 병합하며, 대상 확장은 **비활성·설정 미확인** 상태로 복원합니다.

`configuration-background`는 별도 권한으로, 한 번 승인하면 비민감 설정 읽기와 일반 설정 자동 적용을 허용합니다. 승인은 확장의 전체 패키지와 설정의 SHA-256에 묶여서, 코드·manifest·설정·서버 주소·토큰이 바뀌면 다시 승인해야 합니다. 새 확장이나 코드, 활성 상태 변경은 자동 적용으로 할 수 없습니다.

## 테마 토큰

```text
--bg --bg-side --bg-elev --bg-hover --bg-active --bg-code
--border --border-strong --text --text-dim --text-faint --user-bg
--accent --accent-hover --accent-fg --accent-soft --ok --warn --danger
--radius --radius-panel --radius-sm --content-w
```

테마 확장이 여럿이면 설치 목록에서 **뒤에 있는 확장**이 같은 토큰을 덮어씁니다.

## 언어팩 상세

- `tag`: 소문자 BCP 47 (`ja`, `pt-br`). `ko`, `en`은 내장이라 쓸 수 없습니다.
- `messages`: 한국어 원문 → 번역. `{n}` 같은 자리표시자와 `{n#단수|복수}` 복수형을 원문과 똑같이 둡니다. 문맥별 번역은 `"선택\u0004optional"`처럼 `\u0004` 뒤에 문맥을 붙입니다.
- 번역이 없으면 영어, 영어에도 없으면 한국어 원문입니다.
- 한도: 확장당 5개 언어, 언어당 3,000문장, 키 1,000자, 번역 2,000자, 이름 60자.
- 활성화하면 서버(`PUT /locales/:tag`)에도 올라가 같은 서버에 연결한 다른 기기에도 나타납니다. 서버 한도는 팩 20개입니다.
