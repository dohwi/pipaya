# 확장 Frontend SDK

> 관련 문서: [구조와 변경 가이드](extension-architecture.md) · [화면 디자인 규격](extension-screen-design.md)(컴포넌트별 사용 기준·화면 레시피)

클라이언트 Extension에 **자체 화면을 구성하는 선언형 UI**를 추가할 수 있습니다. 확장이 JSON view tree를 전달하면 앱이 Svelte 컴포넌트로 렌더링합니다. 확장 코드는 기존 격리 Worker에서 상태와 동작을 담당합니다.

이 API는 SDK v1의 추가 기능이며 manifest에 **`ui` 권한**을 요청해야 합니다. 기존 v1 패키지는 그대로 동작합니다. UI를 지원하지 않는 구버전 클라이언트는 알 수 없는 권한으로 설치를 거부합니다.

## 제공하는 화면

- **별도 패널**: 화면의 `확장 화면` 버튼에서 여는 모달 워크스페이스. 확장 이름과 패널 출처를 앱이 표시합니다.
- **입력창 위젯**: `placement: 'composer'`로 등록하면 입력창 영역에서 접고 펼칠 수 있는 UI가 됩니다. 서버가 없는 초기 화면에는 입력창이 없으므로 위젯도 표시되지 않습니다.
- 여러 패널을 등록해도 앱 명령이나 다른 확장의 화면을 대체할 수 없습니다.

확장당 최대 5개, 패널마다 최대 200 nodes / 깊이 8 / UTF-8 view 60KiB. 모든 node에는 고유한 `id`가 필요합니다. ID는 소문자로 시작하고 소문자·숫자·하이픈으로 최대 40자입니다. 탭 ID도 tree 전체에서 고유해야 합니다.

## 작성 흐름

```js
let count = 0;
function view() {
  return {
    type: 'stack', id: 'root', gap: 'medium', children: [
      { type: 'stat', id: 'count', label: '클릭 수', value: String(count) },
      { type: 'button', id: 'increment', label: '추가', variant: 'primary' }
    ]
  };
}

await sdk.ui.registerPanel({
  id: 'counter', title: '카운터', description: '첫 UI 확장', view: view()
}, async event => {
  if (event.type === 'action' && event.id === 'increment') {
    count++;
    await sdk.ui.update('counter', view());
  }
});

// 화면은 사용자 버튼으로 열 수도 있고 확장에서 열 수도 있습니다.
await sdk.ui.open('counter');
```

등록 spec: `{id, title, description?, placement?: 'panel' | 'composer', view}`. 기본 placement는 별도 패널입니다. 등록에는 이벤트 handler가 필요합니다. 시작 중 `open`은 활성화까지 기다리며, 이미 다른 확장 화면이 열려 있다면 그 화면과 편집 내용을 빼앗지 않습니다. `update(id, view, options?)`는 view 전체를 교체합니다. patch/임의 DOM 변경은 제공하지 않습니다. `options.tone: 'danger'`를 주면 상단 **확장 화면** 배지가 빨갛게 바뀌고(개수 대신 `!`, 툴팁에 확장 이름), 클릭하면 해당 패널이 열립니다. 패널 탭도 빨갛게 표시됩니다. 다음 `update`에서 tone을 생략하면 해제됩니다. 하단 상태줄(`status`) 대신 오류를 눈에 띄게 알릴 때 사용하세요. `close(id)`는 별도 패널을 닫으며 등록은 유지합니다. `remove(id)`는 자신의 패널과 handler를 해제합니다. 다른 확장의 ID에는 접근할 수 없습니다.

## UI 컴포넌트

정확한 타입과 검증 구현은 `src/lib/extensions/ui.ts`, 공개 SDK는 `src/lib/extensions/sdk.ts`를 참고하세요. 공통 필수 필드는 `type`과 `id`입니다.

| 컴포넌트 | 주요 속성 | 용도 |
| --- | --- | --- |
| `stack` | `children`, `direction?`, `gap?` | 수직/수평 레이아웃. 수평은 작은 화면에서 줄바꿈 |
| `grid` | `children`, `columns?: 1/2/3` | 반응형 1~3열 |
| `card` | `children`, `title?`, `description?` | 제목과 설명이 있는 그룹 |
| `tabs` | `items: {id,label,children}[]` | 키보드 탐색 가능한 탭 |
| `form` | `children`, `submitLabel`, `disabled?` | 검증 후 폼 값 일괄 전달. 중첩 form 금지 |
| `text` | `text`, `size?: small/body/heading`, `tone?` | 일반 텍스트·제목 |
| `badge` | `text`, `tone?` | 상태 라벨 |
| `alert` | `text`, `title?`, `tone?` | 안내·성공·오류 상태 |
| `stat` | `label`, `value`, `hint?` | 통계 카드 |
| `progress` | `label`, `value`, `max?` | 진행 상태. 기본 max 100 |
| `code` | `text`, `language?` | 이스케이프된 코드 표시. 구문 강조/실행 아님 |
| `divider` | — | 구분선 |
| `icon` | `icon: {viewBox, paths}`, `size?`, `label?` | 데이터 기반 벡터 아이콘. [상세](extensions.md#gauge와-icon-노드-패널navbar-공통) |
| `gauge` | `label`, `rings` (1–3, `value: number\|null`), `display?`, `icon?`, `hint?`, `stale?`, `size?`, `details?` | 동심원 원형 게이지. `null`은 알 수 없음이며 0이 아님. `details`는 hover/포커스/탭 시 상세 팝오버 |
| `table` | `columns: {id,label}[]`, `rows: {id,cells:string[]}[]`, `caption?` | 의미 있는 HTML 표. 가로 스크롤 |
| `list` | `items: {id,title,description?,badge?}[]`, `emptyText?` | 목록과 빈 상태 |
| `button` | `label`, `variant?: primary/secondary/danger`, `disabled?` | action 이벤트 |
| `input` | `label`, `value?`, `inputType?: text/email/number`, `placeholder?` | 단일 행 입력 |
| `textarea` | `label`, `value?`, `placeholder?`, `rows?` | 여러 행 입력 |
| `select` | `label`, `value?`, `options: {value,label}[]` | 허용 옵션 선택 |
| `checkbox` | `label`, `checked?` | boolean 선택 |

입력 컴포넌트에는 `required?`, `disabled?`, `error?`가 있습니다. input/textarea에는 `minLength?`, `maxLength?`도 있습니다. `error`는 Worker가 검증한 오류를 표시할 때 씁니다. `tone`은 `neutral/info/success/warning/danger`만, gap은 `small/medium/large`만 가능합니다. 임의 CSS 속성을 넣을 수 없습니다.

## 폼과 이벤트

```js
await sdk.ui.registerPanel({
  id: 'request', title: '요청 작성', view: {
    type: 'form', id: 'request-form', submitLabel: '초안 넣기', children: [
      { type: 'input', id: 'goal', label: '작업 목표', required: true, minLength: 3, maxLength: 300 },
      { type: 'select', id: 'mode', label: '방식', value: 'review', options: [
        { value: 'review', label: '리뷰' }, { value: 'plan', label: '계획' }
      ]},
      { type: 'checkbox', id: 'tests', label: '테스트 포함', checked: true }
    ]
  }
}, async event => {
  if (event.type === 'submit') {
    const { goal, mode, tests } = event.values;
    await sdk.composer.setText(`${goal}\n${mode}\n테스트: ${tests}`);
  }
});
```

이벤트는 세 종류입니다.

```ts
{ type: 'action', id: string }
{ type: 'change', id: string, value: string | boolean }
{ type: 'submit', id: string, values: Record<string, string | boolean> }
```

- `change`는 입력 확정 시 전달합니다. 텍스트 매 keystroke를 Worker에 전송하지 않습니다. select/checkbox는 변경 즉시 전달합니다.
- 폼의 값은 로컬 draft로 관리하며 `submit`이 전체 값을 전달합니다. 비활성 필드는 제외합니다. 탭을 전환해도 같은 패널의 draft를 유지합니다.
- 로컬 및 호스트에서 현재 view를 기준으로 event target, 타입, 옵션, 길이, required/email/number를 검증합니다. 임의 ID나 추가 필드를 보내지 않습니다.
- 같은 ID·타입·기본값의 view 업데이트는 편집 중 값을 보존합니다. 확장이 기본값을 바꾸면 해당 field를 새 값으로 동기화합니다. 변경된 default가 기존 default와 같으면 리셋 신호가 되지 않습니다. 패널의 로컬 draft는 활성 surface에서만 유지되며, 탭 내부 UI의 개별 오류·포커스 같은 DOM 상태는 재렌더링 시 초기화될 수 있습니다. 강제 초기화가 필요하면 새 field ID 또는 remove/register를 사용하세요.
- action/submit 처리 중 해당 surface의 입력과 버튼을 비활성화하고 오류를 화면에 표시합니다. change는 제출 클릭을 방해하지 않도록 입력을 잠그지 않고 순서대로 처리하며 대기 이벤트는 최대 20개입니다. 실패해도 입력을 보존하여 재시도할 수 있습니다.
- 화면을 닫으면 surface 로컬 draft가 사라질 수 있습니다. 장기 보존은 확장 상태/`storage`로 직접 구현하세요.
- 비활성화·재설치·안전 모드·삭제 시 UI와 handler를 정리합니다. 이전 surface의 callback은 재등록한 동일 ID의 패널을 실행할 수 없습니다.

## 다양하고 꼼꼼한 FE를 위한 규칙

1. **상태를 모두 설계**: 초기 안내, 로딩 progress, 빈 list/table, 성공 alert, 실패 error, 비활성 버튼을 표현하세요.
2. **상태는 Worker, 표현은 view**: 순수한 `view(state)` 함수를 두고 이벤트에서 상태를 변경한 뒤 `ui.update`하세요. 입력 change마다 view 전체를 갱신하지 않아도 됩니다.
3. **안정적인 ID**: 일반 업데이트에서 node ID를 유지하면 입력·탭·포커스를 유지하기 쉽습니다. ID는 구조와 의미 기준으로 붙이세요.
4. **접근성**: 앱이 실제 label, native controls, 표 의미 구조, 탭 키보드 탐색, 오류 live region, 모달 focus trap을 제공합니다. 충분한 설명과 명확한 버튼 문구는 확장 작성자가 제공해야 합니다.
5. **반응형**: grid/stack은 작은 화면을 고려합니다. 긴 코드와 표는 내부 스크롤, 일반 텍스트는 줄바꿈합니다. 대형 table을 여러 중첩 card 안에 넣지 마세요.
6. **권한 최소화**: UI만 있으면 `ui`, 초안 작성에는 별도로 `composer`, 저장에는 `storage`가 필요합니다. 폼 입력은 민감정보로 다루고 로그에 무작정 출력하지 마세요.
7. **HTML 문자열 대신 컴포넌트**: raw HTML, 스크립트, 외부 이미지·iframe·URL, 이벤트 속성, 앱 DOM 접근, 사용자 지정 CSS는 허용하지 않습니다. 확장 UI가 앱의 권한 승인창처럼 위장하지 않도록 앱이 출처를 표시합니다.

## 예제와 개발 도구

`examples/extensions/ui-workbench.js`는 읽기 쉬운 작성 소스입니다. manifest와 소스를 패키징해 관리 화면에 가져옵니다.

```sh
node scripts/build-extension.cjs \
  examples/extensions/ui-workbench.manifest.json \
  examples/extensions/ui-workbench.js \
  examples/extensions/ui-workbench.json
```

소스는 ES module이 아니라 `sdk` 변수가 주입되는 async 함수 본문입니다. 패키징은 문법/파일 크기만 확인하고 코드를 실행하지 않습니다. manifest·view·권한 검증은 클라이언트가 수행합니다. TypeScript 사용 시 `ExtensionSDK`, `UIPanelSpec`, `UINode`, `UIEvent`를 type-only로 가져와 개발 도구의 타입 검사를 붙이고, 최종 결과는 외부 import 없는 JS 함수 본문으로 만드세요.

실제 Chromium UI 검증은 개발 서버 실행 후 `NODE_PATH=/tmp/pipaya-browser-qa/node_modules node scripts/check-extension-ui.cjs`로 실행합니다. Playwright 설치법은 [기본 확장 문서](extensions.md)의 검증 항목을 참고하세요.

실행 예제는 폼·탭·통계·목록·표·코드·badge·alert와 composer 위젯을 함께 보여줍니다. `/workbench` 명령으로 열 수 있고 초안은 자동 전송하지 않습니다.

## 남아 있는 범위

임의 Svelte/React 컴포넌트, 자체 CSS, 웹 콘텐츠 iframe, 차트 캔버스, 파일·드래그 앤 드롭, 원격 데이터 요청은 이번 API에 없습니다. 필요한 새로운 컴포넌트는 typed schema·validator·renderer·접근성·보안 테스트를 함께 추가하는 방식으로 확장해야 합니다. 브라우저/WebView의 자원 격리 한계는 [기본 확장 문서](extensions.md)의 실행 격리 항목과 동일합니다.
