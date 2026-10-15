# 첫 확장 만들기

예제를 세 단계로 키워 갑니다. 모든 확장은 **JSON 파일 하나**입니다.

1. 코드 없이 명령 하나 (선언형)
2. 코드로 입력창 버튼과 상태 칩
3. 설정 폼과 패널 UI

## 1단계: 선언형 명령

`my.review.json`

```json
{
  "manifest": {
    "id": "my.review",
    "name": "나의 리뷰 도우미",
    "version": "1.0.0",
    "sdkVersion": 1,
    "description": "리뷰 초안을 입력창에 넣습니다",
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

설정 → **확장**에서 가져오고 활성화한 뒤 입력창에 `/review 보안 위주로`를 입력해 보세요. 입력창 초안이 템플릿으로 **교체**됩니다. 명령은 메시지를 자동 전송하지 않습니다. 보낼지는 사용자가 정합니다.

규칙:

- `id`: 소문자로 시작, `.`/`-`로 구분 (`sync`, `my.review`, `team-session-tools`), 최대 80자
- `sdkVersion`: 정확히 `1`
- 명령 이름: 영문 소문자로 시작, 소문자·숫자·하이픈, 최대 40자
- 선언형 명령에도 `commands`와 `composer` 권한이 모두 필요합니다
- 모르는 필드, 중복 권한·명령, 잘못된 타입은 **설치가 거부**됩니다
- 앱 기본 명령이나 다른 확장과 이름이 겹치면 활성화에 실패합니다

## 2단계: 코드 추가

`code`는 **async 함수 본문**입니다. `import`와 npm은 쓸 수 없고, `sdk` 변수가 주입됩니다.

```json
{
  "manifest": {
    "id": "my.helper",
    "name": "나의 도우미",
    "version": "1.0.0",
    "sdkVersion": 1,
    "permissions": ["commands", "composer", "status", "events"]
  },
  "code": "await sdk.commands.register({ name: 'plan', description: '계획 초안', args: '[목표]' }, async (arg) => { await sdk.composer.setText('다음 목표의 계획을 단계별로 세워 주세요: ' + arg); });\nawait sdk.composer.registerAction({ id: 'tests', label: '테스트 요청' }, async () => { await sdk.composer.setText('방금 변경에 대한 테스트를 작성해 주세요.'); });\nawait sdk.status.set('mode', '도우미 켜짐');\nawait sdk.events.on(async (event) => { if (event.type === 'run_finished') { await sdk.status.set('mode', '마지막 작업: ' + (event.status || '완료')); } });"
}
```

읽기 쉬운 소스는 따로 두고 JSON으로 패키징하는 편이 편합니다. 저장소에는 빌드 스크립트가 있습니다.

```bash
cd client
node scripts/build-extension.cjs  my.manifest.json  my.code.js  my.json
```

패키징은 문법과 파일 크기만 확인합니다. manifest·view·권한 검증은 클라이언트가 가져올 때 수행합니다.

> [!TIP]
> 시작에 실패하면 등록된 항목이 전부 정리되고 확장이 꺼집니다. 그래서 `await`로 등록을 기다리고 오류를 밖으로 던지는 것이 맞습니다. 로그는 `sdk.log()`나 `console`로 남기고, 클라이언트 실행 중 최신 100개만 보관됩니다.

## 3단계: 설정과 패널

사용자가 값을 바꿀 수 있게 `manifest.settings`를 선언하면 설정 화면이 폼을 만들고 검증해 줍니다.

```js
// 코드 본문. 설정 값을 읽어 패널을 그립니다.
const settings = await sdk.settings.get();   // 기본값이 채워진 검증 결과
let count = 0;

const view = () => ({
  type: 'stack', id: 'root', gap: 'medium', children: [
    { type: 'text', id: 'hello', text: settings.greeting, size: 'heading' },
    { type: 'stat', id: 'count', label: '클릭 수', value: String(count) },
    { type: 'button', id: 'inc', label: '추가', variant: 'primary' }
  ]
});

await sdk.ui.registerPanel(
  { id: 'counter', title: '카운터', description: '첫 UI 확장', view: view() },
  async (event) => {
    if (event.type === 'action' && event.id === 'inc') {
      count++;
      await sdk.ui.update('counter', view());
    }
  }
);
```

manifest에는 다음을 추가합니다.

```json
"permissions": ["ui"],
"settings": [
  { "key": "greeting", "type": "string", "label": "인사말", "default": "안녕하세요", "required": true }
]
```

패널은 우상단 **확장 화면** 런처에서 열거나 코드에서 `sdk.ui.open('counter')`로 엽니다.

- 설정 스키마가 있는 새 패키지는 **설정을 한 번 저장해야** 활성화됩니다. 기본값이 채워져 있으니 저장만 누르면 됩니다.
- 패널 안에서 상태는 Worker가 갖고, 화면은 `view()` 함수로 만들어 `ui.update`로 갱신하는 패턴이 가장 단순합니다.
- 모든 노드에는 고유한 `id`가 필요합니다. 갱신 사이에 id를 유지하면 입력값과 포커스가 유지됩니다.

## 테마와 언어팩은 코드가 필요 없습니다

```json
{
  "manifest": { "id": "my.blue", "name": "Blue", "version": "1.0.0", "sdkVersion": 1, "permissions": [] },
  "theme": {
    "dark":  { "--accent": "#60a5fa", "--accent-fg": "#101820", "--radius": "8px" },
    "light": { "--accent": "#2563eb", "--accent-fg": "#ffffff" }
  }
}
```

색은 hex만, `--radius`는 0–32 정수 px, `--content-w`는 480–1200 px입니다. 임의 CSS, `url()`, 외부 폰트, 선택자는 받지 않습니다.

언어팩은 `locales` 권한과 `locales` 배열로 만듭니다. 메시지의 키는 **한국어 원문**이고 값이 번역입니다.

```json
{
  "manifest": { "id": "lang.ja", "name": "日本語", "version": "1.0.0", "sdkVersion": 1, "permissions": ["locales"] },
  "locales": [{ "tag": "ja", "name": "日本語", "messages": { "설정": "設定" } }]
}
```

## 예제 모음

저장소 `client/examples/extensions/`에 실제 동작하는 예제가 있습니다.

| 파일 | 내용 |
|---|---|
| `focus.json` | 선언형: 테마 + `/review` 명령 |
| `session-tools.json` | 코드 예제 |
| `lang-ja.json` | 일본어 언어팩 |
| `ui-workbench.json` | 모든 UI 노드를 보여 주는 워크벤치 (`/workbench` 명령) |

## 체크리스트

- 필요한 권한만 요청했나? (UI만 쓰면 `ui`, 초안 작성에는 `composer`가 **별도로** 필요, 저장에는 `storage`)
- 비밀값을 패키지에 넣지 않았나? 내보낸 JSON은 코드와 manifest를 그대로 담습니다. 설정 필드에는 `secret: true`를 쓰세요.
- 로딩·빈 상태·오류·비활성 버튼 상태를 모두 설계했나?
- 인증 정보를 쓰는 확장은 `settingsScope: "local"`로 설정을 기기에만 두는 것을 권장합니다.
